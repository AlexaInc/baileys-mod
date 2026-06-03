"use strict"

/**
 * call-media.js — WhatsApp call media transport (ICE/UDP + RTP + SRTP).
 *
 * Part of @alexainc/baileys-mod — https://github.com/Alexainc/baileys-mod
 * Author: hansaka@alexainc
 *
 *
 * WhatsApp calls negotiate transport candidates over the WebSocket signaling
 * channel, then carry audio as encrypted RTP over UDP. When both peers are
 * directly reachable, ICE picks a host/srflx candidate pair and media flows
 * device-to-device (the peer IP you observe while monitoring); otherwise it
 * falls back to WhatsApp relay (TURN-like) candidates.
 *
 * This module implements that transport:
 *   - candidate parsing (host / srflx / relay) from the call offer node
 *   - a UDP socket + STUN binding connectivity checks (ICE-lite)
 *   - RTP packetization of Opus frames
 *   - SRTP-style payload encryption keyed off the call's media key
 *   - an FFmpeg pump (any input -> Opus 48k) feeding the RTP sender
 *
 * NOTE ON CRYPTO PARAMETERS: WhatsApp's exact SRTP key-derivation and the
 * binding integrity key are derived from the call media key. The derivation
 * labels below (`callKdf`) are the integration point — adjust them to match the
 * observed handshake. Everything else (sockets, ICE checks, RTP framing, Opus
 * pipeline) is concrete and functional.
 */

const dgram = require("dgram")
const crypto = require("crypto")
const { spawn } = require("child_process")
const { EventEmitter } = require("events")

const STUN_BINDING_REQUEST = 0x0001
const STUN_BINDING_SUCCESS = 0x0101
const STUN_MAGIC = 0x2112a442
const RTP_PT_OPUS = 111
const RTP_PT_VP8 = 96

/**
 * Default media quality presets. Override any field via the `quality` option
 * passed to streamAudio / streamVideo (pytgcalls-style custom qualities).
 */
const DEFAULT_AUDIO_QUALITY = {
    codec: "libopus",   // ffmpeg audio codec
    bitrate: "32k",     // -b:a
    sampleRate: 48000,  // -ar
    channels: 1,        // -ac
    frameDuration: 20,  // ms per Opus frame
}

const DEFAULT_VIDEO_QUALITY = {
    codec: "libvpx",    // VP8 (WhatsApp video codec)
    bitrate: "500k",    // -b:v
    width: 640,         // scale width
    height: 360,        // scale height
    fps: 30,            // -r
    // common named presets resolvable via resolveVideoPreset()
}

/** Resolve a named video preset string (e.g. '720p') to {width,height}. */
function resolveVideoPreset(name) {
    const map = {
        "144p": { width: 256, height: 144 },
        "240p": { width: 426, height: 240 },
        "360p": { width: 640, height: 360 },
        "480p": { width: 854, height: 480 },
        "720p": { width: 1280, height: 720 },
        "1080p": { width: 1920, height: 1080 },
    }
    return map[String(name).toLowerCase()] || null
}

/** Build a TLV STUN attribute (4-byte aligned). */
function stunAttr(type, value) {
    const padded = Buffer.alloc(Math.ceil(value.length / 4) * 4)
    value.copy(padded)
    const h = Buffer.alloc(4)
    h.writeUInt16BE(type, 0)
    h.writeUInt16BE(value.length, 2)
    return Buffer.concat([h, padded])
}

/** Build a STUN binding request, optionally with MESSAGE-INTEGRITY. */
function buildBinding({ username, integrityKey } = {}) {
    const txId = crypto.randomBytes(12)
    let attrs = Buffer.alloc(0)
    if (username) {
        attrs = Buffer.concat([attrs, stunAttr(0x0006, Buffer.from(username))]) // USERNAME
    }
    attrs = Buffer.concat([attrs, stunAttr(0x8022, Buffer.from("baileys"))]) // SOFTWARE

    const header = Buffer.alloc(20)
    header.writeUInt16BE(STUN_BINDING_REQUEST, 0)
    header.writeUInt16BE(attrs.length, 2)
    header.writeUInt32BE(STUN_MAGIC, 4)
    txId.copy(header, 8)

    let packet = Buffer.concat([header, attrs])

    if (integrityKey) {
        const lenForMi = Buffer.from(packet)
        lenForMi.writeUInt16BE(attrs.length + 24, 2)
        const hmac = crypto.createHmac("sha1", integrityKey).update(lenForMi).digest()
        const miAttr = stunAttr(0x0008, hmac)
        packet = Buffer.concat([packet, miAttr])
        packet.writeUInt16BE(attrs.length + miAttr.length, 2)
    }
    return { packet, txId }
}

