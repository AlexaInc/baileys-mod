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
 *   - SRTP payload encryption + auth keyed off the call's media key
 *   - an FFmpeg pump (any input -> Opus 48k) feeding the RTP sender
 *
 * CRYPTO: the SRTP key-derivation labels and the HKDF-SHA256 construction were
 * recovered from WhatsApp Web's VoIP WASM binary (see `CALL_KDF_LABELS` and
 * `callKdf` below), and the SRTP layer follows RFC 3711 AES_CM_128_HMAC_SHA1_80.
 * Both are pinned to official RFC test vectors in tests/call.test.js.
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

/**
 * Normalize an address for comparison: Node reports dual-stack IPv4 peers as
 * "::ffff:1.2.3.4", which otherwise never matches the candidate we probed.
 */
function normalizeIp(ip) {
    if (typeof ip !== "string") return ip
    const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    return m ? m[1] : ip
}

/** Map an IPv4 literal into the v4-mapped form our dual-stack socket needs. */
function toV4MappedTarget(ip) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `::ffff:${ip}` : ip
}

/** Expand an IPv6 text address (incl. '::' shorthand) into 16 raw bytes. */
function ipv6ToBuffer(ip) {
    const zone = ip.indexOf("%")
    if (zone >= 0) ip = ip.slice(0, zone)
    const halves = ip.split("::")
    if (halves.length > 2) return null
    const parse = (s) => (s ? s.split(":").filter(Boolean) : [])
    const head = parse(halves[0])
    const tail = halves.length === 2 ? parse(halves[1]) : []
    const fill = 8 - head.length - tail.length
    if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
    const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail]
    const out = Buffer.alloc(16)
    for (let i = 0; i < 8; i++) {
        const v = parseInt(groups[i], 16)
        if (Number.isNaN(v)) return null
        out.writeUInt16BE(v, i * 2)
    }
    return out
}

