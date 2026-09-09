"use strict"

/**
 * call-media.js — WhatsApp call media transport.
 *
 * Part of @alexainc/baileys-mod — https://github.com/Alexainc/baileys-mod
 * Author: hansaka@alexainc (media stack rework)
 *
 * IMPLEMENTS THE REAL WHATSAPP WEB MEDIA PATH (verified against the wacrg
 * protocol spec and purpshell/meowcaller reference implementation):
 *
 *   signaling ──► <relay> block (te2 endpoints, relay <key>, indexed <token>s)
 *   transport  ──► UDP ─► DTLS ─► SCTP ─► pre-negotiated DataChannel ("pre-negotiated", id 0)
 *   session    ──► STUN Allocate (0x0003) + WhatsApp consent ping (0x0801) at 1 Hz
 *   media      ──► RTP (PT 120, 16-byte WARP header, ext profile 0xdebe)
 *                  ─► E2E SRTP (AES-128-CTR, keys = HKDF(callKey, info=participant LID))
 *                  ─► 4-byte WARP MESSAGE-INTEGRITY tag (HMAC-SHA1, SRTP auth key)
 *   control    ──► compound SRTCP SR+SDES every 1500 ms (labels 0x03/0x04/0x05)
 *
 * The old implementation (plain UDP socket + STUN binding checks + SRTP keyed
 * with "hbh srtp key" labels) did not match WhatsApp's transport at all — the
 * relay only speaks DTLS/SCTP/DataChannel, and the E2E SRTP keys are
 * participant-scoped. That is why calls never produced audio.
 *
 * Crypto KATs (srtp/testdata/kats.json from meowcaller) are replayed in
 * tests/call.test.js to pin this implementation byte-for-byte.
 */

const crypto = require("crypto")
const { spawn } = require("child_process")
const { EventEmitter } = require("events")

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUN_MAGIC = 0x2112a442
const STUN_FINGERPRINT_XOR = 0x5354554e
const STUN_XOR_PORT = 0x2112
const STUN_XOR_ADDR = Buffer.from([0x21, 0x12, 0xa4, 0x42])

const STUN_MSG_BINDING_REQUEST = 0x0001
const STUN_MSG_ALLOCATE_REQUEST = 0x0003
const STUN_MSG_BINDING_SUCCESS = 0x0101
const STUN_MSG_ALLOCATE_SUCCESS = 0x0103
const STUN_MSG_ALLOCATE_ERROR = 0x0113
const STUN_MSG_WHATSAPP_PING = 0x0801
const STUN_MSG_WHATSAPP_PONG = 0x0802

const ATTR_MESSAGE_INTEGRITY = 0x0008
const ATTR_FINGERPRINT = 0x8028
const ATTR_RELAY_TOKEN = 0x4000
const ATTR_RECEIVER_SUBSCRIPTIONS = 0x4021
const ATTR_STREAM_DESCRIPTORS = 0x4024
const ATTR_WASM_RELAY_ENDPOINT = 0x0016
const ATTR_SENDER_SUBSCRIPTIONS_V2 = 0x4025
const ATTR_PARTICIPANT_COUNT = 0x805a

/** RTP payload types (WhatsApp). Audio Opus = 120 (121 also accepted on rx). */
const RTP_PT_OPUS = 120
const RTP_PT_APP_DATA = 119
const RTP_PT_H264 = 97
/** WhatsApp RTP extension profile (RFC 8285 one-word form). */
const RTP_EXT_PROFILE = 0xdebe
const RTP_HEADER_SIZE = 16
const RTP_HEADER_DTX_SIZE = 20
const RTP_EXT_DTX_WORD = 0x30010000

/** Audio: Opus, mono, 16 kHz, 60 ms frames (960 samples). */
const AUDIO_SAMPLE_RATE = 16000
const AUDIO_FRAME_SAMPLES = 960
const AUDIO_FRAME_MS = 60

const WARP_MI_TAG_LEN = 4
const SRTCP_AUTH_TAG_LEN = 10

/** Fixed capability blobs (wacrg SIG-01/SIG-04). */
const CAPABILITY_OFFER = Buffer.from([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x13])
const CAPABILITY_PREACCEPT = Buffer.from([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07])

/** The WhatsApp relay DTLS certificate fingerprint used for the synthetic SDP. */
const RELAY_DTLS_FINGERPRINT =
    "F9:CA:0C:98:A3:CC:71:D6:42:CE:5A:E2:53:D2:15:20:D3:1B:BA:D8:57:A4:F0:AF:BE:0B:FB:F3:6B:0C:A0:68"

/** The 9 relay stream slots in the order the allocate must advertise them. */
const RELAY_STREAM_SLOT_WORDS = [0, 1, 4, 2, 3, 5, 7, 8, 6]
/** Slot word for a participant's video SSRC (audio is slot 0). */
const VIDEO_SLOT_WORD = 2
/** Slot word for RTC app-data (reactions etc). */
const APP_DATA_SLOT_WORD = 6
const HBH_FEC_TX_SLOT_WORD = 7
const HBH_FEC_RX_SLOT_WORD = 8

const DEFAULT_AUDIO_QUALITY = {
    codec: "libopus",
    bitrate: "24k",
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    frameDuration: AUDIO_FRAME_MS,
    application: "voip",
}

// ---------------------------------------------------------------------------
// HKDF / AES-CM KDF / E2E SRTP
// ---------------------------------------------------------------------------

/** HKDF-SHA256 (RFC 5869). salt may be empty/undefined. */
function hkdfSha256(salt, ikm, info, length) {
    const prk = crypto.createHmac("sha256", salt && salt.length ? salt : Buffer.alloc(32))
        .update(ikm).digest()
    const infoBuf = Buffer.isBuffer(info) ? info : Buffer.from(String(info))
    const blocks = Math.ceil(length / 32)
    const okm = Buffer.alloc(blocks * 32)
    let prev = Buffer.alloc(0)
    for (let i = 1; i <= blocks; i++) {
        prev = crypto.createHmac("sha256", prk)
            .update(prev).update(infoBuf).update(Buffer.from([i])).digest()
        prev.copy(okm, (i - 1) * 32)
    }
    return okm.subarray(0, length)
}

/** libsrtp AES-CM PRF: IV = masterSalt (14B, label XORed into byte 7) zero-padded to 16. */
function aesCmKdf(masterKey, masterSalt, label, length) {
    const iv = Buffer.alloc(16)
    masterSalt.copy(iv, 0, 0, 14)
    iv[7] ^= label
    const cipher = crypto.createCipheriv("aes-128-ctr", masterKey, iv)
    return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]).subarray(0, length)
}

/** Derive master(46) = key(16)||salt(14)||unused(16) with HKDF(callKey, zeros, participantLid). */
function deriveE2eMaster(callKey, participantLid) {
    return hkdfSha256(Buffer.alloc(32), callKey.subarray(0, 32), Buffer.from(participantLid), 46)
}