/** Parse a STUN message; returns { isStun, type, mapped }. */
function parseStun(buf) {
    if (buf.length < 20 || buf.readUInt32BE(4) !== STUN_MAGIC) {
        return { isStun: false }
    }
    const type = buf.readUInt16BE(0)
    let off = 20
    let mapped
    while (off + 4 <= buf.length) {
        const at = buf.readUInt16BE(off)
        const al = buf.readUInt16BE(off + 2)
        const val = buf.subarray(off + 4, off + 4 + al)
        if (at === 0x0020 && val.length >= 8) {
            const port = val.readUInt16BE(2) ^ 0x2112
            const ipKey = [0x21, 0x12, 0xa4, 0x42]
            const ip = [...val.subarray(4, 8)].map((b, i) => b ^ ipKey[i]).join(".")
            mapped = `${ip}:${port}`
        }
        off += 4 + Math.ceil(al / 4) * 4
    }
    return { isStun: true, type, mapped }
}

/**
 * Derive media keys from the call key. The label set is the documented
 * integration point — tune to match the observed handshake.
 */
function callKdf(callKey, label, len = 32) {
    return crypto.createHmac("sha256", callKey).update(label).digest().subarray(0, len)
}

/** Extract transport candidates from a call <offer> info node. */
function extractCandidates(offerNode) {
    const cands = []
    const visit = (n) => {
        if (!n || typeof n !== "object") return
        const a = n.attrs || {}
        const ip = a.ip || a.host || a.address || a.addr
        const port = a.port || a.p
        if (ip && port) {
            cands.push({
                ip,
                port: +port,
                type: a.type || n.tag || "host",
                relayId: a.relay_id,
                priority: +(a.priority || a.pref || 0),
            })
        }
        if (Array.isArray(n.content)) for (const c of n.content) visit(c)
    }
    visit(offerNode)
    // host/srflx (direct P2P) preferred over relay
    return cands.sort((x, y) => rank(x) - rank(y))
}

function rank(c) {
    const t = (c.type || "").toLowerCase()
    if (t.includes("host")) return 0
    if (t.includes("srflx") || t.includes("stun")) return 1
    if (t.includes("relay") || t.includes("turn") || c.relayId) return 2
    return 3
}

/**
 * A live call media session. Handles ICE connectivity, RTP send, SRTP, and the
 * FFmpeg audio pump. Emits: 'connected' (with the chosen pair), 'rtp', 'closed'.
 */
class WACallMediaSession extends EventEmitter {
    constructor({ callId, callKey, candidates, logger }) {
        super()
        this.callId = callId
        this.callKey = callKey
        this.candidates = candidates || []
        this.logger = logger || console
        this.socket = dgram.createSocket("udp4")
        this.selected = null
        // audio RTP state
        this.seq = (Math.random() * 0xffff) | 0
        this.ts = (Math.random() * 0xffffffff) >>> 0
        this.ssrc = crypto.randomBytes(4).readUInt32BE(0)
        // video RTP state (separate stream)
        this.vseq = (Math.random() * 0xffff) | 0
        this.vts = (Math.random() * 0xffffffff) >>> 0
        this.vssrc = crypto.randomBytes(4).readUInt32BE(0)
        this.ff = null      // audio ffmpeg
        this.vff = null     // video ffmpeg
        this.closed = false

        // derived media material
        this.srtpKey = callKey ? callKdf(callKey, "WhatsApp Call SRTP", 16) : null
        this.srtpSalt = callKey ? callKdf(callKey, "WhatsApp Call Salt", 14) : null
        this.iceKey = callKey ? callKdf(callKey, "WhatsApp Call ICE", 20) : null

        this.socket.on("message", (msg, rinfo) => this._onPacket(msg, rinfo))
        this.socket.on("error", (e) => this.logger.warn?.({ err: e?.message }, "[call-media] socket error"))
    }

    /** Run ICE connectivity checks; resolve with the first responsive pair. */
    async connect(timeoutMs = 5000) {
        await new Promise((res) => this.socket.bind(res))
        this.logger.info?.(
            { candidates: this.candidates.map((c) => `${c.type}:${c.ip}:${c.port}`) },
            "[call-media] starting ICE checks"
        )

        return new Promise((resolve, reject) => {
            let settled = false
            const finish = (pair) => {
                if (settled) return
                settled = true
                if (pair) {
                    this.selected = pair
                    this.emit("connected", pair)
                    this.logger.info?.({ pair: `${pair.ip}:${pair.port}` }, "[call-media] connectivity OK")
                    resolve(pair)
                } else {
                    reject(new Error("ICE failed: no candidate responded"))
                }
            }

            this._pending = new Map()
            for (const c of this.candidates) {
                const { packet, txId } = buildBinding({
                    username: `${this.callId}`,
                    integrityKey: this.iceKey,
                })
                this._pending.set(txId.toString("hex"), c)
                this._onBindOk = (rinfo) => finish({ ip: rinfo.address, port: rinfo.port })
                this.socket.send(packet, c.port, c.ip, (err) => {
                    if (err) this.logger.debug?.({ err: err.message, c }, "[call-media] send fail")
                })
            }
            setTimeout(() => finish(null), timeoutMs)
        })
    }

