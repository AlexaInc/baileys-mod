// Try ufrag variants against a WA relay :3480 via CF TURN — which one makes ICE answer?
'use strict'
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const creds = JSON.parse(fs.readFileSync('/home/user/baileys-mod/turn-creds.json', 'utf8'))
const V = JSON.parse(fs.readFileSync('/tmp/wa-variants.json', 'utf8'))
const VARIANT = process.argv[2] || 'full193'
const RELAY_IP = process.argv[3] || '57.144.5.50'
const RELAY_PORT = parseInt(process.argv[4] || '3480', 10)
const UFRAG = V.variants[VARIANT] || VARIANT
const PWD = V.pwd
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
dc.onopen = () => console.log(at(), 'DC OPEN')
;(async () => {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    let answer = offer.sdp
        .replace(/a=setup:actpass/g, 'a=setup:passive')
        .replace(/a=ice-ufrag:[^\r\n]+/g, 'a=ice-ufrag:' + UFRAG)
        .replace(/a=ice-pwd:[^\r\n]+/g, 'a=ice-pwd:' + PWD)
        .replace(/a=fingerprint:[^\r\n]+/g, 'a=fingerprint:sha-256 9A:E1:D6:FA:49:EC:4E:50:7C:86:10:9E:5F:D8:53:6D:11:2D:8E:06:43:72:31:1D:6C:84:B8:C1:69:02:E6:63')
        .replace(/a=ice-options:[^\r\n]+\r?\n/g, '')
        .replace(/a=max-message-size:[^\r\n]+/g, 'a=max-message-size:1200')
        .replace(/a=candidate:[^\r\n]+\r?\n/g, '')
        .replace(/a=end-of-candidates\r?\n?/g, '')
    answer += `a=candidate:1 1 udp 2122262783 ${RELAY_IP} ${RELAY_PORT} typ host generation 0 network-cost 5\r\na=end-of-candidates\r\n`
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    console.log(at(), `variant=${VARIANT} ufragLen=${UFRAG.length} target=${RELAY_IP}:${RELAY_PORT}`)
})().catch(e => console.log('sdp err', e.message))
setTimeout(async () => {
    try {
        const stats = await pc.getStats()
        const reports = typeof stats.values === 'function' ? Array.from(stats.values()) : Object.values(stats)
        const pairs = reports.filter(r => r.type === 'candidate-pair')
        const best = pairs.map(p => `${p.state}/s${p.requestsSent}/r${p.responsesReceived}`).join(' ')
        console.log(at(), `=== 20s: ICE=${pc.iceConnectionState} pairs: ${best}`)
    } catch { console.log(at(), '=== 20s: ICE=' + pc.iceConnectionState) }
    process.exit(pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' ? 0 : 1)
}, 20000)
