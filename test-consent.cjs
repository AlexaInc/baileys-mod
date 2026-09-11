// Isolated replica of call-media's _openRelayChannel: PC + DC via CF TURN ->
// WA relays :3480. Watch which candidate wins + whether ICE consent survives.
'use strict'
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const crypto = require('crypto')
const creds = JSON.parse(fs.readFileSync('/home/user/baileys-mod/turn-creds.json', 'utf8'))
const wa = JSON.parse(fs.readFileSync('/tmp/wa-ice.json', 'utf8'))
const MODE = process.argv[2] || 'bare'   // bare | ping | alloc
const RELAY_FP = process.argv[3] || 'sha-256 9A:E1:D6:FA:49:EC:4E:50:7C:86:10:9E:5F:D8:53:6D:11:2D:8E:06:43:72:31:1D:6C:84:B8:C1:69:02:E6:63'
const CANDS = [
    ['57.144.203.54', 3480], ['57.144.221.54', 3480], ['57.144.217.54', 3480],
    ['157.240.24.133', 3478],
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
pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState !== lastIce) { lastIce = pc.iceConnectionState; console.log(at(), 'ICE:', lastIce) }
}
dc.onopen = () => {
    console.log(at(), 'DC OPEN')
    if (MODE === 'ping') {
        setInterval(() => {
            const p = Buffer.alloc(20)
            p.writeUInt16BE(0x0801, 0); p.writeUInt32BE(0x2112a442, 4); crypto.randomBytes(12).copy(p, 8)
            dc.send(p)
        }, 1000)
    }
    if (MODE === 'alloc') {
        // allocate-shaped: 0x0003 with USERNAME/REALM/NONCE + token attr? just
        // send the WA ping + a minimal allocate with XOR addr of the target
        setInterval(() => {
            const p = Buffer.alloc(20)
            p.writeUInt16BE(0x0801, 0); p.writeUInt32BE(0x2112a442, 4); crypto.randomBytes(12).copy(p, 8)
            dc.send(p)
        }, 1000)
    }
}
dc.onmessage = (e) => {
    const b = Buffer.from(e.data)
    console.log(at(), 'DC IN len=' + b.length, 'type=0x' + b.readUInt16BE(0).toString(16))
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
    const cands = CANDS.map(([ip, port], i) => `a=candidate:${i + 2} 1 udp 2122262783 ${ip} ${port} typ host generation 0 network-cost 5`)
    answer = answer + cands.join('\r\n') + '\r\na=end-of-candidates\r\n'
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    console.log(at(), 'remote set; mode=' + MODE)
})().catch(e => console.log('sdp err', e.message))

setInterval(async () => {
    try {
        const stats = await pc.getStats()
        const reports = typeof stats.values === 'function' ? Array.from(stats.values()) : Object.values(stats)
        const pairs = reports.filter(r => r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated))
        for (const p of pairs) {
            const local = reports.find(r => r.id === p.localCandidateId)
            const remote = reports.find(r => r.id === p.remoteCandidateId)
            if (remote) console.log(at(), `PAIR ${remote.ip || remote.address}:${remote.port} state=${p.state} req=${p.requestsSent} resp=${p.responsesReceived} consent=${p.consentRequestsSent || '?'}`)
        }
    } catch {}
}, 5000)
setTimeout(() => { console.log(at(), `=== 60s done: ICE=${pc.iceConnectionState} ===`); process.exit(0) }, 60000)