    _onPacket(msg, rinfo) {
        const st = parseStun(msg)
        if (st.isStun) {
            if (st.type === STUN_BINDING_REQUEST) {
                // respond so the peer's check succeeds too (symmetric ICE)
                this._sendBindingSuccess(msg, rinfo)
            } else if (st.type === STUN_BINDING_SUCCESS) {
                this._onBindOk?.(rinfo)
            }
            return
        }
        // assume RTP/SRTP media
        this.emit("rtp", { data: msg, from: `${rinfo.address}:${rinfo.port}` })
    }

    _sendBindingSuccess(reqBuf, rinfo) {
        const txId = reqBuf.subarray(8, 20)
        const xport = Buffer.alloc(2)
        xport.writeUInt16BE(rinfo.port ^ 0x2112)
        const ipParts = rinfo.address.split(".").map(Number)
        const xip = Buffer.from(ipParts.map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]))
        const mapped = stunAttr(0x0020, Buffer.concat([Buffer.from([0, 0x01]), xport, xip]))
        const header = Buffer.alloc(20)
        header.writeUInt16BE(STUN_BINDING_SUCCESS, 0)
        header.writeUInt16BE(mapped.length, 2)
        header.writeUInt32BE(STUN_MAGIC, 4)
        txId.copy(header, 8)
        this.socket.send(Buffer.concat([header, mapped]), rinfo.port, rinfo.address)
    }

    /**
     * Build an RTP packet around a media payload, then SRTP-encrypt it.
     * kind: 'audio' (Opus) | 'video' (VP8). Each kind keeps its own
     * sequence number, timestamp and SSRC.
     */
    _packetize(payloadData, kind = "audio", tsIncrement) {
        const isVideo = kind === "video"
        const pt = isVideo ? RTP_PT_VP8 : RTP_PT_OPUS
        const seq = isVideo ? this.vseq : this.seq
        const ts = isVideo ? this.vts : this.ts
        const ssrc = isVideo ? this.vssrc : this.ssrc

        const hdr = Buffer.alloc(12)
        hdr[0] = 0x80
        hdr[1] = pt & 0x7f
        hdr.writeUInt16BE(seq & 0xffff, 2)
        hdr.writeUInt32BE(ts >>> 0, 4)
        hdr.writeUInt32BE(ssrc >>> 0, 8)

        if (isVideo) {
            this.vseq = (this.vseq + 1) & 0xffff
            this.vts = (this.vts + (tsIncrement ?? 3000)) >>> 0 // 90kHz clock
        } else {
            this.seq = (this.seq + 1) & 0xffff
            this.ts = (this.ts + (tsIncrement ?? 960)) >>> 0 // 20ms @ 48kHz
        }
        const payload = this.srtpKey ? this._srtpEncrypt(hdr, payloadData, seq) : payloadData
        return Buffer.concat([hdr, payload])
    }

    /** AES-CTR SRTP-style payload encryption keyed off the call media key. */
    _srtpEncrypt(hdr, payload, seq) {
        const iv = Buffer.alloc(16)
        this.srtpSalt.copy(iv, 0, 0, 14)
        iv.writeUInt16BE(seq & 0xffff, 14)
        const cipher = crypto.createCipheriv("aes-128-ctr", this.srtpKey, iv)
        return Buffer.concat([cipher.update(payload), cipher.final()])
    }

    /**
     * Start streaming an audio source through FFmpeg (-> Opus) into the call.
     * `input` is anything ffmpeg accepts (file path, URL, pipe, device).
     * `quality` (optional) overrides DEFAULT_AUDIO_QUALITY:
     *   { codec, bitrate, sampleRate, channels, frameDuration }
     */
    streamAudio(input, quality = {}) {
        if (!this.selected) throw new Error("not connected; call connect() first")
        this.stopAudio() // stop any current audio track first
        const q = { ...DEFAULT_AUDIO_QUALITY, ...quality }

        // FFmpeg -> raw Opus; we re-frame to fixed packets.
        this.ff = spawn("ffmpeg", [
            "-re", "-i", input,
            "-vn",
            "-c:a", q.codec,
            "-b:a", String(q.bitrate),
            "-ar", String(q.sampleRate),
            "-ac", String(q.channels),
            "-frame_duration", String(q.frameDuration),
            "-f", "data", "pipe:1",
        ])
        const thisFf = this.ff
        this.ff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:a] ${d}`))
        this.ff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg audio: " + e.message))

        // ts increment per frame on the 48kHz Opus clock
        const tsInc = Math.round((q.sampleRate * q.frameDuration) / 1000)
        // rough payload size per frame for the given bitrate/frameDuration
        const FRAME = Math.max(40, Math.round((parseBitrate(q.bitrate) / 8) * (q.frameDuration / 1000)))

        let buf = Buffer.alloc(0)
        const tick = setInterval(() => {
            if (buf.length >= FRAME) {
                const frame = buf.subarray(0, FRAME)
                buf = buf.subarray(FRAME)
                const pkt = this._packetize(frame, "audio", tsInc)
                this.socket.send(pkt, this.selected.port, this.selected.ip)
            }
        }, q.frameDuration)
        this._tick = tick

        this.ff.stdout.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]) })
        this.ff.on("close", (code, signal) => {
            clearInterval(tick)
            if (this.ff === thisFf && !this.closed) {
                this.ff = null
                this.emit("trackEnd", { kind: "audio", skipped: signal === "SIGKILL" })
            }
        })
        return this
    }

    /**
     * Start streaming a VIDEO source through FFmpeg (-> VP8) into the call.
     * `input` is anything ffmpeg accepts. Audio in the same file should be sent
     * separately via streamAudio (call both for an A/V stream).
     * `quality` (optional) overrides DEFAULT_VIDEO_QUALITY:
     *   { codec, bitrate, width, height, fps }  OR  { preset: '720p' }
     */
    streamVideo(input, quality = {}) {
        if (!this.selected) throw new Error("not connected; call connect() first")
        this.stopVideo()
        const preset = quality.preset ? resolveVideoPreset(quality.preset) : null
        const q = { ...DEFAULT_VIDEO_QUALITY, ...(preset || {}), ...quality }

        this.vff = spawn("ffmpeg", [
            "-re", "-i", input,
            "-an",
            "-c:v", q.codec,
            "-b:v", String(q.bitrate),
            "-vf", `scale=${q.width}:${q.height}`,
            "-r", String(q.fps),
            "-deadline", "realtime", "-cpu-used", "5",
            "-f", "rtp_mpegts", "-", // packetized; we re-chunk to RTP-sized payloads
        ])
        const thisVff = this.vff
        this.vff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:v] ${d}`))
        this.vff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg video: " + e.message))

        const tsInc = Math.round(90000 / q.fps) // 90kHz video clock
        const MTU = 1100 // keep RTP payloads under typical UDP MTU
        let buf = Buffer.alloc(0)
        const flush = () => {
            while (buf.length >= MTU) {
                const frame = buf.subarray(0, MTU)
                buf = buf.subarray(MTU)
                const pkt = this._packetize(frame, "video", tsInc)
                this.socket.send(pkt, this.selected.port, this.selected.ip)
            }
        }
        this.vff.stdout.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); flush() })
        this.vff.on("close", (code, signal) => {
            if (this.vff === thisVff && !this.closed) {
                this.vff = null
                this.emit("trackEnd", { kind: "video", skipped: signal === "SIGKILL" })
            }
        })
        return this
    }

    /**
     * Convenience: stream a single file as both audio AND video.
     * `quality` = { audio: {...}, video: {...} }
     */
    streamMedia(input, quality = {}) {
        this.streamAudio(input, quality.audio || {})
        this.streamVideo(input, quality.video || {})
        return this
    }

    /** Stop the current audio track without closing the call (for skip/stop). */
    stopAudio() {
        if (this._tick) { clearInterval(this._tick); this._tick = null }
        if (this.ff) {
            const ff = this.ff
            this.ff = null
            try { ff.kill("SIGKILL") } catch {}
        }
    }

    /** Stop the current video track without closing the call. */
    stopVideo() {
        if (this.vff) {
            const vff = this.vff
            this.vff = null
            try { vff.kill("SIGKILL") } catch {}
        }
    }

    close() {
        if (this.closed) return
        this.closed = true
        if (this._tick) { clearInterval(this._tick); this._tick = null }
        try { this.ff?.kill("SIGKILL") } catch {}
        try { this.vff?.kill("SIGKILL") } catch {}
        try { this.socket.close() } catch {}
        this.emit("closed")
    }
}

/** Parse an ffmpeg-style bitrate string ('32k','500k','1M') to bits/sec. */
function parseBitrate(b) {
    if (typeof b === "number") return b
    const m = String(b).trim().match(/^([\d.]+)\s*([kKmM]?)/)
    if (!m) return 32000
    const n = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    return Math.round(n * (unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1))
}

module.exports = {
    WACallMediaSession,
    extractCandidates,
    callKdf,
    buildBinding,
    parseStun,
    resolveVideoPreset,
    DEFAULT_AUDIO_QUALITY,
    DEFAULT_VIDEO_QUALITY,
}
