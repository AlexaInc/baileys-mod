// Full WA-protocol consent test: proper allocate + 1Hz ping via the DC, watch ICE.
'use strict'
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const crypto = require('crypto')
const cm = require('./lib/Utils/call-media.js')
const creds = JSON.parse(fs.readFileSync('/home/user/baileys-mod/turn-creds.json', 'utf8'))
const wa = JSON.parse(fs.readFileSync('/tmp/wa-ice.json', 'utf8'))
const MODE = process.argv[2] || 'ping'   // ping | alloc
const token = Buffer.from(wa.ufrag, 'base64')          // tokens[0] bytes
const key = Buffer.from(wa.pwd, 'utf8')                 // relay key ASCII
const STREAM_SSRCS = [3253165375, 3204736085, 3324216216, 125548965, 2795375765, 737830172, 574582254, 3820173311, 3645216287]
const RELAY_FP = 'sha-256 9A:E1:D6:FA:49:EC:4E:50:7C:86:10:9E:5F:D8:53:6D:11:2D:8E:06:43:72:31:1D:6C:84:B8:C1:69:02:E6:63'
const CANDS = [["57.144.5.50", 3480], ["157.240.22.52", 3480], ["57.144.217.50", 3480],
     
    
]
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const pc = new wrtc.RTCPeerConnection({
    iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: creds.username, credential: creds.credential }],
    iceTransportPolicy: 'all',
})
const dc = pc.createDataChannel('pre-negotiated', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0, priority: 'high' })
dc.binaryType = 'arraybuffer'
let lastIce = ''
pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState !== lastIce) { lastIce = pc.iceConnectionState; console.log(at(), 'ICE:', lastIce) } }
let nominated = null
async function pollStats() {
    try {
        const stats = await pc.getStats()
        const reports = typeof stats.values === 'function' ? Array.from(stats.values()) : Object.values(stats)
        for (const p of reports.filter(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')) {
            const remote = reports.find(r => r.id === p.remoteCandidateId)
            if (remote) {
                const tag = `${remote.ip || remote.address}:${remote.port}`
                const line = `PAIR ${tag} resp=${p.responsesReceived} consent=${p.consentRequestsSent || '?'}`
                if (line !== p._last) { console.log(at(), line); p._last = line }
                if (!nominated) { nominated = tag; onNominated(tag) }
            }
        }
    } catch {}
}
function onNominated(tag) {
    console.log(at(), '*** nominated:', tag, '— mode', MODE)
    if (MODE === 'alloc') {
        const [ip, port] = tag.split(':')
        const xor = cm.encodeXorRelayEndpoint(ip, parseInt(port, 10))
        const alloc = cm.buildWasmAllocateRequest(crypto.randomBytes(12), token, xor, STREAM_SSRCS, key, {})
        console.log(at(), 'sending full allocate len=' + alloc.length, alloc.toString('hex').slice(0, 80))
        dc.send(alloc)
    }
    // 1Hz WA ping (and re-allocate in alloc mode — matches meowcaller keepalive)
    setInterval(() => {
        try {
            dc.send(cm.buildWhatsappPing())
            if (MODE === 'alloc') {
                const [ip, port] = tag.split(':')
                const xor = cm.encodeXorRelayEndpoint(ip, parseInt(port, 10))
                dc.send(cm.buildWasmAllocateRequest(crypto.randomBytes(12), token, xor, STREAM_SSRCS, key, {}))
            }
        } catch (e) { console.log(at(), 'send err', e.message) }
    }, 1000)
}
dc.onmessage = (e) => {
    const b = Buffer.from(e.data)
    const mt = b.readUInt16BE(0)
    if (mt === 0x0103) { console.log(at(), 'DC IN ALLOCATE SUCCESS len=' + b.length); return }
    if (mt === 0x0113) {
        const attrs = []
        // crude attr walk
        let p = 20; const len = b.readUInt16BE(2)
        while (p + 4 <= 20 + len) { const t = b.readUInt16BE(p), l = b.readUInt16BE(p + 2); attrs.push([t, b.subarray(p + 4, p + 4 + l)]); p += 4 + l + ((4 - l % 4) % 4) }
        const reason = attrs.find(([t]) => t === 0x0009)?.[1]?.subarray(4)?.toString('utf8')
        console.log(at(), 'DC IN ALLOCATE ERROR:', reason); return
    }
    if (mt === 0x0802 || mt === 0x0101) { console.log(at(), 'DC IN pong/binding-success'); return }
    console.log(at(), 'DC IN len=' + b.length, 'type=0x' + mt.toString(16))
}
;(async () => {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    let answer = offer.sdp
        .replace(/a=setup:actpass/g, 'a=setup:passive')
        .replace(/a=ice-ufrag:[^\r\n]+/g, 'a=ice-ufrag:' + wa.ufrag)
        .replace(/a=ice-pwd:[^\r\n]+/g, 'a=ice-pwd:' + wa.pwd)
        .replace(/a=fingerprint:[^\r\n]+/g, 'a=fingerprint:' + RELAY_FP)
        .replace(/a=ice-options:[^\r\n]+\r?\n/g, '')
        .replace(/a=max-message-size:[^\r\n]+/g, 'a=max-message-size:1200')
        .replace(/a=candidate:[^\r\n]+\r?\n/g, '')
        .replace(/a=end-of-candidates\r?\n?/g, '')
    answer = answer + CANDS.map(([ip, port], i) => `a=candidate:${i + 2} 1 udp 2122262783 ${ip} ${port} typ host generation 0 network-cost 5`).join('\r\n') + '\r\na=end-of-candidates\r\n'
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    console.log(at(), 'remote set; mode=' + MODE)
})().catch(e => console.log('sdp err', e.message))
setInterval(pollStats, 3000)
setTimeout(() => { console.log(at(), `=== 75s done: ICE=${pc.iceConnectionState} ===`); process.exit(0) }, 75000)