/** E2E SRTP session keys from a 46-byte master (labels 0x00/0x01/0x02). */
function e2eKeysFromMaster(master, cipherLabel = 0x00, authLabel = 0x01, saltLabel = 0x02) {
    const masterKey = master.subarray(0, 16)
    const masterSalt = master.subarray(16, 30)
    return {
        cipherKey: aesCmKdf(masterKey, masterSalt, cipherLabel, 16),
        authKey: aesCmKdf(masterKey, masterSalt, authLabel, 20),
        salt: aesCmKdf(masterKey, masterSalt, saltLabel, 14),
    }
}

/** E2E SRTP keys (labels 0/1/2) from callKey for one participant. */
function deriveE2eKeys(callKey, participantLid) {
    return e2eKeysFromMaster(deriveE2eMaster(callKey, participantLid))
}

/** E2E SRTCP keys (labels 3/4/5) from callKey for one participant. */
function deriveE2eSrtcpKeys(callKey, participantLid) {
    return e2eKeysFromMaster(deriveE2eMaster(callKey, participantLid), 0x03, 0x04, 0x05)
}

/**
 * E2E RTP IV: the 14-byte salt right-aligned into 16 bytes (offset 2),
 * SSRC XORed into bytes 4..7, the 48-bit packet index into bytes 8..13.
 * (NOT the RFC 3711 layout — WhatsApp's E2E context differs from HBH.)
 */
function buildE2eRtpIV(salt, ssrc, roc, seq) {
    const iv = Buffer.alloc(16)
    const off = 14 - salt.length
    salt.copy(iv, off, 0, salt.length)
    iv[4] ^= (ssrc >>> 24) & 0xff
    iv[5] ^= (ssrc >>> 16) & 0xff
    iv[6] ^= (ssrc >>> 8) & 0xff
    iv[7] ^= ssrc & 0xff
    const packetIndex = roc * 0x10000 + seq
    const hi16 = (packetIndex / 0x100000000) & 0xffff
    const lo32 = packetIndex >>> 0
    iv[8] ^= (hi16 >>> 8) & 0xff
    iv[9] ^= hi16 & 0xff
    iv[10] ^= (lo32 >>> 24) & 0xff
    iv[11] ^= (lo32 >>> 16) & 0xff
    iv[12] ^= (lo32 >>> 8) & 0xff
    iv[13] ^= lo32 & 0xff
    return iv
}

/** AES-128-CTR over the RTP payload (symmetric). */
function cryptPayload(keys, ssrc, seq, roc, payload) {
    const iv = buildE2eRtpIV(keys.salt, ssrc, roc, seq)
    const cipher = crypto.createCipheriv("aes-128-ctr", keys.cipherKey, iv)
    return Buffer.concat([cipher.update(payload), cipher.final()])
}

/** 4-byte WARP MESSAGE-INTEGRITY tag: HMAC-SHA1(authKey, packet || roc_be32)[0..4]. */
function computeWarpMITag(authKey, packetWithoutTag, roc, tagLen = WARP_MI_TAG_LEN) {
    const rocBuf = Buffer.alloc(4)
    rocBuf.writeUInt32BE(roc >>> 0, 0)
    return crypto.createHmac("sha1", authKey)
        .update(packetWithoutTag).update(rocBuf).digest().subarray(0, tagLen)
}

// ---------------------------------------------------------------------------
// Participant IDs & SSRC derivation
// ---------------------------------------------------------------------------

/** Normalize a JID into the E2E-SRTP participant id (device-qualified LID). */
function formatParticipantId(jid) {
    if (typeof jid !== "string") return ""
    let bare = String(jid).split("/")[0].trim()
    if (!bare) return ""
    if (!bare.includes("@") || bare.startsWith("@")) return bare
    const at = bare.lastIndexOf("@")
    const user = bare.slice(0, at)
    const domain = bare.slice(at + 1)
    if (user.includes(":")) return bare
    if (domain === "lid") return `${user}:0@${domain}`
    return bare
}

/** Candidate participant ids to try on the receive path (bare + qualified). */
function participantIdVariants(jid) {
    const out = []
    const seen = new Set()
    const push = (s) => {
        const t = String(s || "").trim()
        if (t && !seen.has(t)) { seen.add(t); out.push(t) }
    }
    if (typeof jid !== "string") return out
    const bare = jid.split("/")[0].trim()
    push(bare)
    push(formatParticipantId(jid))
    const at = bare.lastIndexOf("@")
    if (at > 0) {
        const user = bare.slice(0, at)
        const domain = bare.slice(at + 1)
        if (domain === "lid" && user.includes(":")) {
            const base = user.split(":")[0]
            push(`${base}:0@${domain}`)
            push(`${base}@${domain}`)
        }
    }
    return out
}

/**
 * Deterministic per-participant/stream SSRC:
 * HKDF-SHA256(salt = slotWord LE32, ikm = callId, info = participantLid, 4), read LE.
 */
function deriveParticipantSsrc(callId, participantLid, slotWord) {
    const salt = Buffer.alloc(4)
    salt.writeUInt32LE(slotWord >>> 0, 0)
    const okm = hkdfSha256(salt, Buffer.from(callId), Buffer.from(participantLid), 4)
    return okm.readUInt32LE(0)
}

/** All 9 relay stream SSRCs in slot order. */
function deriveRelayStreamSsrcs(callId, participantLid) {
    return RELAY_STREAM_SLOT_WORDS.map((slot) => deriveParticipantSsrc(callId, participantLid, slot))
}

