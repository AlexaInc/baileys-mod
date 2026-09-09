// Probe: can wrtc complete DTLS+SCTP to a real WhatsApp media relay using the
// synthetic-answer recipe (no signaling)? If DC opens, the transport layer is
// proven before we burn live-call attempts.
'use strict'
const { RTCPeerConnection } = require('@roamhq/wrtc')
const crypto = require('crypto')

const RELAY_DTLS_FINGERPRINT = 'F9:CA:0C:98:A3:CC:71:D6:42:CE:5A:E2:53:D2:15:20:D3:1B:BA:D8:57:A4:F0:AF:BE:0B:FB:F3:6B:0C:A0:68'

async function tryRelay(ip, port, label) {
    return new Promise((resolve) => {
        const pc = new RTCPeerConnection()
        const dc = pc.createDataChannel('pre-negotiated', {
            negotiated: true, id: 0, ordered: false, maxRetransmits: 0, priority: 'high',
        })
        dc.binaryType = 'arraybuffer'
        let answerForLog = null
        const done = (ok, why) => {
            try { pc.close() } catch { }
            console.log(`${ok ? '✅' : '❌'} ${label}: ${why}`)
            resolve(ok)
        }
        const timer = setTimeout(() => done(false, 'timeout (DTLS did not complete in 12s)'), 12000)
        dc.onopen = () => { clearTimeout(timer); done(true, 'DataChannel OPEN — DTLS+SCTP established') }
        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'failed') { clearTimeout(timer); done(false, 'ICE failed') }
        }
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') { clearTimeout(timer); done(false, 'connection failed') }
        }
        ; (async () => {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            const iceUfrag = crypto.randomBytes(9).toString('base64').replace(/=+$/, '')
            const icePwd = crypto.randomBytes(18).toString('base64').replace(/=+$/, '')
            let answer = offer.sdp
                .replace(/a=setup:actpass/g, 'a=setup:passive')
                .replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${iceUfrag}`)
                .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${icePwd}`)
                .replace(/a=fingerprint:[^\r\n]+/g, `a=fingerprint:sha-256 ${RELAY_DTLS_FINGERPRINT}`)
                .replace(/a=ice-options:[^\r\n]+\r?\n/g, '')
                .replace(/a=max-message-size:[^\r\n]+/g, 'a=max-message-size:1200')
                .replace(/a=candidate:[^\r\n]+\r?\n/g, '')
                .replace(/a=end-of-candidates\r?\n?/g, '')
            answer += `a=candidate:2 1 udp 2122262783 ${ip} ${port} typ host generation 0 network-cost 5\r\na=end-of-candidates\r\n`
            answerForLog = answer
            await pc.setRemoteDescription({ type: 'answer', sdp: answer })
            console.log(`… ${label}: remote answer set (${ip}:${port}), waiting for DTLS`)
        })().catch((e) => { clearTimeout(timer); console.log('SDP was:', JSON.stringify((answerForLog||'').split('\r\n'))); done(false, 'error: ' + e.message) })
    })
}

;(async () => {
    const targets = [
        ['157.240.226.133', 3478, 'relay 226.133 (from meowcaller KAT)'],
        ['157.240.24.133', 3478, 'relay 24.133 (baileys-caller default)'],
    ]
    let any = false
    for (const [ip, port, label] of targets) {
        any = (await tryRelay(ip, port, label)) || any
    }
    console.log(any ? '\nTRANSPORT PATH VALIDATED — synthetic SDP + wrtc reaches WhatsApp relays' : '\nno relay accepted the handshake (may need valid allocate context from live signaling)')
    process.exit(0)
})()