/** Build a STUN binding request, optionally with MESSAGE-INTEGRITY. */
function buildBinding({ username, integrityKey, token } = {}) {
    const txId = crypto.randomBytes(12)
    let attrs = Buffer.alloc(0)
    if (username) {
        attrs = Buffer.concat([attrs, stunAttr(0x0006, Buffer.from(username))]) // USERNAME
    }
    if (token) {
        // WhatsApp relays authenticate the allocation with the <relay><token>
        // blob from the offer, carried as a comprehension-optional attribute.
        attrs = Buffer.concat([attrs, stunAttr(0xc057, Buffer.from(token))])
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
 * The real hop-by-hop SRTP derivation labels, recovered from WhatsApp Web's
 * VoIP WASM binary (`whatsapp.wasm`). They sit as a contiguous block of
 * null-terminated C strings next to the `derive_hbh_srtp_key` symbol.
 *
 * WhatsApp uses ordinary SRTP (`AES_CM_128_HMAC_SHA1_80`), so each direction
 * needs a 16-byte master key and a 14-byte master salt.
 */
const CALL_KDF_LABELS = {
    SRTP_KEY: "hbh srtp key",
    SRTP_SALT: "hbh srtp salt",
    SRTCP_UPLINK_KEY: "uplink hbh srtcp key",
    SRTCP_UPLINK_SALT: "uplink hbh srtcp salt",
    SRTCP_DOWNLINK_KEY: "downlink hbh srtcp key",
    SRTCP_DOWNLINK_SALT: "downlink hbh srtcp salt",
    WARP_AUTH_KEY: "warp auth key",
    WARP_AUTH_SALT: "warp auth salt",
    E2E_SFRAME_KEY: "e2e sframe key",
}

/** SRTP master key / salt sizes for AES_CM_128_HMAC_SHA1_80. */
const SRTP_MASTER_KEY_LEN = 16
const SRTP_MASTER_SALT_LEN = 14
/** HMAC-SHA1 session auth key, and the "_80" 10-byte tag it emits. */
const SRTP_AUTH_KEY_LEN = 20
const SRTP_AUTH_TAG_LEN = 10

/**
 * RFC 3711 §4.3.1 session-key derivation.
 *
 * key_id = label || (index / kdr), with kdr = 0 so the divide term vanishes.
 * The 14-byte master salt is left-aligned in a 16-byte block, XORed with
 * key_id, and used as the AES-CM counter to generate the session key.
 */
function srtpDeriveSessionKey(masterKey, masterSalt, label, len) {
    const iv = Buffer.alloc(16)
    masterSalt.copy(iv, 0, 0, SRTP_MASTER_SALT_LEN)
    iv[7] ^= label
    const cipher = crypto.createCipheriv("aes-128-ctr", masterKey, iv)
    return Buffer.concat([cipher.update(Buffer.alloc(len)), cipher.final()]).subarray(0, len)
}

/**
 * RFC 3711 §4.1.1 AES-CM initialization vector:
 *   IV = (salt << 16) XOR (SSRC << 64) XOR (packet_index << 16)
 */
function srtpIv(sessionSalt, ssrc, index) {
    const iv = Buffer.alloc(16)
    sessionSalt.copy(iv, 0, 0, SRTP_MASTER_SALT_LEN)
    // SSRC occupies bytes 4..7
    iv[4] ^= (ssrc >>> 24) & 0xff
    iv[5] ^= (ssrc >>> 16) & 0xff
    iv[6] ^= (ssrc >>> 8) & 0xff
    iv[7] ^= ssrc & 0xff
    // 48-bit packet index occupies bytes 8..13
    const hi = Math.floor(index / 0x100000000)
    const lo = index >>> 0
    iv[8] ^= (hi >>> 8) & 0xff
    iv[9] ^= hi & 0xff
    iv[10] ^= (lo >>> 24) & 0xff
    iv[11] ^= (lo >>> 16) & 0xff
    iv[12] ^= (lo >>> 8) & 0xff
    iv[13] ^= lo & 0xff
    return iv
}

/**
 * Derive media keys from the call key.
 *
 * This is HKDF-SHA256 (RFC 5869) with the call key as the input keying
 * material and the label as the HKDF *info* — not a bare HMAC, which is what
 * this function used to do with invented labels.
 *
 * Confirmed from the WASM stack: the binary imports
 * `hkdf_extract_and_expand_js`, whose JS side calls
 * `cryptoHkdfExtractWithSaltAndExpand({ key_, salt_, info_, length })` and
 * forwards straight to `WACryptoHkdfSync.hkdf(key, salt, info, length)`.
 *
 * @param callKey the 32-byte call media key from the offer
 * @param label   an entry of CALL_KDF_LABELS (the HKDF info)
 * @param len     output length in bytes
 * @param salt    optional HKDF salt; defaults to 32 zero bytes, as BoringSSL does
 */
function callKdf(callKey, label, len = 32, salt = null) {
    const effectiveSalt = salt && salt.length ? Buffer.from(salt) : Buffer.alloc(32, 0)
    const info = Buffer.isBuffer(label) ? label : Buffer.from(String(label), "utf8")

    // extract
    const prk = crypto.createHmac("sha256", effectiveSalt).update(callKey).digest()

    // expand
    const blocks = Math.ceil(len / 32)
    const okm = Buffer.alloc(blocks * 32)
    let prev = Buffer.alloc(0)
    for (let i = 1; i <= blocks; i++) {
        prev = crypto.createHmac("sha256", prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest()
        prev.copy(okm, (i - 1) * 32)
    }
    return okm.subarray(0, len)
}

/**
 * Decode a packed WhatsApp transport endpoint.
 *
 * WhatsApp does NOT put ip/port attributes on its candidate nodes. It packs
 * them as raw big-endian bytes in the node's *content*:
 *
 *    6 bytes  ->  4-byte IPv4  + 2-byte port
 *   18 bytes  -> 16-byte IPv6  + 2-byte port
 *
 * Verified against real `<relay>` payloads, e.g. the `te2` value "nfAJMw2W"
 * decodes to 9d f0 09 33 0d 96 => 157.240.9.51:3478 (a Meta relay), and
 * "KgMogPIoAMP6zrAMAAABdw2W" => [2a03:2880:f228:c3:face:b00c:0:177]:3478.
 */
function decodeEndpoint(buf) {
    if (!buf) return null
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    if (b.length === 6) {
        return {
            ip: `${b[0]}.${b[1]}.${b[2]}.${b[3]}`,
            port: b.readUInt16BE(4),
            family: 4,
        }
    }
    if (b.length === 18) {
        const parts = []
        for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16))
        return { ip: parts.join(":"), port: b.readUInt16BE(16), family: 6 }
    }
    return null
}

/**
 * Extract transport candidates from a call <offer> info node.
 *
 * Handles both the real WhatsApp wire format (binary `te` / `te2` / `rte`
 * endpoints, usually nested in `<relay>`) and the attribute style
 * (`ip=`/`port=`) some forks/tests emit.
 */
function extractCandidates(offerNode) {
    const cands = []
    const seen = new Set()

    const add = (c) => {
        if (!c || !c.ip || !c.port) return
        const key = `${c.ip}:${c.port}`
        if (seen.has(key)) return
        seen.add(key)
        cands.push(c)
    }

    const visit = (n) => {
        if (!n || typeof n !== "object") return
        const a = n.attrs || {}
        const tag = n.tag

        // 1. binary endpoint nodes (the real WhatsApp format)
        if ((tag === "te2" || tag === "te" || tag === "rte") &&
            (Buffer.isBuffer(n.content) || n.content instanceof Uint8Array)) {
            const ep = decodeEndpoint(n.content)
            if (ep) {
                add({
                    ...ep,
                    // `rte` is the peer's own reflexive endpoint -> direct P2P.
                    // `te`/`te2` inside <relay> are Meta relay servers.
                    type: tag === "rte" ? "srflx" : "relay",
                    relayId: a.relay_id,
                    priority: +(a.priority || a.pref || 0),
                })
            }
        }

        // 2. attribute style (ip=/host=/addr= + port=)
        const ip = a.ip || a.host || a.address || a.addr
        const port = a.port || a.p
        if (ip && port) {
            add({
                ip,
                port: +port,
                family: String(ip).includes(":") ? 6 : 4,
                type: a.type || tag || "host",
                relayId: a.relay_id,
                priority: +(a.priority || a.pref || 0),
            })
        }

        if (Array.isArray(n.content)) for (const c of n.content) visit(c)
    }
    visit(offerNode)

    // host/srflx (direct P2P) preferred over relay; IPv4 before IPv6.
    return cands.sort((x, y) => (rank(x) - rank(y)) || ((x.family || 4) - (y.family || 4)))
}

/** Extract the relay auth token from a call <offer>/<relay> node, if present. */
function extractRelayToken(offerNode) {
    let token
    const visit = (n) => {
        if (!n || typeof n !== "object" || token) return
        if (n.tag === "token" && (Buffer.isBuffer(n.content) || n.content instanceof Uint8Array)) {
            token = Buffer.from(n.content)
            return
        }
        if (Array.isArray(n.content)) for (const c of n.content) visit(c)
    }
    visit(offerNode)
    return token
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
    constructor({ callId, callKey, candidates, logger, relayToken }) {
        super()
        this.callId = callId
        this.callKey = callKey
        this.candidates = candidates || []
        this.relayToken = relayToken || null
        this.logger = logger || console
        // udp6 with dual-stack so both IPv4 and IPv6 relay candidates work.
        this.socket = dgram.createSocket({ type: "udp6", ipv6Only: false })
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
        // Hop-by-hop SRTP material, using the labels recovered from the VoIP
        // WASM binary. AES_CM_128_HMAC_SHA1_80 => 16-byte key, 14-byte salt.
        this.srtpKey = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTP_KEY, SRTP_MASTER_KEY_LEN)
            : null
        this.srtpSalt = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTP_SALT, SRTP_MASTER_SALT_LEN)
            : null
        // SRTCP uses its own uplink/downlink key+salt pair.
        this.srtcpTxKey = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTCP_UPLINK_KEY, SRTP_MASTER_KEY_LEN)
            : null
        this.srtcpTxSalt = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTCP_UPLINK_SALT, SRTP_MASTER_SALT_LEN)
            : null
        this.srtcpRxKey = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTCP_DOWNLINK_KEY, SRTP_MASTER_KEY_LEN)
            : null
        this.srtcpRxSalt = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.SRTCP_DOWNLINK_SALT, SRTP_MASTER_SALT_LEN)
            : null
        // relay/transport ("warp") authentication material
        this.iceKey = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.WARP_AUTH_KEY, 20)
            : null
        this.iceSalt = callKey
            ? callKdf(callKey, CALL_KDF_LABELS.WARP_AUTH_SALT, SRTP_MASTER_SALT_LEN)
            : null

        this.socket.on("message", (msg, rinfo) => this._onPacket(msg, rinfo))
        this.socket.on("error", (e) => this.logger.warn?.({ err: e?.message }, "[call-media] socket error"))
    }

    /**
     * Run ICE connectivity checks; resolve with the first responsive pair.
     *
     * Fixes vs. the previous implementation:
     *  - binding requests are RETRANSMITTED (UDP checks are routinely lost;
     *    a single shot against a relay almost always timed out),
     *  - the success handler is bound once instead of being overwritten inside
     *    the candidate loop (it used to only ever resolve for the last one),
     *  - only replies from a candidate we actually probed are accepted.
     */
    async connect(timeoutMs = 8000) {
        if (!this.candidates.length) {
            throw new Error(
                "no transport candidates in offer; cannot open media path " +
                "(the <relay>/te2 endpoints were missing or unparsable)"
            )
        }

        await new Promise((res, rej) => {
            this.socket.once("error", rej)
            this.socket.bind(res)
        })

        this.logger.info?.(
            { candidates: this.candidates.map((c) => `${c.type}:${c.ip}:${c.port}`) },
            "[call-media] starting ICE checks"
        )

        return new Promise((resolve, reject) => {
            let settled = false
            let retryTimer = null
            let deadline = null

            const cleanup = () => {
                if (retryTimer) clearInterval(retryTimer)
                if (deadline) clearTimeout(deadline)
                retryTimer = deadline = null
            }

            // let close() tear down the retransmit timer mid-connect
            this._abortConnect = () => finish(null)

            const finish = (pair) => {
                if (settled) return
                settled = true
                cleanup()
                this._abortConnect = null
                this._onBindOk = null
                if (pair) {
                    this.selected = pair
                    this.emit("connected", pair)
                    this.logger.info?.({ pair: `${pair.ip}:${pair.port}` }, "[call-media] connectivity OK")
                    resolve(pair)
                } else {
                    reject(new Error(
                        `ICE failed: no candidate responded within ${timeoutMs}ms ` +
                        `(tried ${this.candidates.length})`
                    ))
                }
            }

            // remember what we probed so stray packets can't select a bogus pair
            this._probed = new Set(this.candidates.map((c) => `${normalizeIp(c.ip)}:${c.port}`))
            this._pending = new Map()

            // Bound ONCE — previously reassigned per candidate inside the loop.
            this._onBindOk = (rinfo) => {
                const key = `${normalizeIp(rinfo.address)}:${rinfo.port}`
                if (this._probed.size && !this._probed.has(key)) {
                    this.logger.trace?.({ key }, "[call-media] ignoring reply from unprobed source")
                    return
                }
                finish({ ip: rinfo.address, port: rinfo.port })
            }

            const probe = () => {
                for (const c of this.candidates) {
                    const { packet, txId } = buildBinding({
                        username: `${this.callId}`,
                        integrityKey: this.iceKey,
                        token: this.relayToken,
                    })
                    this._pending.set(txId.toString("hex"), c)
                    const dest = c.family === 6 ? c.ip : toV4MappedTarget(c.ip)
                    this.socket.send(packet, c.port, dest, (err) => {
                        if (err) this.logger.debug?.({ err: err.message, c }, "[call-media] send fail")
                    })
                }
            }

            probe()
            retryTimer = setInterval(probe, 300)   // STUN Ta-style retransmission
            deadline = setTimeout(() => finish(null), timeoutMs)
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

        // rinfo.address may be "::ffff:1.2.3.4" on our dual-stack socket, which
        // the old split('.') parsing turned into NaN bytes.
        const addr = normalizeIp(rinfo.address)
        const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(addr)
        let xip
        if (isV4) {
            const ipParts = addr.split(".").map(Number)
            xip = Buffer.from(ipParts.map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]))
        } else {
            // XOR-MAPPED-ADDRESS for IPv6 uses magic cookie || transaction id
            const raw = ipv6ToBuffer(addr)
            if (!raw) return
            const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txId])
            xip = Buffer.from(raw.map((b, i) => b ^ mask[i]))
        }

        const mapped = stunAttr(
            0x0020,
            Buffer.concat([Buffer.from([0, isV4 ? 0x01 : 0x02]), xport, xip])
        )
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
        if (!this.srtpKey) return Buffer.concat([hdr, payloadData])
        return this._srtpProtect(hdr, payloadData, seq, ssrc, isVideo)
    }

    /**
     * SRTP-protect an RTP packet (RFC 3711, AES_CM_128_HMAC_SHA1_80).
     *
     * Encrypts the payload with AES-128 counter mode and appends a 10-byte
     * HMAC-SHA1 auth tag over (header || ciphertext || ROC).
     *
     * The previous implementation used the *master* key directly with a
     * seq-only IV and emitted no auth tag, which no SRTP peer would accept.
     */
    _srtpProtect(hdr, payload, seq, ssrc, isVideo) {
        const s = this._srtpState(isVideo)

        // 48-bit packet index = ROC || SEQ, rolling over at each seq wrap
        if (s.lastSeq !== null && seq < 0x4000 && s.lastSeq > 0xc000) s.roc = (s.roc + 1) >>> 0
        s.lastSeq = seq
        const index = s.roc * 0x10000 + seq

        const cipher = crypto.createCipheriv(
            "aes-128-ctr",
            s.key,
            srtpIv(s.salt, ssrc, index)
        )
        const enc = Buffer.concat([cipher.update(payload), cipher.final()])

        // auth portion: RTP header || ciphertext || ROC (big-endian)
        const roc = Buffer.alloc(4)
        roc.writeUInt32BE(s.roc >>> 0, 0)
        const tag = crypto.createHmac("sha1", s.authKey)
            .update(hdr).update(enc).update(roc)
            .digest()
            .subarray(0, SRTP_AUTH_TAG_LEN)

        return Buffer.concat([hdr, enc, tag])
    }

    /**
     * Lazily derive the per-stream SRTP session keys from the master key/salt,
     * as RFC 3711 §4.3.1 requires (labels 0x00 cipher, 0x01 auth, 0x02 salt).
     */
    _srtpState(isVideo) {
        const slot = isVideo ? "_srtpVideo" : "_srtpAudio"
        if (!this[slot]) {
            this[slot] = {
                key: srtpDeriveSessionKey(this.srtpKey, this.srtpSalt, 0x00, SRTP_MASTER_KEY_LEN),
                authKey: srtpDeriveSessionKey(this.srtpKey, this.srtpSalt, 0x01, SRTP_AUTH_KEY_LEN),
                salt: srtpDeriveSessionKey(this.srtpKey, this.srtpSalt, 0x02, SRTP_MASTER_SALT_LEN),
                roc: 0,
                lastSeq: null,
            }
        }
        return this[slot]
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

        // Opus is a VARIABLE-bitrate frame codec. The old code asked ffmpeg for
        // "-f data" (a raw byte soup) and then cut it into fixed-size chunks
        // computed from the bitrate — which slices through frame boundaries and
        // produces packets no decoder can read. We now ask for Ogg and demux
        // real Opus packets out of it, so each RTP payload is exactly one frame.
        this.ff = spawn("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-re", "-i", input,
            "-vn",
            "-c:a", q.codec,
            "-b:a", String(q.bitrate),
            "-ar", String(q.sampleRate),
            "-ac", String(q.channels),
            "-application", "voip",
            "-frame_duration", String(q.frameDuration),
            "-f", "ogg", "pipe:1",
        ])
        const thisFf = this.ff
        this.ff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:a] ${d}`))
        this.ff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg audio: " + e.message))

        // ts increment per frame on the Opus clock
        const tsInc = Math.round((q.sampleRate * q.frameDuration) / 1000)

        const demux = new OggOpusDemuxer()
        const queue = []
        let ended = false

        // Pace packets at exactly one frame per frameDuration. Sending on the
        // ffmpeg 'data' event (as before) bursts whole read-chunks at once.
        const tick = setInterval(() => {
            const frame = queue.shift()
            if (frame) {
                const pkt = this._packetize(frame, "audio", tsInc)
                this._send(pkt)
            } else if (ended) {
                clearInterval(tick)
                if (this._tick === tick) this._tick = null
                if (this.ff === thisFf && !this.closed) {
                    this.ff = null
                    this.emit("trackEnd", { kind: "audio", skipped: false })
                }
            }
        }, q.frameDuration)
        this._tick = tick

        this.ff.stdout.on("data", (chunk) => {
            for (const p of demux.push(chunk)) queue.push(p)
        })
        this.ff.on("close", (code, signal) => {
            ended = true
            if (signal === "SIGKILL") {
                clearInterval(tick)
                if (this._tick === tick) this._tick = null
                if (this.ff === thisFf && !this.closed) {
                    this.ff = null
                    this.emit("trackEnd", { kind: "audio", skipped: true })
                }
            }
        })
        return this
    }

    /** Send a datagram to the selected peer (handles v4-mapped addressing). */
    _send(pkt) {
        if (!this.selected || this.closed) return
        const dest = this.selected.family === 6
            ? this.selected.ip
            : toV4MappedTarget(normalizeIp(this.selected.ip))
        this.socket.send(pkt, this.selected.port, dest, (err) => {
            if (err) this.logger.debug?.({ err: err.message }, "[call-media] send fail")
        })
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
                this._send(pkt)
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
        // abort an in-flight connect() so its retransmit timer can't outlive us
        if (this._abortConnect) { this._abortConnect(); this._abortConnect = null }
        this._onBindOk = null
        try { this.ff?.kill("SIGKILL") } catch {}
        try { this.vff?.kill("SIGKILL") } catch {}
        try { this.socket.close() } catch {}
        this.emit("closed")
    }
}

/**
 * Minimal streaming Ogg demuxer that yields raw Opus packets.
 *
 * Each RTP payload must be exactly one Opus frame, so we walk Ogg pages,
 * reassemble packets from their segment tables, and drop the two Opus header
 * packets ('OpusHead' / 'OpusTags') which are not media.
 */
class OggOpusDemuxer {
    constructor() {
        this.buf = Buffer.alloc(0)
        this.partial = null
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
        const out = []

        for (;;) {
            if (this.buf.length < 27) break
            // find the next page boundary
            const start = this.buf.indexOf("OggS")
            if (start < 0) {
                // keep a small tail in case 'OggS' straddles two chunks
                this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3))
                break
            }
            if (start > 0) this.buf = this.buf.subarray(start)
            if (this.buf.length < 27) break

            const segCount = this.buf[26]
            const headerLen = 27 + segCount
            if (this.buf.length < headerLen) break

            const table = this.buf.subarray(27, headerLen)
            let bodyLen = 0
            for (let i = 0; i < segCount; i++) bodyLen += table[i]
            if (this.buf.length < headerLen + bodyLen) break

            const body = this.buf.subarray(headerLen, headerLen + bodyLen)
            this.buf = this.buf.subarray(headerLen + bodyLen)

            // rebuild packets: a packet continues while its segments are 255
            let offset = 0
            let acc = this.partial ? [this.partial] : []
            this.partial = null
            for (let i = 0; i < segCount; i++) {
                const len = table[i]
                acc.push(body.subarray(offset, offset + len))
                offset += len
                if (len < 255) {
                    const pkt = acc.length === 1 ? acc[0] : Buffer.concat(acc)
                    acc = []
                    if (pkt.length && !isOpusHeaderPacket(pkt)) out.push(Buffer.from(pkt))
                }
            }
            if (acc.length) this.partial = Buffer.concat(acc)
        }
        return out
    }
}

function isOpusHeaderPacket(pkt) {
    if (pkt.length >= 8) {
        const magic = pkt.subarray(0, 8).toString("latin1")
        if (magic === "OpusHead" || magic === "OpusTags") return true
    }
    return false
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
    extractRelayToken,
    decodeEndpoint,
    OggOpusDemuxer,
    callKdf,
    CALL_KDF_LABELS,
    srtpDeriveSessionKey,
    srtpIv,
    buildBinding,
    parseStun,
    resolveVideoPreset,
    DEFAULT_AUDIO_QUALITY,
    DEFAULT_VIDEO_QUALITY,
}