/** Randomize the 3 auxiliary (video-ish) slots 6..8, keeping uniqueness. */
function prepareRelayStreamSsrcs(ssrcs) {
    const used = new Set(ssrcs.slice(0, 6).filter((s) => s !== 0))
    const out = ssrcs.slice()
    for (let i = 6; i < out.length; i++) {
        for (let attempt = 0; attempt < 64; attempt++) {
            const candidate = crypto.randomBytes(4).readUInt32LE(0)
            if (candidate === 0 || used.has(candidate)) continue
            out[i] = candidate
            used.add(candidate)
            break
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Minimal protobuf writer (uvarint / length-delimited)
// ---------------------------------------------------------------------------

function uvarintBuf(n) {
    const out = []
    let v = n
    do {
        let b = v & 0x7f
        v = Math.floor(v / 128)
        if (v > 0) b |= 0x80
        out.push(b)
    } while (v > 0)
    return Buffer.from(out)
}

function pbVarint(field, value) {
    return Buffer.concat([Buffer.from([(field << 3) | 0]), uvarintBuf(value)])
}

function pbLenDelim(field, value) {
    const v = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([Buffer.from([(field << 3) | 2]), uvarintBuf(v.length), v])
}

// ---------------------------------------------------------------------------
// STUN
// ---------------------------------------------------------------------------

function stunPad4(n) {
    return (4 - (n % 4)) % 4
}

function stunAttr(type, value) {
    const pad = stunPad4(value.length)
    const h = Buffer.alloc(4)
    h.writeUInt16BE(type, 0)
    h.writeUInt16BE(value.length, 2)
    return Buffer.concat([h, value, Buffer.alloc(pad)])
}

function stunPseudoHeader(msgType, msgLen, txId) {
    const h = Buffer.alloc(20)
    h.writeUInt16BE(msgType, 0)
    h.writeUInt16BE(msgLen, 2)
    h.writeUInt32BE(STUN_MAGIC, 4)
    txId.copy(h, 8)
    return h
}

/**
 * Encode a STUN message: header + attrs, optional MESSAGE-INTEGRITY
 * (HMAC-SHA1 over pseudo-header + attrs) and optional FINGERPRINT (CRC-32).
 */
function encodeStunRequest(msgType, txId, attrs, integrityKey, includeFingerprint) {
    let body = Buffer.from(attrs)
    if (integrityKey) {
        const msgLen = body.length + 24
        const mac = crypto.createHmac("sha1", integrityKey)
            .update(stunPseudoHeader(msgType, msgLen, txId)).update(body).digest()
        body = Buffer.concat([body, stunAttr(ATTR_MESSAGE_INTEGRITY, mac)])
    }
    if (includeFingerprint) {
        const msgLen = body.length + 8
        const crcInput = Buffer.concat([stunPseudoHeader(msgType, msgLen, txId), body])
        const fp = (crc32(crcInput) ^ STUN_FINGERPRINT_XOR) >>> 0
        const fpb = Buffer.alloc(4)
        fpb.writeUInt32BE(fp, 0)
        body = Buffer.concat([body, stunAttr(ATTR_FINGERPRINT, fpb)])
    }
    const out = Buffer.alloc(20 + body.length)
    out.writeUInt16BE(msgType, 0)
    out.writeUInt16BE(body.length, 2)
    out.writeUInt32BE(STUN_MAGIC, 4)
    txId.copy(out, 8)
    body.copy(out, 20)
    return out
}

/** CRC-32 (reflected IEEE, i.e. zlib's). */
function crc32(buf) {
    let c
    const table = crc32._table || (crc32._table = (() => {
        const t = new Uint32Array(256)
        for (let n = 0; n < 256; n++) {
            c = n
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
            t[n] = c >>> 0
        }
        return t
    })())
    c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function stunMessageType(data) {
    if (!data || data.length < 2 || (data[0] & 0xc0) !== 0) return null
    return data.readUInt16BE(0)
}

function stunTransactionID(data) {
    if (!data || data.length < 20) return null
    if (data.readUInt32BE(4) !== STUN_MAGIC) return null
    return Buffer.from(data.subarray(8, 20))
}

/** XOR-encode an IPv4:port into the 6-byte STUN form. */
function encodeXorRelayEndpoint(ipv4, port) {
    const octets = String(ipv4).split(".").map(Number)
    if (octets.length !== 4 || octets.some((n) => !(n >= 0 && n <= 255))) return null
    const buf = Buffer.alloc(6)
    buf.writeUInt16BE((port ^ STUN_XOR_PORT) & 0xffff, 0)
    for (let i = 0; i < 4; i++) buf[2 + i] = octets[i] ^ STUN_XOR_ADDR[i]
    return buf
}

/** The WASM attr 0x0016 value: 00 01 + 6-byte XOR endpoint. */
function wasmRelayEndpointAttr(endpointXor) {
    const buf = Buffer.alloc(8)
    buf.writeUInt16BE(1, 0)
    endpointXor.copy(buf, 2)
    return buf
}

/** The 9-SSRC stream-descriptor protobuf (attr 0x4024). */
function createWasmStreamDescriptors(streamSsrcs, hbhFecSsrcs = []) {
    const plan = [
        [0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2],
    ]
    const parts = []
    for (let i = 0; i < streamSsrcs.length; i++) {
        const ssrc = streamSsrcs[i]
        if (!ssrc) continue
        const [participant, layer] = plan[i] || [0, 0]
        let inner = Buffer.alloc(0)
        if (participant) inner = Buffer.concat([inner, pbVarint(1, participant)])
        if (layer) inner = Buffer.concat([inner, pbVarint(2, layer)])
        inner = Buffer.concat([inner, pbVarint(3, ssrc)])
        parts.push(pbLenDelim(1, inner))
    }
    for (let i = 0; i < hbhFecSsrcs.length; i++) {
        const ssrc = hbhFecSsrcs[i]
        if (!ssrc) continue
        let inner = pbVarint(1, i + 3)
        inner = Buffer.concat([inner, pbVarint(2, 3), pbVarint(3, ssrc)])
        parts.push(pbLenDelim(1, inner))
    }
    return Buffer.concat(parts)
}

function createWasmSenderSubscription(ssrcs, participantPids, video) {
    let packed = Buffer.alloc(0)
    for (const ssrc of ssrcs) {
        if (ssrc) packed = Buffer.concat([packed, uvarintBuf(ssrc)])
    }
    let subscription = pbLenDelim(1, packed)
    for (const pid of participantPids) {
        let participant = pbVarint(1, pid)
        if (video) participant = Buffer.concat([participant, pbVarint(2, 1)])
        subscription = Buffer.concat([subscription, pbLenDelim(2, participant)])
    }
    return pbLenDelim(1, pbLenDelim(1, subscription))
}

function createWasmGroupSenderSubscriptions(streamSsrcs, appDataSsrc, pids) {
    return Buffer.concat([
        createWasmSenderSubscription(streamSsrcs.slice(3, 6), pids, true),
        createWasmSenderSubscription(streamSsrcs.slice(6, 9), [], false),
        createWasmSenderSubscription(streamSsrcs.slice(0, 3), pids, false),
        createWasmSenderSubscription([appDataSsrc], pids, false),
    ])
}

function createWasmGroupReceiverSubscriptions(pids) {
    let out = Buffer.alloc(0)
    for (const pid of pids) {
        out = Buffer.concat([out, pbLenDelim(2, pbVarint(1, pid))])
    }
    return out
}

/**
 * The WASM/Web DataChannel Allocate request:
 *   0x4000 relay token + [0x4025/0x4021 group subscriptions] + 0x4024 stream
 *   descriptors + 0x0016 XOR endpoint + MESSAGE-INTEGRITY (relay key ASCII).
 */
function buildWasmAllocateRequest(txId, relayToken, endpointXor, streamSsrcs, integrityKey, opts = {}) {
    const attrs = [stunAttr(ATTR_RELAY_TOKEN, relayToken)]
    const pids = [...new Set((opts.participantPids || []).filter((p) => Number.isFinite(p)))].sort((a, b) => a - b)

    if (pids.length > 0) {
        const descriptors = pids.length > 1 && opts.hbhFecSsrcs
            ? createWasmStreamDescriptors(streamSsrcs, opts.hbhFecSsrcs)
            : createWasmStreamDescriptors(streamSsrcs)
        attrs.push(stunAttr(ATTR_SENDER_SUBSCRIPTIONS_V2,
            createWasmGroupSenderSubscriptions(streamSsrcs, opts.appDataSsrc || 0, pids)))
        attrs.push(stunAttr(ATTR_RECEIVER_SUBSCRIPTIONS,
            createWasmGroupReceiverSubscriptions(pids)))
        attrs.push(stunAttr(ATTR_STREAM_DESCRIPTORS, descriptors))
        attrs.push(stunAttr(ATTR_PARTICIPANT_COUNT, uvarintBuf(pids.length)))
    } else {
        attrs.push(stunAttr(ATTR_STREAM_DESCRIPTORS, createWasmStreamDescriptors(streamSsrcs)))
    }
    attrs.push(stunAttr(ATTR_WASM_RELAY_ENDPOINT, wasmRelayEndpointAttr(endpointXor)))
    return encodeStunRequest(STUN_MSG_ALLOCATE_REQUEST, txId, Buffer.concat(attrs), integrityKey, false)
}

/** WhatsApp consent ping: type 0x0801, 20-byte header, empty body. */
function buildWhatsappPing() {
    const out = Buffer.alloc(20)
    out.writeUInt16BE(STUN_MSG_WHATSAPP_PING, 0)
    out.writeUInt32BE(STUN_MAGIC, 4)
    crypto.randomBytes(12).copy(out, 8)
    return out
}

/** Binding-success reply to a relay binding request (MI + FINGERPRINT). */
function buildBindingSuccess(request, integrityKey) {
    const mt = stunMessageType(request)
    if (mt !== STUN_MSG_BINDING_REQUEST || !integrityKey || !integrityKey.length) return null
    const txId = stunTransactionID(request)
    if (!txId) return null
    return encodeStunRequest(STUN_MSG_BINDING_SUCCESS, txId, Buffer.alloc(0), integrityKey, true)
}

// ---------------------------------------------------------------------------
// RTP framing (WhatsApp 16/20-byte WARP headers)
// ---------------------------------------------------------------------------

const OPUS_PRIMING_FRAME_1 = Buffer.from([
    0x12, 0x36, 0x26, 0x2b, 0x4a, 0xc8, 0x2b, 0x09, 0xc9, 0x1f, 0x34, 0xc2, 0xd6, 0x7a, 0x01, 0x73, 0x1b, 0x2e,
])
const OPUS_PRIMING_FRAME_2 = Buffer.from([0x90, 0xb8, 0x14, 0x14, 0xc4])

function isOpusDtxPayload(payload) {
    if (!payload || !payload.length) return false
    if (payload.length === 1) {
        const b = payload[0]
        return b === 0x10 || b === 0x88 || b === 0x90
    }
    if (payload.length > 15) return false
    const b0 = payload[0]
    if ((b0 & 0xf8) === 0x08 || b0 === 0x0a) return true
    return (b0 & 0xf0) === 0x30 && payload.length <= 6
}

function isOpusPrimingPayload(payload) {
    return !!payload && (payload.equals(OPUS_PRIMING_FRAME_1) || payload.equals(OPUS_PRIMING_FRAME_2))
}

/** Total RTP header length (12 + CSRC + extension); null if malformed. */
function rtpHeaderByteLength(data) {
    if (!data || data.length < 12) return null
    if ((data[0] >> 6) !== 2) return null
    const cc = data[0] & 0x0f
    let headerLen = 12 + cc * 4
    if (data.length < headerLen) return null
    if ((data[0] >> 4) & 1) {
        if (data.length < headerLen + 4) return null
        const extWords = (data[headerLen + 2] << 8) | data[headerLen + 3]
        headerLen += 4 + extWords * 4
        if (data.length < headerLen) return null
    }
    return headerLen
}

function parseRtpHeader(data) {
    const len = rtpHeaderByteLength(data)
    if (len === null) return null
    return {
        marker: ((data[1] >> 7) & 1) === 1,
        payloadType: data[1] & 0x7f,
        sequenceNumber: data.readUInt16BE(2),
        timestamp: data.readUInt32BE(4),
        ssrc: data.readUInt32BE(8),
        headerLength: len,
    }
}

/** Encode a WhatsApp RTP header: 16-byte speech (ext len 0) or 20-byte DTX/piggyback. */
function encodeRtpHeader({ marker, payloadType, sequenceNumber, timestamp, ssrc, extensionWord }) {
    const size = extensionWord !== undefined && extensionWord !== null ? RTP_HEADER_DTX_SIZE : RTP_HEADER_SIZE
    const buf = Buffer.alloc(size)
    buf[0] = 0x80 | 0x10 // V=2, X=1 (the 0xdebe extension is always present)
    buf[1] = (payloadType & 0x7f) | (marker ? 0x80 : 0)
    buf.writeUInt16BE(sequenceNumber & 0xffff, 2)
    buf.writeUInt32BE(timestamp >>> 0, 4)
    buf.writeUInt32BE(ssrc >>> 0, 8)
    buf.writeUInt16BE(RTP_EXT_PROFILE, 12)
    if (size === RTP_HEADER_DTX_SIZE) {
        buf.writeUInt16BE(1, 14) // 1 extension word
        buf.writeUInt32BE(extensionWord >>> 0, 16)
    } else {
        buf.writeUInt16BE(0, 14) // 0 extension words
    }
    return buf
}

/** Send-side RTP sequencer: seq starts at 1, ts at 0, +samplesPerPacket. */
class RtpStream {
    constructor(ssrc, samplesPerPacket, warpPiggyback = false) {
        this.ssrc = ssrc
        this.samplesPerPacket = samplesPerPacket
        this.warpPiggyback = warpPiggyback
        this.seq = 1
        this.timestamp = 0
        this.speechStarted = false
        this.audioPacketIndex = 0
    }

    nextPacket(payload, marker = false) {
        const dtx = isOpusDtxPayload(payload)
        const priming = isOpusPrimingPayload(payload)
        const speech = !dtx && !priming
        const useMarker = marker || (speech && !this.speechStarted)
        if (speech) this.speechStarted = true

        let extensionWord = null
        if (dtx) {
            extensionWord = RTP_EXT_DTX_WORD
        } else if (this.warpPiggyback && this.audioPacketIndex >= 2) {
            extensionWord = 0x30010000
        }
        this.audioPacketIndex++

        const header = {
            marker: useMarker,
            payloadType: RTP_PT_OPUS,
            sequenceNumber: this.seq,
            timestamp: this.timestamp,
            ssrc: this.ssrc,
            extensionWord,
        }
        this.seq = (this.seq + 1) & 0xffff
        this.timestamp = (this.timestamp + this.samplesPerPacket) >>> 0
        return header
    }
}

// ---------------------------------------------------------------------------
// ROC trackers
// ---------------------------------------------------------------------------

/** Send-side ROC: bumps on the 0xFFFF→0x0000 wrap. */
class SendRocTracker {
    constructor() { this.roc = 0; this.lastSeq = null }

    advance(seq) {
        if (this.lastSeq === null) {
            this.lastSeq = seq
            return this.roc
        }
        if (((seq - this.lastSeq) | 0) < -32768) this.roc = (this.roc + 1) >>> 0
        this.lastSeq = seq
        return this.roc
    }
}

/** Receive-side ROC estimator (RFC 3711 §3.3.1 guess-index). */
class RecvRocTracker {
    constructor() { this.roc = 0; this.sL = 0; this.initialized = false }

    estimateRoc(seq) {
        if (!this.initialized) return this.roc
        if (this.sL < 0x8000) {
            return ((seq - this.sL) | 0) > 0x8000 ? (this.roc - 1) >>> 0 : this.roc
        }
        return ((this.sL - seq) | 0) > 0x8000 ? (this.roc + 1) >>> 0 : this.roc
    }

    commitRoc(v, seq) {
        if (!this.initialized) {
            this.sL = seq
            this.initialized = true
            return
        }
        if (v === this.roc) {
            if (seq > this.sL) this.sL = seq
        } else if (v === (this.roc + 1) >>> 0) {
            this.roc = v
            this.sL = seq
        }
    }
}

// ---------------------------------------------------------------------------
// RTCP (compound SR + SDES, SRTCP-protected)
// ---------------------------------------------------------------------------

function buildWhatsappRtcpCname() {
    const entropy = crypto.randomBytes(12)
    const hexChars = "0123456789abcdef"
    const randomHex = Buffer.alloc(11)
    for (let i = 0; i < 11; i++) {
        const b = entropy[6 + (i >> 1)]
        randomHex[i] = Buffer.from(hexChars[(i & 1) ? (b & 0x0f) : (b >> 4)])[0]
    }
    const cname = Buffer.alloc(18)
    randomHex.copy(cname, 0, 0, 5)
    cname.write("@pj", 5)
    randomHex.copy(cname, 8, 5)
    cname.write(".org", 14)
    return cname
}

/** 28-byte RTCP Sender Report (V=2, RC=0, PT=200). */
function buildSenderReport(localSsrc, stats, nowMs) {
    const buf = Buffer.alloc(28)
    buf[0] = 0x80
    buf[1] = 200 // PT=SR
    buf[3] = 6
    buf.writeUInt32BE(localSsrc >>> 0, 4)
    const ntpSec = ((nowMs / 1000) + 2208988800) >>> 0
    const ntpFrac = Math.floor(((nowMs % 1000) / 1000.0) * 4294967296.0) >>> 0
    buf.writeUInt32BE(ntpSec, 8)
    buf.writeUInt32BE(ntpFrac, 12)
    buf.writeUInt32BE((stats.rtpTimestamp || 0) >>> 0, 16)
    buf.writeUInt32BE((stats.packetsSent || 0) >>> 0, 20)
    buf.writeUInt32BE((stats.octetsSent || 0) >>> 0, 24)
    return buf
}

/** 32-byte RTCP SDES with the WhatsApp CNAME. */
function buildSourceDescription(localSsrc, cname) {
    const packet = Buffer.alloc(32)
    packet[0] = 0x81
    packet[1] = 202 // PT=SDES
    packet.writeUInt16BE(7, 2)
    packet.writeUInt32BE(localSsrc >>> 0, 4)
    packet[8] = 1
    packet[9] = 18
    cname.copy(packet, 10)
    return packet
}

/** SRTCP-protect one RTCP packet (RFC 3711-style, E2E labels 3/4/5). */
function protectSrtcp(keys, senderSsrc, index, rtcp) {
    const split = Math.min(rtcp.length, 8)
    let out = Buffer.from(rtcp.subarray(0, split))
    const body = cryptPayload(keys, senderSsrc, index & 0xffff, index >>> 16, rtcp.subarray(split))
    out = Buffer.concat([out, body])
    const indexWord = Buffer.alloc(4)
    indexWord.writeUInt32BE((0x80000000 | index) >>> 0, 0)
    out = Buffer.concat([out, indexWord])
    const mac = crypto.createHmac("sha1", keys.authKey).update(out).digest().subarray(0, SRTCP_AUTH_TAG_LEN)
    return Buffer.concat([out, mac])
}

// ---------------------------------------------------------------------------
// Relay packet classification / group forwarding
// ---------------------------------------------------------------------------

const RELAY_PACKET_STUN = 0
const RELAY_PACKET_RTCP = 1
const RELAY_PACKET_RTP = 2
const RELAY_PACKET_OTHER = 3

function classifyRelayPacket(data) {
    if (!data || data.length < 2) return RELAY_PACKET_OTHER
    const first = data[0]
    if (first & 0xc0) {
        if (data[1] >= 192 && data[1] <= 223) return RELAY_PACKET_RTCP
        if (first >> 6 === 2) return RELAY_PACKET_RTP
        return RELAY_PACKET_OTHER
    }
    return RELAY_PACKET_STUN
}

/** Strip the multi-participant group forwarding header (leading 0x09). */
function unwrapGroupForwardingPacket(data) {
    if (!data || !data.length || data[0] !== 0x09) return { payload: data, wrapped: false, valid: true }
    if (data.length < 2) return { payload: null, wrapped: true, valid: false }
    let headerBytes
    switch (data[1]) {
        case 2: headerBytes = 8; break
        case 4: headerBytes = 12; break
        case 7: headerBytes = 18; break
        default: return { payload: null, wrapped: true, valid: false }
    }
    if (data.length < headerBytes + 12 || data[headerBytes] >> 6 !== 2) {
        return { payload: null, wrapped: true, valid: false }
    }
    return { payload: data.subarray(headerBytes), wrapped: true, valid: true }
}

// ---------------------------------------------------------------------------
// Ogg Opus demuxer (ffmpeg → Ogg → one RTP payload per Opus frame)
// ---------------------------------------------------------------------------

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
            const start = this.buf.indexOf("OggS")
            if (start < 0) {
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

// ---------------------------------------------------------------------------
// WACallMediaSession — the live media engine
// ---------------------------------------------------------------------------

/**
 * One live call media session over the WhatsApp relay.
 *
 * relay: {
 *   key: Buffer        — the <relay><key> ASCII (STUN MESSAGE-INTEGRITY key)
 *   tokens: Buffer[]   — indexed <token> table
 *   endpoints: [{ relayId, relayName, tokenId, authTokenId, isFna, ip, port, raw6 }]
 *   peerJid?: string   — from <participant pid=peer_pid>
 * }
 */
class WACallMediaSession extends EventEmitter {
    constructor({ callId, callKey, relay, selfLid, peerLid, logger, inbound = false, group = false }) {
        super()
        this.callId = callId
        this.callKey = Buffer.from(callKey)
        this.relay = relay
        this.selfLid = selfLid
        this.peerLid = peerLid || relay?.peerJid || ""
        this.logger = logger || console
        this.inbound = inbound
        this.group = group
        this.closed = false
        this.connected = false

        this.selfParticipantId = formatParticipantId(this.selfLid)
        // receive: try the peer LID and its variants
        this._recvCandidates = participantIdVariants(this.peerLid)

        // derived SSRCs
        this.ssrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, 0)
        this.videoSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, VIDEO_SLOT_WORD)
        this.appDataSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, APP_DATA_SLOT_WORD)
        this.hbhFecTxSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, HBH_FEC_TX_SLOT_WORD)
        this.hbhFecRxSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, HBH_FEC_RX_SLOT_WORD)
        this.streamSsrcs = prepareRelayStreamSsrcs(deriveRelayStreamSsrcs(this.callId, this.selfParticipantId))

        // media pipelines
        this._installSendKeys(deriveE2eKeys(this.callKey, this.selfParticipantId))
        this._installRecvKeys(this._recvCandidates[0] || this.selfParticipantId)

        this.stream = new RtpStream(this.ssrc, AUDIO_FRAME_SAMPLES, false)
        this.sendRoc = new SendRocTracker()
        this.srtcpIndex = 1
        this.cname = buildWhatsappRtcpCname()
        this.stats = { packetsSent: 0, octetsSent: 0, rtpTimestamp: 0 }
        this.rxCount = 0
        this.txCount = 0

        // audio source (ffmpeg). Defaults to generated silence so the relay
        // always sees our stream (it will not bridge until it sees RTP).
        this._ff = null
        this._ffInput = null
        this._demuxer = null
        this._frameQueue = []
        this._trackEnded = false
        this._sendTimer = null
        this._keepaliveTimer = null
        this._rtcpTimer = null
        this._groupPids = []
    }

    _installSendKeys(keys) {
        this.sendKeys = keys
        this.sendSrtcpKeys = deriveE2eSrtcpKeys(this.callKey, this.selfParticipantId)
    }

    _installRecvKeys(participantId, preserveRoc = false) {
        this.recvKeys = deriveE2eKeys(this.callKey, participantId)
        if (!preserveRoc) this.recvRoc = new RecvRocTracker()
    }

    /** Rekey the receive path (e.g. the call was answered on another device). */
    rekeyRecv(callKey, peerJid) {
        this.callKey = Buffer.from(callKey)
        this._installRecvKeys(formatParticipantId(peerJid), true)
    }

    /** Install a group epoch (raw 32-byte key) into send + recv pipelines. */
    installEpoch(rawKey) {
        this.callKey = Buffer.from(rawKey)
        if (this.callKey.length !== 32) throw new Error("epoch must be 32 bytes")
        this._installSendKeys(deriveE2eKeys(this.callKey, this.selfParticipantId))
        this._installRecvKeys(this._recvCandidates[0] || this.selfParticipantId, true)
    }

    setGroupPids(pids) {
        this._groupPids = [...new Set((pids || []).filter((p) => Number.isFinite(p)))]
    }

    // ------------------------------------------------------------------
    // Transport: RTCPeerConnection + synthetic remote SDP toward the relay
    // ------------------------------------------------------------------

    _pickEndpoint() {
        const eps = this.relay?.endpoints || []
        if (this.inbound) {
            const fna = eps.find((e) => e.isFna)
            if (fna) return fna
        }
        return eps.find((e) => !e.isFna && e.authTokenId !== 0)
            || eps.find((e) => !e.isFna)
            || eps[0]
    }

    async _openRelayChannel(endpoint, timeoutMs = 15000) {
        let wrtc
        try {
            wrtc = require("@roamhq/wrtc")
        } catch (err) {
            throw new Error(
                "call media requires the @roamhq/wrtc package (WebRTC data channels to the WhatsApp relay). " +
                "Install it with: npm install @roamhq/wrtc"
            )
        }

        const pc = new wrtc.RTCPeerConnection()
        const dc = pc.createDataChannel("pre-negotiated", {
            negotiated: true,
            id: 0,
            ordered: false,
            maxRetransmits: 0,
            priority: "high",
        })
        dc.binaryType = "arraybuffer"

        const token = this.relay?.tokens?.[endpoint.tokenId] || this.relay?.tokens?.[0] || Buffer.alloc(0)
        let iceUfrag = token.length ? token.toString("base64").replace(/=+$/, "") : "calltoken"
        if (iceUfrag.length < 4) iceUfrag = (iceUfrag + "AAAAAAAA").slice(0, 8)
        iceUfrag = iceUfrag.slice(0, 32)
        let icePwd = this.relay?.key?.length ? this.relay.key.toString("utf8") : "relaykey"
        if (icePwd.length < 22) {
            // libjuice enforces pwd >= 22 chars; stretch short keys via base64
            icePwd = Buffer.from(icePwd, "utf8").toString("base64")
            while (icePwd.length < 22) icePwd += icePwd
            icePwd = icePwd.slice(0, 32)
        }

        const opened = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("relay DataChannel open timed out (DTLS failed)")), timeoutMs)
            dc.onopen = () => { clearTimeout(timer); resolve() }
            dc.onerror = (e) => { clearTimeout(timer); reject(new Error("relay DataChannel error: " + (e?.error?.message || e?.message || "unknown"))) }
            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === "failed") {
                    clearTimeout(timer)
                    reject(new Error("ICE toward relay failed"))
                }
            }
        })

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        // Synthetic remote answer describing the relay as a passive DTLS peer
        // with a host candidate at its public endpoint (the relay never sees
        // this SDP — it only configures the local stack).
        let answer = offer.sdp
            .replace(/a=setup:actpass/g, "a=setup:passive")
            .replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${iceUfrag}`)
            .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${icePwd}`)
            .replace(/a=fingerprint:[^\r\n]+/g, `a=fingerprint:sha-256 ${RELAY_DTLS_FINGERPRINT}`)
            .replace(/a=ice-options:[^\r\n]+\r?\n/g, "")
            .replace(/a=max-message-size:[^\r\n]+/g, "a=max-message-size:1200")
            .replace(/a=candidate:[^\r\n]+\r?\n/g, "")
            .replace(/a=end-of-candidates\r?\n?/g, "")
        const candidate = `a=candidate:2 1 udp 2122262783 ${endpoint.ip} ${endpoint.port} typ host generation 0 network-cost 5`
        answer = `${answer}${candidate}\r\na=end-of-candidates\r\n`

        await pc.setRemoteDescription({ type: "answer", sdp: answer })
        await opened

        return { pc, dc }
    }

    // ------------------------------------------------------------------
    // Outbound protect: RTP header → E2E SRTP → WARP MI tag
    // ------------------------------------------------------------------

    protectAudio(opusPayload) {
        const header = this.stream.nextPacket(opusPayload)
        const roc = this.sendRoc.advance(header.sequenceNumber)
        let packet = encodeRtpHeader(header)
        const encrypted = cryptPayload(this.sendKeys, header.ssrc, header.sequenceNumber, roc, opusPayload)
        packet = Buffer.concat([packet, encrypted])
        const tag = computeWarpMITag(this.sendKeys.authKey, packet, roc, WARP_MI_TAG_LEN)
        this.stats.packetsSent++
        this.stats.octetsSent += opusPayload.length
        this.stats.rtpTimestamp = header.timestamp
        return Buffer.concat([packet, tag])
    }

    // ------------------------------------------------------------------
    // Inbound unprotect: strip tag → parse → decrypt (per peer candidate)
    // ------------------------------------------------------------------

    unprotectRtp(packet) {
        if (!packet || packet.length < 12 + WARP_MI_TAG_LEN) return null
        const tag = packet.subarray(packet.length - WARP_MI_TAG_LEN)
        const body = packet.subarray(0, packet.length - WARP_MI_TAG_LEN)
        const header = parseRtpHeader(body)
        if (!header || header.headerLength >= body.length) return null
        const payload = body.subarray(header.headerLength)

        // try each candidate participant key set; the WARP MI tag tells us which
        this._recvKeysCache = this._recvKeysCache || {}
        this._recvRocs = this._recvRocs || {}
        const candidates = [...this._recvCandidates].filter(Boolean)
        for (const candidate of candidates) {
            if (!this._recvKeysCache[candidate]) this._recvKeysCache[candidate] = deriveE2eKeys(this.callKey, candidate)
            if (!this._recvRocs[candidate]) this._recvRocs[candidate] = new RecvRocTracker()
            const keys = this._recvKeysCache[candidate]
            const roc = this._recvRocs[candidate]
            const estimate = roc.estimateRoc(header.sequenceNumber)
            // tolerate reordering across the seq wrap: try estimate-1..+1
            for (const tryRoc of [estimate, (estimate + 1) >>> 0, (estimate - 1) >>> 0]) {
                const expected = computeWarpMITag(keys.authKey, body, tryRoc, tag.length)
                if (tag.equals(expected)) {
                    roc.commitRoc(tryRoc, header.sequenceNumber)
                    const plain = cryptPayload(keys, header.ssrc, header.sequenceNumber, tryRoc, payload)
                    return { header, payload: plain, participantId: candidate }
                }
            }
        }
        // no candidate verified — fall back to the primary keys (best effort)
        const roc = this.recvRoc.estimateRoc(header.sequenceNumber)
        this.recvRoc.commitRoc(roc, header.sequenceNumber)
        const plain = cryptPayload(this.recvKeys, header.ssrc, header.sequenceNumber, roc, payload)
        return { header, payload: plain, participantId: this._recvCandidates[0] || "?" }
    }

    // ------------------------------------------------------------------
    // connect(): open the relay channel, allocate, and run the media loops
    // ------------------------------------------------------------------

    async connect(opts = {}) {
        if (this.connected) return this
        const endpoint = this._pickEndpoint()
        if (!endpoint) throw new Error("relay has no usable endpoint (no <te2> in the relay block)")

        this.logger.info?.(
            { relay: `${endpoint.relayName || "?"} ${endpoint.ip}:${endpoint.port}`, tokenId: endpoint.tokenId, isFna: !!endpoint.isFna, inbound: this.inbound },
            "[call-media] connecting relay DataChannel"
        )

        const { pc, dc } = await this._openRelayChannel(endpoint, opts.channelTimeoutMs || 15000)
        this.pc = pc
        this.dc = dc
        this.endpoint = endpoint

        dc.onclose = () => this.close()
        dc.onerror = () => { /* logged via pc state */ }

        // STUN allocate + consent ping (BEFORE any RTP)
        this._sendAllocate()
        this._dcSend(buildWhatsappPing())
        this.connected = true
        this.emit("connected", { ip: endpoint.ip, port: endpoint.port, relayName: endpoint.relayName })
        this.logger.info?.({ ssrc: this.ssrc, streamSsrcs: this.streamSsrcs }, "[call-media] relay channel open — allocate sent")

        // 1 Hz keepalive: re-allocate + ping (NO STUN binding-requests — they
        // flip the relay into ICE-consent mode and the bridge never forms)
        this._keepaliveTimer = setInterval(() => {
            if (this.closed) return
            try {
                this._sendAllocate()
                this._dcSend(buildWhatsappPing())
            } catch { /* best effort */ }
        }, 1000)

        // audio: silence until a real source is attached, so the relay always
        // sees our SSRC (it won't bridge the peer's media otherwise)
        if (!this._ffInput) this._startFfmpeg(null)

        // 60 ms send loop
        this._sendTimer = setInterval(() => this._tick(), AUDIO_FRAME_MS)

        // 1500 ms compound SRTCP SR+SDES
        this._rtcpTimer = setInterval(() => {
            if (this.closed || !this.connected) return
            try {
                const sr = buildSenderReport(this.ssrc, this.stats, Date.now())
                const sdes = buildSourceDescription(this.ssrc, this.cname)
                const plain = Buffer.concat([sr, sdes])
                const packet = protectSrtcp(this.sendSrtcpKeys, this.ssrc, this.srtcpIndex++, plain)
                this._dcSend(packet)
            } catch (e) {
                this.logger.debug?.({ err: e?.message }, "[call-media] SRTCP send failed")
            }
        }, 1500)

        // receive loop
        dc.onmessage = (event) => this._onRelayPacket(event.data)

        return this
    }

    _sendAllocate() {
        const endpointXor = encodeXorRelayEndpoint(this.endpoint.ip, this.endpoint.port)
        if (!endpointXor) throw new Error("bad relay endpoint for XOR encode")
        const token = this.relay?.tokens?.[this.endpoint.tokenId] || this.relay?.tokens?.[0]
        if (!token) throw new Error(`no relay token #${this.endpoint.tokenId}`)
        if (!this.relay?.key?.length) throw new Error("relay has no <key>")
        const txId = crypto.randomBytes(12)
        const allocate = buildWasmAllocateRequest(
            txId, token, endpointXor, this.streamSsrcs, this.relay.key,
            {
                participantPids: this.group ? this._groupPids : [],
                appDataSsrc: this.appDataSsrc,
                hbhFecSsrcs: this.group && this._groupPids.length > 1 ? [this.hbhFecTxSsrc, this.hbhFecRxSsrc] : null,
            }
        )
        this._dcSend(allocate)
    }

    _dcSend(data) {
        if (this.closed || !this.dc) return
        try {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
            this.dc.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        } catch (e) {
            this.logger.debug?.({ err: e?.message }, "[call-media] DataChannel send failed")
        }
    }

    _onRelayPacket(data) {
        if (this.closed || !data) return
        const pkt = Buffer.from(data)

        const kind = classifyRelayPacket(pkt)
        if (kind === RELAY_PACKET_STUN) {
            const mt = stunMessageType(pkt)
            if (mt === STUN_MSG_BINDING_REQUEST) {
                // answer the relay's consent-freshness binding request
                const resp = buildBindingSuccess(pkt, this.relay?.key)
                if (resp) this._dcSend(resp)
            } else if (mt === STUN_MSG_ALLOCATE_SUCCESS) {
                this.logger.debug?.("[call-media] relay allocate success")
                this.emit("relay", { event: "allocate-success" })
            } else if (mt === STUN_MSG_ALLOCATE_ERROR) {
                this.logger.warn?.("[call-media] relay allocate ERROR")
                this.emit("relay", { event: "allocate-error" })
            } else if (mt === STUN_MSG_WHATSAPP_PONG) {
                this.emit("relay", { event: "pong" })
            }
            return
        }
        if (kind === RELAY_PACKET_RTCP) {
            this.emit("rtcp", { data: pkt })
            return
        }
        if (kind !== RELAY_PACKET_RTP) return

        // group forwarding header (0x09 …)
        const unwrapped = unwrapGroupForwardingPacket(pkt)
        if (!unwrapped.valid) return
        const media = unwrapped.payload
        if (!media) return

        const result = this.unprotectRtp(media)
        if (!result) return
        this.rxCount++
        this.emit("rtp", {
            header: result.header,
            payload: result.payload,
            participantId: result.participantId,
            groupWrapped: unwrapped.wrapped,
        })
    }

    // ------------------------------------------------------------------
    // Audio source management (ffmpeg → Ogg Opus → frame queue)
    // ------------------------------------------------------------------

    _startFfmpeg(input) {
        this._stopFfmpeg()
        this._ffInput = input
        this._trackEnded = false
        this._frameQueue = []
        this._demuxer = new OggOpusDemuxer()

        const args = input
            ? ["-hide_banner", "-loglevel", "error", "-re", "-i", input]
            // infinite generated silence keeps the stream alive pre-file / post-file
            : ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono"]

        const q = { ...DEFAULT_AUDIO_QUALITY, ...(this._audioQuality || {}) }
        args.push(
            "-vn",
            "-c:a", q.codec,
            "-b:a", String(q.bitrate),
            "-ar", String(q.sampleRate),
            "-ac", String(q.channels),
            "-application", q.application,
            "-frame_duration", String(q.frameDuration),
            "-f", "ogg", "pipe:1",
        )

        this._ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
        const ff = this._ff
        ff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:a] ${d}`))
        ff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg audio: " + e.message))
        ff.stdout.on("data", (chunk) => {
            for (const frame of this._demuxer.push(chunk)) {
                if (this._frameQueue.length < 64) this._frameQueue.push(frame)
            }
        })
        ff.on("close", (code, signal) => {
            if (this._ff !== ff) return
            this._ff = null
            if (input) {
                this._trackEnded = true
                // after a real file ends, keep the stream alive with silence
                if (!this.closed) setTimeout(() => { if (this._ffInput === input) this._startFfmpeg(null) }, 200)
                this.emit("trackEnd", { kind: "audio", skipped: signal === "SIGKILL" })
            }
        })
    }

    _stopFfmpeg() {
        if (this._ff) {
            const ff = this._ff
            this._ff = null
            try { ff.kill("SIGKILL") } catch { /* ignore */ }
        }
    }

    /** Stream an audio file/URL into the call (any input ffmpeg accepts). */
    streamAudio(input, quality = {}) {
        if (!this.connected) throw new Error("not connected; call connect() first")
        this._audioQuality = quality
        this._startFfmpeg(input)
        this.logger.info?.({ input }, "[call-media] streaming audio")
        return this
    }

    /** Stop the current audio track; reverts to silence (stays in the call). */
    stopAudio() {
        this._startFfmpeg(null)
        return this
    }

    _tick() {
        if (this.closed || !this.connected) return
        const frame = this._frameQueue.shift()
        if (!frame) return // silence generator may lag briefly; simply skip
        try {
            const packet = this.protectAudio(frame)
            this._dcSend(packet)
            this.txCount++
            if (this.txCount === 1) {
                this.logger.info?.({ bytes: packet.length }, "[call-media] first RTP sent to relay")
            }
        } catch (e) {
            this.logger.debug?.({ err: e?.message }, "[call-media] protect/send failed")
        }
    }

    close() {
        if (this.closed) return
        this.closed = true
        this.connected = false
        if (this._sendTimer) { clearInterval(this._sendTimer); this._sendTimer = null }
        if (this._keepaliveTimer) { clearInterval(this._keepaliveTimer); this._keepaliveTimer = null }
        if (this._rtcpTimer) { clearInterval(this._rtcpTimer); this._rtcpTimer = null }
        this._stopFfmpeg()
        try { this.dc?.close() } catch { /* ignore */ }
        try { this.pc?.close() } catch { /* ignore */ }
        this.emit("closed")
    }
}

// ---------------------------------------------------------------------------
// Legacy helpers kept for compatibility with the old public API
// ---------------------------------------------------------------------------

/** Decode a packed 6/18-byte WhatsApp endpoint. */
function decodeEndpoint(buf) {
    if (!buf) return null
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    if (b.length === 6) {
        return { ip: `${b[0]}.${b[1]}.${b[2]}.${b[3]}`, port: b.readUInt16BE(4), family: 4 }
    }
    if (b.length === 18) {
        const parts = []
        for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16))
        return { ip: parts.join(":"), port: b.readUInt16BE(16), family: 6 }
    }
    return null
}

/** Legacy: extract te2/rte endpoints from an offer node (see parseRelayBlock for the real path). */
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
        if ((n.tag === "te2" || n.tag === "te" || n.tag === "rte") &&
            (Buffer.isBuffer(n.content) || n.content instanceof Uint8Array)) {
            const ep = decodeEndpoint(n.content)
            if (ep) add({ ...ep, type: n.tag === "rte" ? "srflx" : "relay", relayId: a.relay_id, priority: +(a.priority || a.pref || 0) })
        }
        const ip = a.ip || a.host || a.address || a.addr
        const port = a.port || a.p
        if (ip && port) add({ ip, port: +port, family: String(ip).includes(":") ? 6 : 4, type: a.type || n.tag || "host" })
        if (Array.isArray(n.content)) for (const c of n.content) visit(c)
    }
    visit(offerNode)
    return cands
}

/** Legacy: first <token> blob in a node. */
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

/**
 * Back-compat KDF (kept: exported and used by old tests). HKDF-SHA256 with
 * an optional salt, matching the WA WASM cryptoHkdfExtractWithSaltAndExpand.
 */
function callKdf(callKey, label, len = 32, salt = null) {
    return hkdfSha256(salt && salt.length ? salt : Buffer.alloc(32), callKey, label, len)
}

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

module.exports = {
    // constants
    CAPABILITY_OFFER,
    CAPABILITY_PREACCEPT,
    RELAY_DTLS_FINGERPRINT,
    RTP_PT_OPUS,
    AUDIO_SAMPLE_RATE,
    AUDIO_FRAME_SAMPLES,
    AUDIO_FRAME_MS,
    RELAY_STREAM_SLOT_WORDS,
    // crypto
    hkdfSha256,
    aesCmKdf,
    deriveE2eKeys,
    deriveE2eSrtcpKeys,
    deriveE2eMaster,
    buildE2eRtpIV,
    cryptPayload,
    computeWarpMITag,
    callKdf,
    CALL_KDF_LABELS,
    // participant / ssrc
    formatParticipantId,
    participantIdVariants,
    deriveParticipantSsrc,
    deriveRelayStreamSsrcs,
    prepareRelayStreamSsrcs,
    // stun
    encodeStunRequest,
    stunAttr,
    stunMessageType,
    stunTransactionID,
    encodeXorRelayEndpoint,
    buildWasmAllocateRequest,
    buildWhatsappPing,
    buildBindingSuccess,
    crc32,
    // rtp
    isOpusDtxPayload,
    isOpusPrimingPayload,
    rtpHeaderByteLength,
    parseRtpHeader,
    encodeRtpHeader,
    RtpStream,
    SendRocTracker,
    RecvRocTracker,
    // rtcp
    buildSenderReport,
    buildSourceDescription,
    buildWhatsappRtcpCname,
    protectSrtcp,
    // relay
    classifyRelayPacket,
    unwrapGroupForwardingPacket,
    createWasmStreamDescriptors,
    // demuxer
    OggOpusDemuxer,
    decodeEndpoint,
    // legacy
    extractCandidates,
    extractRelayToken,
    DEFAULT_AUDIO_QUALITY,
    // session
    WACallMediaSession,
}
