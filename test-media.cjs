// Media pipeline test: RTP protect → unprotect round-trip, group forwarding,
// demuxer with real ffmpeg silence, allocate bytes.
'use strict'
const { spawn } = require('child_process')
const cm = require('/home/user/baileys-mod/lib/Utils/call-media.js')

let pass = 0, fail = 0
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`) }
const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {} }

const callKey = Buffer.alloc(32, 7)
const callId = 'DEADBEEFCAFE0011223344556677ABCD'
const aliceLid = '111111111111111:0@lid'
const bobLid = '222222222222222:0@lid'

// fake relay block (shape produced by parseRelayBlock)
const relay = {
    key: Buffer.from('relaymikey1234567', 'utf8'),
    tokens: [Buffer.from('tok0tok0tok0tok0'), Buffer.from('tok1tok1tok1tok1')],
    endpoints: [
        { relayId: 5, relayName: 'waweb5', tokenId: 1, authTokenId: 2, isFna: false, ip: '157.240.1.100', port: 3478, raw6: Buffer.alloc(6) },
        { relayId: 5, relayName: 'waweb5', tokenId: 0, authTokenId: 0, isFna: true, ip: '157.240.1.101', port: 3478, raw6: Buffer.alloc(6) },
    ],
    peerJid: bobLid,
}

async function main() {
    // ── session construction ──
    const alice = new cm.WACallMediaSession({ callId, callKey, relay, selfLid: aliceLid, peerLid: bobLid, logger })
    check('alice audio ssrc = slot0', alice.ssrc === cm.deriveParticipantSsrc(callId, aliceLid, 0))
    check('stream ssrcs: 9 slots', alice.streamSsrcs.length === 9)
    check('stream slots 0-5 deterministic, 6-8 randomized',
        alice.streamSsrcs[0] === cm.deriveParticipantSsrc(callId, aliceLid, 0)
        && alice.streamSsrcs[1] === cm.deriveParticipantSsrc(callId, aliceLid, 1)
        && alice.streamSsrcs[6] !== cm.deriveParticipantSsrc(callId, aliceLid, cm.RELAY_STREAM_SLOT_WORDS[6]))
    const uniques = new Set(alice.streamSsrcs)
    check('stream ssrcs unique', uniques.size === 9, alice.streamSsrcs)

    // ── protect → unprotect round trip (alice sends, bob receives) ──
    const bob = new cm.WACallMediaSession({ callId, callKey, relay, selfLid: bobLid, peerLid: aliceLid, logger })
    const speechFrame = Buffer.alloc(35, 0xd4) // 35B = speech-ish (not DTX)
    const pkt1 = alice.protectAudio(speechFrame)
    const pkt2 = alice.protectAudio(speechFrame)
    check('protected packet sizes (35B speech → 16+35+4)', pkt1.length === 16 + 35 + 4 && pkt2.length === 16 + 35 + 4, [pkt1.length, pkt2.length])
    check('seq advances (1,2)', pkt1.readUInt16BE(2) === 1 && pkt2.readUInt16BE(2) === 2)
    check('ts advances 960', pkt2.readUInt32BE(4) === 960)
    check('marker latches on first speech', (pkt1[1] & 0x80) !== 0 && (pkt2[1] & 0x80) === 0)
    check('PT 120', (pkt1[1] & 0x7f) === 120)
    check('ssrc in packet', pkt1.readUInt32BE(8) === alice.ssrc)

    const r1 = bob.unprotectRtp(pkt1)
    check('bob verifies WARP tag + decrypts pkt1', !!r1 && r1.payload.equals(speechFrame), r1 && r1.payload?.toString('hex'))
    check('bob identified sender as alice', r1.participantId === cm.formatParticipantId(aliceLid), r1.participantId)
    const r2 = bob.unprotectRtp(pkt2)
    check('bob decrypts pkt2 (ROC tracking)', !!r2 && r2.payload.equals(speechFrame))

    // DTX frame → 20-byte header
    const dtxFrame = Buffer.from([0x10])
    const pktDtx = alice.protectAudio(dtxFrame)
    check('DTX packet is 20B header (12+4ext+4extword... = 20+1+4)', pktDtx.length === 20 + 1 + 4, pktDtx.length)
    check('DTX ext word 0x30010000', pktDtx.readUInt32BE(16) === 0x30010000)
    const rd = bob.unprotectRtp(pktDtx)
    check('bob decrypts DTX packet', !!rd && rd.payload.equals(dtxFrame))

    // seq wrap → ROC bump path (packets in order)
    alice.stream.seq = 0xfffe
    alice.sendRoc.lastSeq = null
    const w1 = alice.protectAudio(speechFrame) // seq fffe
    const w2 = alice.protectAudio(speechFrame) // seq ffff
    const w3 = alice.protectAudio(speechFrame) // seq 0000, roc→1
    const rw1 = bob.unprotectRtp(w1)
    const rw2 = bob.unprotectRtp(w2)
    const rw3 = bob.unprotectRtp(w3)
    check('wrap-around decrypt (ROC, in-order)', !!rw1 && !!rw2 && !!rw3 && rw3.payload.equals(speechFrame))
    // and a packet that jumps the wrap without its neighbors (unordered DC)
    const w4 = alice.protectAudio(speechFrame) // seq 0001, roc 1
    const bob2 = new cm.WACallMediaSession({ callId, callKey, relay, selfLid: bobLid, peerLid: aliceLid, logger })
    const jump = bob2.unprotectRtp(w4) // fresh tracker: sL=0, estimate roc 0; real roc 1 → must try +1
    check('wrap-around decrypt (jumped, roc+1 probe)', !!jump && jump.payload.equals(speechFrame))

    // group forwarding wrap/unwrap
    const wrapped = Buffer.concat([Buffer.from([0x09, 0x04]), Buffer.alloc(10), pkt1])
    const unwrapped = cm.unwrapGroupForwardingPacket(wrapped)
    check('group unwrap (0x09 0x04 → 12B header)', unwrapped.valid && unwrapped.wrapped && Buffer.compare(unwrapped.payload, pkt1) === 0)
    const bad = cm.unwrapGroupForwardingPacket(Buffer.from([0x09, 0x99, 1, 2, 3]))
    check('group unwrap rejects bad code', !bad.valid)

    // classify
    check('classify STUN', cm.classifyRelayPacket(Buffer.from([0x01, 0x01])) === 0)
    check('classify RTP', cm.classifyRelayPacket(Buffer.from([0x90, 0x78])) === 2)
    check('classify RTCP', cm.classifyRelayPacket(Buffer.from([0x81, 0xc8])) === 1)

    // ── allocate request build (group mode with pids) ──
    const txId = Buffer.alloc(12, 0xab)
    const alloc1to1 = cm.buildWasmAllocateRequest(txId, relay.tokens[1], cm.encodeXorRelayEndpoint('157.240.1.100', 3478), alice.streamSsrcs, relay.key, {})
    check('allocate 1:1: token attr present', alloc1to1.includes(Buffer.from([0x40, 0x00])))
    check('allocate 1:1: no sender-subscriptions', !alloc1to1.subarray(20).includes(Buffer.from([0x40, 0x25])))
    check('allocate 1:1: MI attr at end (no fingerprint)', alloc1to1.readUInt16BE(0) === 0x0003 && alloc1to1.length > 100 && !alloc1to1.subarray(alloc1to1.length - 12).includes(Buffer.from([0x80, 0x28])))

    const allocGrp = cm.buildWasmAllocateRequest(txId, relay.tokens[1], cm.encodeXorRelayEndpoint('157.240.1.100', 3478), alice.streamSsrcs, relay.key, { participantPids: [3, 11], appDataSsrc: alice.appDataSsrc, hbhFecSsrcs: [alice.hbhFecTxSsrc, alice.hbhFecRxSsrc] })
    const body = allocGrp.subarray(20)
    const hasAttr = (t) => { for (let i = 0; i < body.length - 4;) { const type = body.readUInt16BE(i); const len = body.readUInt16BE(i + 2); if (type === t) return true; i += 4 + len + ((4 - (len % 4)) % 4) } return false }
    check('allocate group: sender subs 0x4025', hasAttr(0x4025))
    check('allocate group: receiver subs 0x4021', hasAttr(0x4021))
    check('allocate group: participant count 0x805a', hasAttr(0x805a))

    // ── binding success (respond to relay consent check) ──
    const bindingReq = cm.encodeStunRequest(0x0001, txId, Buffer.alloc(0), relay.key, false)
    const bindingResp = cm.buildBindingSuccess(bindingReq, relay.key)
    check('binding success built', !!bindingResp && bindingResp.readUInt16BE(0) === 0x0101 && bindingResp.length === 20 + 24 + 8)
    check('binding success rejects non-binding', cm.buildBindingSuccess(Buffer.concat([Buffer.from([0x90, 0x78]), bindingReq.subarray(2)]), relay.key) === null)

    // ── SRTCP compound SR+SDES ──
    const sr = cm.buildSenderReport(alice.ssrc, { packetsSent: 5, octetsSent: 600, rtpTimestamp: 1600 }, 1718000000000)
    const sdes = cm.buildSourceDescription(alice.ssrc, cm.buildWhatsappRtcpCname())
    check('SR is 28B PT200', sr.length === 28 && sr[1] === 200)
    check('SDES is 32B PT202 cname 18B', sdes.length === 32 && sdes[1] === 202 && sdes[9] === 18)
    const srtcpKeys = cm.deriveE2eSrtcpKeys(callKey, aliceLid)
    const protectedRtcp = cm.protectSrtcp(srtcpKeys, alice.ssrc, 1, Buffer.concat([sr, sdes]))
    check('SRTCP protected: +4 index +10 tag', protectedRtcp.length === sr.length + sdes.length + 4 + 10)

    // ── Ogg demuxer with real ffmpeg silence ──
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:a', 'libopus', '-b:a', '24k', '-ar', '16000', '-ac', '1', '-application', 'voip', '-frame_duration', '60', '-f', 'ogg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const demuxer = new cm.OggOpusDemuxer()
    const frames = []
    await new Promise((resolve) => {
        ff.stdout.on('data', (c) => { for (const f of demuxer.push(c)) frames.push(f) })
        ff.on('close', resolve)
    })
    const expected = 2000 / 60 // ~33 frames in 2s
    check('ffmpeg silence → ~33 opus frames of 60ms', frames.length >= 30 && frames.length <= 40, frames.length)
    check('silence frames are compact (≤40B @24k)', frames.every((f) => f.length > 0 && f.length <= 40), frames.slice(0, 3).map((f) => f.length))
    check('no OpusHead leaked', frames.every((f) => f.subarray(0, 8).toString('latin1') !== 'OpusHead'))

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
