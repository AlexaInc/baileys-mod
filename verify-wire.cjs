#!/usr/bin/env node
// End-to-end wire-format verification: run the REAL song through the REAL
// production pipeline (ffmpeg with DEFAULT_AUDIO_QUALITY args → OggOpusDemuxer
// → _tick shaping) and assert the exact bytes that would go on the wire.
//
// FRAMES_PER_PACKET=1 (standard-Opus/SILK mode, current default): every demuxed
// frame IS a wire packet — must be a code-0 single, config 11 (SILK WB 16kHz
// 60ms, TOC 0x58), matching the real client's captured stream exactly.
// FRAMES_PER_PACKET=3 (MLow/CELT mode): frames group into 60ms code-3
// multiframes and escape; verify the single-level escape shape.
const { spawn } = require('child_process')
const cm = require('./lib/Utils/call-media.js')

const INPUT = process.argv[2] || '/home/user/uploads/55BS8QO5C9o.mp3'
const SECONDS = process.argv[3] ? parseInt(process.argv[3]) : 20

async function main() {
    const q = cm.DEFAULT_AUDIO_QUALITY
    const fpp = cm.FRAMES_PER_PACKET
    const args = ['-hide_banner', '-loglevel', 'error', '-t', String(SECONDS), '-i', INPUT,
        '-vn', '-c:a', q.codec, '-b:a', String(q.bitrate), '-ar', String(q.sampleRate),
        '-ac', String(q.channels), '-application', q.application,
        '-frame_duration', String(q.frameDuration), '-f', 'ogg', 'pipe:1']
    console.log('ffmpeg args:', args.join(' '))
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    const dem = new cm.OggOpusDemuxer()
    const frames = []
    await new Promise((res) => {
        ff.stdout.on('data', (c) => { for (const f of dem.push(c)) frames.push(f) })
        ff.on('close', res)
    })
    const expectFps = 1000 / cm.ENCODER_FRAME_MS
    console.log(`demuxed frames: ${frames.length} (expect ~${Math.round(SECONDS * expectFps)} @${cm.ENCODER_FRAME_MS}ms, fpp=${fpp})`)
    const singles = frames.filter(f => (f[0] & 3) === 0).length
    console.log(`code-0 singles: ${singles}/${frames.length}`)

    if (fpp === 1) {
        // ── standard-Opus/SILK mode ──
        const silk = frames.filter(f => (f[0] >> 3) === 11 && (f[0] & 3) === 0 && ((f[0] >> 1) & 1) === 0)
        const sizes = frames.map(f => f.length).sort((a, b) => a - b)
        console.log(`SILK WB 60ms singles (config 11, TOC 0x58): ${silk.length}/${frames.length}`)
        console.log(`frame size: min ${sizes[0]} p50 ${sizes[sizes.length >> 1]} max ${sizes[sizes.length - 1]}`)
        const headOk = frames[0] && frames[0][0] === 0x58
        const allSilk = silk.length === frames.length
        const countOk = frames.length >= Math.round(SECONDS * expectFps * 0.9)
            && frames.length <= Math.round(SECONDS * expectFps * 1.15)
        const pass = headOk && allSilk && countOk
        console.log(pass
            ? '\n✅ WIRE FORMAT VERIFIED — SILK WB 60ms singles, identical shape to the real client'
            : '\n❌ WIRE FORMAT BROKEN')
        process.exit(pass ? 0 : 1)
    }

    // ── MLow/CELT multiframe mode (fpp=3) ──
    let ok = 0, sid = 0, dropped = 0, rejected = 0
    const sizes = []
    const firstBytes = {}
    for (let i = 0; i + 3 <= frames.length; i += 3) {
        const group = frames.slice(i, i + 3)
        let payload = cm.buildOpusMultiframe(group)
        if (!payload) {
            const tiny = group.find(f => f && f.length > 0 && f.length <= 2)
            if (tiny) payload = tiny
            else { rejected++; continue }
        }
        if (payload.length > 2 && (payload[0] & 3) !== 3) { dropped++; continue } // mlow single guard
        const esc = cm.mlowEscapeOpus(payload)
        if (!esc) { dropped++; continue }
        if (esc.length === 1 && esc[0] === 0x90) sid++
        else {
            ok++
            sizes.push(esc.length)
            const key = '0x' + esc[0].toString(16)
            firstBytes[key] = (firstBytes[key] || 0) + 1
        }
    }
    console.log(`\nwire packets: ${ok} multiframe + ${sid} SID + ${dropped} dropped + ${rejected} builder-rejected`)
    console.log('escaped TOC histogram:', firstBytes)
    if (sizes.length) {
        sizes.sort((a, b) => a - b)
        console.log(`packet size: min ${sizes[0]} p50 ${sizes[sizes.length >> 1]} max ${sizes[sizes.length - 1]}`)
    }
    // structural validation of an escaped multiframe: [0xDD][0x83][l1][l2][d1 d2 d3]
    let structBad = 0
    for (let i = 0; i + 3 <= frames.length; i += 3) {
        const group = frames.slice(i, i + 3)
        const payload = cm.buildOpusMultiframe(group)
        if (!payload || payload.length <= 2) continue
        const esc = cm.mlowEscapeOpus(payload)
        if (esc.length === 1) continue
        const [toc, cnt, l1, l2] = esc
        if (toc !== 0xdd || cnt !== 0x83) { structBad++; continue }
        if (esc.length !== payload.length) { structBad++; continue }
        const d3len = esc.length - 4 - l1 - l2
        if (l1 < 1 || l2 < 1 || d3len < 1 || 4 + l1 + l2 + d3len !== esc.length) { structBad++; continue }
        if (l1 > 251 || l2 > 251 || d3len > 251) { structBad++; continue }
    }
    console.log(`structural mismatches: ${structBad}`)
    const pass = singles === frames.length && ok > 0 && structBad === 0 && sid + ok + dropped === Math.floor(frames.length / 3)
    console.log(pass ? '\n✅ WIRE FORMAT VERIFIED — clean single-level 60ms MLow multiframes' : '\n❌ WIRE FORMAT BROKEN')
    process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
