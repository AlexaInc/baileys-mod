"use strict"

const fs = require("fs")

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
// Native smpl/MLow encoder CLI (edgardmessias/opus_mlow @84b076e, built in
// the workspace): stdin s16le 16k mono PCM → stdout u16-BE-length-prefixed
// native 60 ms MLow frames (TOC 0x50-family — the real client's own shape).
const MLOWENC_BIN = "/home/user/opus_mlow/mlowenc"
const MLOW_BITRATE = 12000
const RTP_HEADER_SIZE = 16
const RTP_HEADER_DTX_SIZE = 20
const RTP_EXT_DTX_WORD = 0x30010000

/** Audio: Opus CELT, mono, 16 kHz, 60 ms packets (960 samples).
 * ffmpeg encodes 20 ms CELT frames (CELT tops out at 20 ms — required for
 * the MLOW escape); _tick groups triples into ONE 60 ms multiframe packet,
 * matching the negotiated cadence (their MLow client sends 0xbb = config-23
 * code-3 3x20ms multiframes — the same shape — and its receiver paces by
 * 60 ms/960-sample steps). */
const AUDIO_SAMPLE_RATE = 16000
const AUDIO_FRAME_SAMPLES = 960
/** AUDIO_FRAME_MS is the WIRE cadence: one 60 ms packet per tick. */
const AUDIO_FRAME_MS = 60
/** ENCODER_FRAME_MS / FRAMES_PER_PACKET shape what ffmpeg is asked for and
 * how frames map to packets. Captured from the REAL client's stream
 * (2026-09-10 15:53 inbound call dump): WhatsApp "opus" on PT 120 is
 * SILK WB (16 kHz) SINGLE 60 ms frames — TOC 0x58 = config 11, code 0,
 * ~87-102 B, ts step 960, 16-byte header with the 0xdebe stub. A SILK
 * decoder cannot decode the CELT frames (config 23) we used to send —
 * they half-decode as continuous glitching. So: -application voip makes
 * libopus emit SILK, one 60 ms frame per packet, no grouping. (The CELT
 * 20ms→multiframe path remains for a future true-MLow/escape mode.)
 * Do NOT tie ENCODER_FRAME_MS to AUDIO_FRAME_MS blindly: asking CELT
 * (lowdelay) for 60 ms makes ffmpeg emit its own code-3 multiframes. */
const ENCODER_FRAME_MS = 60
const FRAMES_PER_PACKET = 1

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
    bitrate: "16k",
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    frameDuration: ENCODER_FRAME_MS,
    // voip = SILK-only: the REAL WhatsApp client on PT 120 sends SILK WB
    // 16kHz single 60ms frames (captured 2026-09-10: TOC 0x58 = config 11,
    // ~87-102B) and its decoder is a SILK decoder — CELT frames (lowdelay,
    // configs 16-31) half-decode as glitching. Their frames ≈ 12-13 kbps.
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

/**
 * Participant id for OUR OWN key material — ROLE-AWARE (2026-09-10, packet-proven both ways):
 *
 *  • CALLER role (we placed the call): `<lid-user>:0@lid` — the remote web
 *    caller's own SSRCs AND send keys both matched the :0 derivation
 *    (calls 005363AC / 0008C38E: SSRCs 3023015326 / 905952313 = slot0 of
 *    ':0@lid', and its ':30@lid' candidate key FAILED while ':0' verified).
 *
 *  • ANSWERER role (we picked up): OUR REAL DEVICE JID, suffix kept — the
 *    web answerer's SSRC in our outgoing call 272736FC was slot0 of
 *    '78151912841263:30@lid' (its actual device), NOT ':0'; the rust
 *    (session.rs `rekey_recv`) confirms: "a multi-device callee answers
 *    from one device and encrypts under its OWN participant id". Sending
 *    with the :0 key in the answerer role is why the peer could NEVER
 *    decrypt our audio (total one-way silence while our recv verified).
 *
 *  • CALLER role: we announce OUR DEVICE JID as call-creator in the offer
 *    (me.lid, e.g. ':1@lid'), and the rust callee derives the caller's
 *    stream key from call_creator — so the caller also keys under its
 *    real device jid. (The web CALLER keys ':0' — 11:57 proof — while
 *    announcing creator ':30'; but WE control what we announce, and we
 *    announce our device jid, so we key the same jid we announce.)
 *
 * Group calls keep the :0 form (the group epoch model keys on :0 ids).
 */
function selfKeyId(jid, { answerer = false, zeroForm = false } = {}) {
    if (typeof jid !== "string") return ""
    const bare = String(jid).split("/")[0].trim()
    if (!bare) return ""
    if (!bare.includes("@")) return bare
    const at = bare.lastIndexOf("@")
    const user = bare.slice(0, at)
    const domain = bare.slice(at + 1)
    if (user.includes(":")) {
        // [empirical, 2026-09-11] the CALLER sends E2E media keyed under the
        // normalized "<lid>:0@lid" form — the phone's caller-role SRTCP
        // verified under :0@lid — while the ANSWERER keys under its real
        // device suffix (their :30@lid verified on calls we placed). Keying
        // our outbound as caller under the real device produced
        // energy-correct noise at the peer ("scratchy record"): the tag
        // authenticates ciphertext, so a wrong HKDF info decrypts to garbage
        // that still passes auth.
        if (zeroForm) return `${user.split(":")[0]}:0@${domain}`
        return bare
    }
    return `${user}:0@${domain}`
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
    } else if (
        data.length >= headerLen + 4
        && data[headerLen] === (RTP_EXT_PROFILE >> 8)
        && data[headerLen + 1] === (RTP_EXT_PROFILE & 0xff)
    ) {
        // [spec rtp-framing] WhatsApp speech packets use the 16-byte header
        // with X=0 but STILL carry the 0xdebe profile block + length word.
        // Detect that fixed block so the payload offset is 16, not 12.
        const extWords = (data[headerLen + 2] << 8) | data[headerLen + 3]
        if (extWords <= 1 && data.length >= headerLen + 4 + extWords * 4) {
            headerLen += 4 + extWords * 4
        }
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
function encodeRtpHeader({ marker, payloadType, sequenceNumber, timestamp, ssrc, extensionWord, xAlways }) {
    const size = extensionWord !== undefined && extensionWord !== null ? RTP_HEADER_DTX_SIZE : RTP_HEADER_SIZE
    const buf = Buffer.alloc(size)
    // [spec rtp-framing] speech = 16-byte header with X=0; DTX/piggyback =
    // 20-byte header with X=1 + one extension word. X=1 with zero words is a
    // malformed shape real clients never emit — EXCEPT in MLow mode: captured
    // MLow speech packets from real clients carry X=1 with the 16-byte shape
    // (profile stub + 0 extension words). xAlways selects that for MLow peers.
    buf[0] = 0x80 | ((size === RTP_HEADER_DTX_SIZE || xAlways) ? 0x10 : 0x00)
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

/** SRTCP-unprotect one packet (mirror of protectSrtcp). {plain, verified, index, encrypted} or null. */
function unprotectSrtcp(keys, packet) {
    if (!packet || packet.length < 8 + 4 + SRTCP_AUTH_TAG_LEN) return null
    const tag = packet.subarray(packet.length - SRTCP_AUTH_TAG_LEN)
    const body = packet.subarray(0, packet.length - SRTCP_AUTH_TAG_LEN)
    const mac = crypto.createHmac("sha1", keys.authKey).update(body).digest().subarray(0, SRTCP_AUTH_TAG_LEN)
    const verified = tag.equals(mac)
    const word = body.readUInt32BE(body.length - 4)
    const encrypted = !!(word & 0x80000000)
    const index = word & 0x7fffffff
    const senderSsrc = packet.readUInt32BE(4)
    if (!encrypted) {
        // E=0: payload is plaintext; just strip the index word
        return { plain: Buffer.from(body.subarray(0, body.length - 4)), verified, index, encrypted }
    }
    const split = Math.min(body.length - 4, 8)
    const head = Buffer.from(body.subarray(0, split))
    const enc = body.subarray(split, body.length - 4)
    const dec = cryptPayload(keys, senderSsrc, index & 0xffff, index >>> 16, enc)
    return { plain: Buffer.concat([head, dec]), verified, index, encrypted }
}

/** Parse RTCP compound (SR/RR) report blocks — the peer's view of our streams. */
function parseRtcpReportBlocks(plain) {
    const blocks = []
    let off = 0
    try {
        while (off + 8 <= plain.length) {
            const b0 = plain[off]
            if (b0 >> 6 !== 2) break
            const pt = plain[off + 1]
            const rc = b0 & 0x1f
            const pktLen = (((plain[off + 2] << 8) | plain[off + 3]) + 1) * 4
            if (pktLen < 8 || off + pktLen > plain.length) break
            if (pt === 200 || pt === 201) {
                let blockOff = pt === 200 ? off + 28 : off + 8
                for (let i = 0; i < rc && blockOff + 24 <= off + pktLen; i++, blockOff += 24) {
                    blocks.push({
                        ssrc: plain.readUInt32BE(blockOff),
                        fractionLost: plain[blockOff + 4],
                        cumLost: (plain[blockOff + 5] << 16) | (plain[blockOff + 6] << 8) | plain[blockOff + 7],
                        extHighestSeq: plain.readUInt32BE(blockOff + 8),
                        jitter: plain.readUInt32BE(blockOff + 12),
                    })
                }
            }
            off += pktLen
        }
    } catch { /* malformed */ }
    return blocks
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

/**
 * [MOD] MLOW escape (rust packetize_opus_for_mlow, audio.rs): rewrite a
 * standard CELT Opus packet's TOC so an MLOW-profile peer decodes it via the
 * in-profile standard-Opus escape (first byte & 0xC0 == 0xC0). DTX-sized
 * packets become MLOW's single-byte SID token 0x90. Returns null when the
 * packet is not escapable (SILK config or odd packing) — caller sends it raw.
 */
function mlowEscapeOpus(frame) {
    if (!frame || !frame.length) return null
    if (frame.length <= 2) return Buffer.from([0x90])
    const toc = frame[0]
    const config = toc >> 3
    if (config < 16) return null // SILK / hybrid — cannot escape
    const mode = config - 16
    const stereo = (toc >> 2) & 1
    const packing = toc & 0x03
    // [spec mlow-escape, rust packetize_opus_for_mlow] the escape rewrites
    // ONLY the TOC byte — 0xC0 | mode<<2 | stereo<<1 | multi — and leaves the
    // RFC 6716 body (count descriptor, length bytes, frames) untouched. The
    // receiver reverses exactly this (depacketize_opus_from_mlow).
    if (packing === 1) {
        const bodyLen = frame.length - 1
        if (bodyLen === 0 || bodyLen % 2 !== 0) return null
        return Buffer.concat([Buffer.from([0xC0 | (mode << 2) | (stereo << 1) | 1, 0x02]), frame.subarray(1)])
    }
    if (packing === 2) {
        if (!validTwoFrameVbrBody(frame.subarray(1))) return null
        return Buffer.concat([Buffer.from([0xC0 | (mode << 2) | (stereo << 1) | 1, 0x82]), frame.subarray(1)])
    }
    if (packing === 3) {
        const count = frame[1] & 0x3F
        if (count === 0 || count > 48) return null
        return Buffer.concat([Buffer.from([0xC0 | (mode << 2) | (stereo << 1) | 1]), frame.subarray(1)])
    }
    const out = Buffer.from(frame)
    out[0] = 0xC0 | (mode << 2) | (stereo << 1) | 0
    return out
}

/** [spec mlow-escape] rust valid_two_frame_vbr_body — 1-2 byte length + 2 frames. */
function validTwoFrameVbrBody(body) {
    if (!body.length) return false
    const first = body[0]
    let size, fieldLen
    if (first < 252) { size = first; fieldLen = 1 }
    else {
        if (body.length < 2) return false
        size = first + 4 * body[1]; fieldLen = 2
    }
    return size > 0 && body.length - (fieldLen + size) > 0
}

/**
 * [MOD] Group N same-config code-0 CELT frames into ONE opus multiframe
 * packet (RFC 6716 code 3, VBR): [TOC|code3][0x80|N][len1..lenN-1][data...].
 * This is exactly the 60 ms packet shape the MLow client sends (0xbb...).
 * Returns null when a frame needs the >251-byte length escape (not handled).
 */
function buildOpusMultiframe(frames) {
    const usable = frames.filter((f) => f && f.length > 2)
    // Never emit a bare single frame (a 20 ms code-0 single is undecodable for
    // an MLow peer and mislabeled vs the 60 ms ts step for everyone else).
    if (usable.length < 2) return null
    const base = usable[0][0]
    for (const f of usable) {
        if ((f[0] & 0xf8) !== (base & 0xf8)) return null // config mismatch
        // input contract: single (code-0) frames ONLY — a code-3 input is
        // already a multiframe; wrapping it again would nest garbage.
        if ((f[0] & 0x03) !== 0) return null
    }
    const toc = (base & 0xf8) | 0x03
    const stereo = (base >> 2) & 1
    const datas = usable.map((f) => f.subarray(1))
    const parts = [Buffer.from([toc | (stereo << 2), 0x80 | usable.length])]
    for (let i = 0; i < datas.length - 1; i++) {
        if (datas[i].length > 251) return null
        parts.push(Buffer.from([datas[i].length]))
    }
    parts.push(...datas)
    return Buffer.concat(parts)
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
    constructor({ callId, callKey, relay, selfLid, peerLid, logger, inbound = false, group = false, peerMlow = false }) {
        super()
        this.callId = callId
        this.callKey = Buffer.from(callKey)
        this.relay = relay
        this.selfLid = selfLid
        this.peerLid = peerLid || relay?.peerJid || ""
        this.logger = logger || console
        this.inbound = inbound
        this.group = group
        // peer is in the MLOW codec profile (announced capability index 31):
        // our standard CELT Opus frames must be wrapped in the MLOW escape or
        // the peer's MLOW decoder misparses them as proprietary smpl frames.
        this._peerMlow = peerMlow === true
        // MLow wire mode: CELT 20 ms singles grouped 3-per-60 ms packet.
        // Standard mode: SILK 60 ms singles, one per packet.
        this._fpp = this._peerMlow ? 3 : 1
        this.closed = false
        this.connected = false

        this.selfParticipantId = selfKeyId(this.selfLid, { answerer: !!inbound && !group })
        // receive: try the peer LID and its variants
        this._recvCandidates = participantIdVariants(this.peerLid)

        // derived SSRCs
        this.ssrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, 0)
        this.videoSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, VIDEO_SLOT_WORD)
        this.appDataSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, APP_DATA_SLOT_WORD)
        this.hbhFecTxSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, HBH_FEC_TX_SLOT_WORD)
        this.hbhFecRxSsrc = deriveParticipantSsrc(this.callId, this.selfParticipantId, HBH_FEC_RX_SLOT_WORD)
        this.streamSsrcs = prepareRelayStreamSsrcs(deriveRelayStreamSsrcs(this.callId, this.selfParticipantId))

        // media pipelines — E2E send keys use the role-correct participant form
        // (caller → normalized :0@lid; answerer → real device), SSRCs above
        // keep the real-device participant that the relay streams already use.
        this._sendKeyParticipant = selfKeyId(this.selfLid, { zeroForm: !inbound && !group })
        this._installSendKeys(deriveE2eKeys(this.callKey, this._sendKeyParticipant))
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
        this.sendSrtcpKeys = deriveE2eSrtcpKeys(this.callKey, this._sendKeyParticipant || this.selfParticipantId)
    }

    _installRecvKeys(participantId, preserveRoc = false) {
        this.recvKeys = deriveE2eKeys(this.callKey, participantId)
        if (!preserveRoc) this.recvRoc = new RecvRocTracker()
        this._refreshRecvSrtcpKeys()
    }

    /** SRTCP receive-key candidates for the peer (parallel to _recvCandidates). */
    _refreshRecvSrtcpKeys() {
        const cands = this._recvCandidates?.length ? this._recvCandidates : [this.selfParticipantId]
        this._recvSrtcpCandidates = cands.map((id) => ({ id, keys: deriveE2eSrtcpKeys(this.callKey, id) }))
        this._recvSrtcpVerifiedId = null
    }

    /** Rekey the receive path (e.g. the call was answered on another device). */
    rekeyRecv(callKey, peerJid) {
        this.callKey = Buffer.from(callKey)
        this._installRecvKeys(formatParticipantId(peerJid), true)
    }

    /** Mark the peer as MLOW-profile (escape our outbound Opus accordingly). */
    notePeerMlow(enabled) {
        const v = enabled === true
        if (this._peerMlow !== v) {
            this._peerMlow = v
            this._fpp = v ? 1 : 1
            this.logger.info?.({ peerMlow: v }, "[call-media] peer MLOW profile — outbound frames use the NATIVE smpl/MLow encoder")
            // The encoder profile must match the new mode. Safe to restart
            // while we are still on the generated-silence source (outgoing
            // calls: preaccept arrives before the real audio attaches). If a
            // file is already playing we keep the frames flowing; the
            // belt-and-braces guard in _tick protects the peer either way.
            if (this._ff && !this._ffInput) {
                try { this._startFfmpeg(null) } catch (e) {
                    this.logger.warn?.({ err: e?.message }, "[call-media] mlow profile restart failed")
                }
            }
        }
    }

    /**
     * Caller-side, on the callee's <accept>: the answering device announces
     * itself in <relay><participant jid='<device>@lid'/> and encrypts under
     * THAT participant id (rust rekey_recv). Prepend it to the recv
     * candidates so inbound RTP/SRTCP from the answerer verifies.
     */
    noteAnsweringParticipant(jid) {
        const id = formatParticipantId(jid)
        if (!id) return
        const changed = this._recvCandidates[0] !== id
        this._recvCandidates = [id, ...this._recvCandidates.filter((c) => c && c !== id)]
        this._recvKeysCache = {}
        this._recvRocs = {}
        if (changed) {
            this._installRecvKeys(id, true)
            this._refreshRecvSrtcpKeys()
            this.logger.info?.({ answeringParticipant: id }, "[call-media] recv rekeyed to answering device")
        }
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

    /**
     * Per-leg group relay block (from <group_update>). NOT used for ICE — the
     * offer's announcement block (this.relay) is the web ICE credential set.
     * The per-leg block carries the Android-path allocate credentials
     * (te2 tokens + key) for the c01-family relays; we use them when an
     * allocate error points us at one of those relays.
     */
    setGroupRelay(groupRelay) {
        this.groupRelay = groupRelay
    }

    // ------------------------------------------------------------------
    // Transport: RTCPeerConnection + synthetic remote SDP toward the relay
    // ------------------------------------------------------------------

    _pickEndpoint() {
        const eps = this.relay?.endpoints || []
        // rust relay_parse.rs get_media_relay_endpoint: prefer a port-3480
        // ("web client") endpoint — relays reached on 3478 can complete the
        // handshake and carry our uplink yet never forward the peer's media
        // back (rust issue #1098); then a relaylatency-capable endpoint
        // (!isFna && authTokenId!=0); then any non-FNA; then the first.
        // The FNA endpoint (is_fna=1, auth_token_id=0) is inbound-offer-only
        // and must NOT be the media transport relay — allocating on it gave a
        // one-way call (our uplink OK, zero inbound, 21s watchdog death).
        const on3480 = eps.find((e) => e && !e.isFna && e.port === 3480)
        if (on3480) return on3480
        const authd = eps.find((e) => e && !e.isFna && e.authTokenId !== 0)
        if (authd) return authd
        const nonFna = eps.find((e) => e && !e.isFna)
        if (nonFna) return nonFna
        return eps[0]
    }

    async _openRelayChannel(endpoint, timeoutMs = 25000) {
        let wrtc
        try {
            wrtc = require("@roamhq/wrtc")
        } catch (err) {
            throw new Error(
                "call media requires the @roamhq/wrtc package (WebRTC data channels to the WhatsApp relay). " +
                "Install it with: npm install @roamhq/wrtc"
            )
        }

        // Optional TURN fallback for sandboxes with broken direct UDP egress.
        // Creds file (refreshed before each call): CALL_TURN_CREDS_FILE with
        // {"urls":[...],"username":"...","credential":"..."}
        // Or inline: CALL_TURN_SERVER="url1,url2|user|pass"
        let iceServers
        try {
            if (process.env.CALL_TURN_CREDS_FILE) {
                const c = JSON.parse(require("fs").readFileSync(process.env.CALL_TURN_CREDS_FILE, "utf8"))
                if (c?.username && Array.isArray(c.urls)) {
                    iceServers = [{ urls: c.urls, username: c.username, credential: c.credential }]
                    this.logger.info?.({ urls: c.urls }, "[call-media] using TURN server (creds file) for relay channel")
                }
            } else if (process.env.CALL_TURN_SERVER) {
                const [urls, username, credential] = process.env.CALL_TURN_SERVER.split("|")
                iceServers = username ? [{ urls: urls.split(","), username, credential }] : [{ urls: urls.split(",") }]
                this.logger.info?.({ urls }, "[call-media] using TURN server for relay channel")
            }
        } catch (e) {
            this.logger.warn?.({ err: String(e) }, "[call-media] TURN creds file unreadable — going direct")
        }
        const pc = new wrtc.RTCPeerConnection({ iceServers, iceTransportPolicy: "all" })
        const dc = pc.createDataChannel("pre-negotiated", {
            negotiated: true,
            id: 0,
            ordered: false,
            maxRetransmits: 0,
            priority: "high",
        })
        dc.binaryType = "arraybuffer"

        // ICE short-term credentials the relay validates: the AUTH token
        // (auth_tokens[auth_token_id]) as the ufrag — what WhatsApp Web's WASM
        // uses — falling back to the regular token. The WASM stringifies the
        // token as base64 (libwebrtc validates ufrag charset as [A-Za-z0-9+/]);
        // base64 of the 191-byte token is exactly 256 chars = libwebrtc's
        // ICE_UFRAG_MAX_LENGTH, so it fits UNTRUNCATED. Do not slice it.
        const authTokens = this.relay?.authTokens || []
        const tokens = this.relay?.tokens || []
        const token = (endpoint.authTokenId !== 0 && authTokens[endpoint.authTokenId])
            || authTokens.find(Boolean)
            || tokens[endpoint.tokenId]
            || tokens[0]
            || Buffer.alloc(0)
        let iceUfrag = token.length ? token.toString("base64") : "calltoken"
        if (iceUfrag.length < 4) iceUfrag = (iceUfrag + "AAAAAAAA").slice(0, 8)
        if (iceUfrag.length > 256) iceUfrag = iceUfrag.slice(0, 256)
        let icePwd = this.relay?.key?.length ? this.relay.key.toString("utf8") : "relaykey"
        if (icePwd.length < 22) {
            // libwebrtc enforces pwd >= 22 chars; stretch short keys via base64
            icePwd = Buffer.from(icePwd, "utf8").toString("base64")
            while (icePwd.length < 22) icePwd += icePwd
            icePwd = icePwd.slice(0, 256)
        }
        // edgeray DTLS active mode: relay initiates DTLS (client role), so the
        // remote answer must say setup:active; default is a passive relay
        // (we are the DTLS client — matches meowcaller's dtls.Client).
        const dtlsActiveMode = this.relay?.dtlsActiveMode === true
        this.logger.info?.(
            {
                ufragLen: iceUfrag.length,
                ufragHead: iceUfrag.slice(0, 24),
                ufragTail: iceUfrag.slice(-8),
                pwdLen: icePwd.length,
                tokenId: endpoint.tokenId,
                authTokenId: endpoint.authTokenId,
                dtlsActiveMode,
            },
            "[call-media] relay SDP credentials"
        )

        const t0 = Date.now()
        const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + "s"
        let lastIceState = ""
        let rejectOpen = null
        let iceTimer = null
        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState !== lastIceState) {
                lastIceState = pc.iceConnectionState
                this.logger.info?.({ ice: lastIceState, at: elapsed() }, "[call-media] relay ICE state")
            }
            if (pc.iceConnectionState === "failed") {
                clearTimeout(iceTimer)
                rejectOpen?.(new Error("ICE toward relay failed (state=failed at " + elapsed() + ")"))
            }
        }
        pc.onconnectionstatechange = () => {
            this.logger.info?.({ conn: pc.connectionState, ice: pc.iceConnectionState, at: elapsed() }, "[call-media] relay PC connection state")
        }

        const opened = new Promise((resolve, reject) => {
            rejectOpen = reject
            iceTimer = setTimeout(async () => {
                // Diagnose why the channel never opened: dump candidate-pair +
                // DTLS transport state from getStats before rejecting.
                let diag = ""
                try {
                    const stats = await pc.getStats()
                    const reports = typeof stats.values === "function" ? Array.from(stats.values()) : Object.values(stats)
                    const pairs = reports.filter((r) => r.type === "candidate-pair")
                    const dtls = reports.filter((r) => r.type === "transport" || r.dtlsState)
                    diag = " | pairs=" + JSON.stringify(pairs.map((p) => ({ state: p.state, sent: p.requestsSent, recv: p.responsesReceived, nominated: p.nominated })))
                        + " dtls=" + JSON.stringify(dtls.map((d) => ({ dtlsState: d.dtlsState, selected: d.selectedCandidatePairId })))
                } catch { diag = " (stats unavailable)" }
                reject(new Error("relay DataChannel open timed out after " + (timeoutMs / 1000) + "s (ice=" + (lastIceState || "n/a") + " at " + elapsed() + ")" + diag))
            }, timeoutMs)
            dc.onopen = () => { clearTimeout(iceTimer); this.logger.info?.({ at: elapsed() }, "[call-media] relay DataChannel OPEN"); resolve() }
            dc.onerror = (e) => { clearTimeout(iceTimer); reject(new Error("relay DataChannel error: " + (e?.error?.message || e?.message || "unknown"))) }
        })

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        // Synthetic remote answer describing the relay as a passive DTLS peer
        // with a host candidate at its public endpoint (the relay never sees
        // this SDP — it only configures the local stack). setup:passive means
        // the relay is the DTLS server and WE are the client (meowcaller's
        // dtls.Client). edgeray active mode flips the relay to DTLS client.
        const setupLine = dtlsActiveMode ? "a=setup:active" : "a=setup:passive"
        let answer = offer.sdp
            .replace(/a=setup:actpass/g, setupLine)
            .replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${iceUfrag}`)
            .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${icePwd}`)
            .replace(/a=fingerprint:[^\r\n]+/g, `a=fingerprint:sha-256 ${RELAY_DTLS_FINGERPRINT}`)
            .replace(/a=ice-options:[^\r\n]+\r?\n/g, "")
            .replace(/a=max-message-size:[^\r\n]+/g, "a=max-message-size:1200")
            .replace(/a=candidate:[^\r\n]+\r?\n/g, "")
            .replace(/a=end-of-candidates\r?\n?/g, "")
        // Offer EXACTLY ONE remote candidate: the chosen relay on the web port
        // 3480. Multiple candidates make libwebrtc probe/switch pairs, sending
        // our DC traffic to several relays at once — each then sees allocates
        // with a foreign XOR and the error storm gets the channel killed ~9s
        // in. One candidate = one pair = one relay, deterministically.
        const candTargets = [
            `a=candidate:1 1 udp 2122262783 ${endpoint.ip} 3480 typ host generation 0 network-cost 5`,
        ]
        answer = `${answer}${candTargets.join("\r\n")}\r\na=end-of-candidates\r\n`

        await pc.setRemoteDescription({ type: "answer", sdp: answer })
        await opened

        return { pc, dc }
    }

    // ------------------------------------------------------------------
    // Outbound protect: RTP header → E2E SRTP → WARP MI tag
    // ------------------------------------------------------------------

    protectAudio(opusPayload) {
        let payload = opusPayload
        if (this._peerMlow) {
            const esc = mlowEscapeOpus(payload)
            if (esc) payload = esc
        }
        opusPayload = payload
        const header = this.stream.nextPacket(opusPayload)
        // [empirical] X=1 16-byte speech headers (the shape their sender uses)
        // get DROPPED by their receiver — every X=1 test was pure silence,
        // every X=0 test was audible. The rust also sends X=0 speech. Keep X=0.
        if (this._peerMlow && header.extensionWord == null) header.xAlways = false
        const roc = this.sendRoc.advance(header.sequenceNumber)
        let packet = encodeRtpHeader(header)
        const encrypted = cryptPayload(this.sendKeys, header.ssrc, header.sequenceNumber, roc, opusPayload)
        packet = Buffer.concat([packet, encrypted])
        const tag = computeWarpMITag(this.sendKeys.authKey, packet, roc, WARP_MI_TAG_LEN)
        this.stats.packetsSent++
        this.stats.octetsSent += opusPayload.length
        this.stats.rtpTimestamp = header.timestamp
        if (this._peerMlow) {
            const k = opusPayload.length ? opusPayload[0] & 0xf8 : -1
            this._sentB0 = this._sentB0 || {}
            this._sentB0[k] = (this._sentB0[k] || 0) + 1
        }
        const full = Buffer.concat([packet, tag])
        if (this._peerMlow) {
            try {
                if (!this._outboundCapStream) {
                    this._outboundCapStream = fs.openSync("/home/user/wa-web-study/outbound-frames.jsonl", "a")
                }
                fs.writeSync(this._outboundCapStream, JSON.stringify({
                    at: Date.now(), seq: header.sequenceNumber, ts: header.timestamp,
                    len: opusPayload.length, hex: opusPayload.toString("hex").slice(0, 400),
                }) + "\n")
            } catch { /* best effort */ }
        }
        if (this._peerMlow && !this._sentRawSample) {
            this._sentRawSample = full.subarray(0, 24).toString("hex")
        }
        return full
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
                    return { header, payload: plain, participantId: candidate, verified: true }
                }
            }
        }
        // no candidate verified — fall back to the primary keys (best effort),
        // but mark it UNVERIFIED: the tag mismatch means our key derivation
        // (epoch / participant id) does not match this sender
        const roc = this.recvRoc.estimateRoc(header.sequenceNumber)
        this.recvRoc.commitRoc(roc, header.sequenceNumber)
        const plain = cryptPayload(this.recvKeys, header.ssrc, header.sequenceNumber, roc, payload)
        return { header, payload: plain, participantId: this._recvCandidates[0] || "?", verified: false }
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

        const { pc, dc } = await this._openRelayChannel(endpoint, opts.channelTimeoutMs || 25000)
        this._bindChannel(pc, dc, endpoint)

        // STUN allocate + consent ping (BEFORE any RTP)
        this._sendAllocate()
        this._dcSend(buildWhatsappPing())
        this.connected = true
        this.emit("connected", { ip: endpoint.ip, port: endpoint.port, relayName: endpoint.relayName })
        this.logger.info?.({ ssrc: this.ssrc, streamSsrcs: this.streamSsrcs }, "[call-media] relay channel open — allocate sent")

        // 1 Hz keepalive: re-allocate + ping (NO STUN binding-requests — they
        // flip the relay into ICE-consent mode and the bridge never forms)
        this._startKeepalive()
        this._startMediaLoops()
        return this
    }

    _bindChannel(pc, dc, endpoint) {
        this.pc = pc
        this.dc = dc
        this.endpoint = endpoint
        dc.onclose = () => { if (this.pc === pc) this.close() }
        dc.onerror = () => { /* logged via pc state */ }
        dc.onmessage = (event) => this._onRelayPacket(event.data)
    }

    _startKeepalive() {
        if (this._keepaliveTimer) return
        this._keepaliveTimer = setInterval(() => {
            if (this.closed) return
            try {
                this._sendAllocate()
                this._dcSend(buildWhatsappPing())
            } catch { /* best effort */ }
        }, 1000)
    }

    /**
     * Join the relay endpoint the callee named in its accept <te>. If we are
     * already on that relay (same ip), just note it. Otherwise open a second
     * channel to it (web port 3480) and swap the live transport. Resolves with
     * the endpoint we ended up on: { joined: bool, ip, port }.
     */
    async joinCalleeEndpoint(ip, port, timeoutMs = 12000) {
        if (!ip || !port) return { joined: false, ip: this.endpoint?.ip, port: this.endpoint?.port }
        this.calleeEndpoint = { ip, port }
        if (this.closed) return { joined: false, ip, port }
        if (this.endpoint?.ip === ip) {
            this.logger.info?.({ relay: `${ip}:${port}` }, "[call-media] already on the callee's relay")
            return { joined: true, ip, port }
        }
        // find a te2 entry for this ip to reuse its metadata/token
        const ep = (this.relay?.endpoints || []).find((e) => e && !e.isFna && e.ip === ip)
        const target = { ...ep, ip, port: 3480, relayName: ep?.relayName || "callee-relay" }
        this.logger.info?.({ relay: `${ip}:3480 (callee named ${ip}:${port})` }, "[call-media] joining the callee's relay")
        try {
            const { pc, dc } = await this._openRelayChannel(target, timeoutMs)
            // swap transports
            const oldPc = this.pc
            this._bindChannel(pc, dc, target)
            this._allocWinner = null
            this._errorRelayHint = null
            this._sendAllocate()
            this._dcSend(buildWhatsappPing())
            try { oldPc?.close() } catch { /* best effort */ }
            this.emit("connected", { ip: target.ip, port: target.port, relayName: target.relayName, rejoined: true })
            return { joined: true, ip: target.ip, port: target.port }
        } catch (e) {
            this.logger.warn?.({ err: String(e?.message || e), relay: `${ip}:3480` }, "[call-media] could not join the callee's relay — staying on current")
            return { joined: false, ip: this.endpoint?.ip, port: this.endpoint?.port }
        }
    }

    /** Media loops: silence source, 60 ms RTP tick, 1.5 s SRTCP. Idempotent. */
    _startMediaLoops() {
        // audio: silence until a real source is attached, so the relay always
        // sees our SSRC (it won't bridge the peer's media otherwise)
        if (!this._ffInput) this._startFfmpeg(null)

        // 60 ms send loop
        if (!this._sendTimer) this._sendTimer = setInterval(() => this._tick(), AUDIO_FRAME_MS)

        // 1500 ms compound SRTCP SR+SDES
        if (!this._rtcpTimer) this._rtcpTimer = setInterval(() => {
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

        // 5 s telemetry summary: what has the relay been sending us?
        if (!this._summaryTimer) this._summaryTimer = setInterval(() => {
            if (this.closed) return
            this.logger.info?.(
                {
                    stunIn: this._stunIn || {},
                    mediaIn: this._mediaInCount || {},
                    rtpVerify: Object.fromEntries(Object.entries(this._rtpVerify || {}).map(([ssrc, s]) => [ssrc, `v${s.v}/u${s.u}`])),
                    // [diag] first-byte signature of inbound payloads: MLow 60ms
                    // frames are 0x50..0x57, 20ms 0x48..0x4f — if the peer sends
                    // MLow, its client is in MLow mode for this call.
                    payloadFirstByte: Object.fromEntries(Object.entries(this._payloadB0 || {}).slice(-3).map(([b, n]) => [`0x${b.toString(16)}`, n])),
                    bindingReqReplied: this._bindingReqCount || 0,
                    dcIn: this._inboundCount || 0,
                    winner: this._allocWinner ? `${this._allocWinner.ip}:${this._allocWinner.port}` : null,
                    rtpSent: this.stats?.packetsSent || 0,
                    // [diag] OUR send pacing: avg/max deviation of the inter-send
                    // gap from the 60 ms cadence (separates our jitter from network
                    // jitter seen in the peer RR), + multiframe builder rejects.
                    sendGapAvgMs: this._gapN ? Math.round((this._gapSum / this._gapN) * 10) / 10 : null,
                    sendGapMaxMs: this._gapMax || 0,
                    builderRejects: this._builderRejects || 0,
                    sentFirstByte: Object.fromEntries(Object.entries(this._sentB0 || {}).map(([b, n]) => [`0x${b.toString(16)}`, n])),
                    sentRawSample: this._sentRawSample || null,
                },
                "[call-media] relay telemetry"
            )
        }, 5000)
    }

    _sendAllocate() {
        if (!this.relay?.key?.length) throw new Error("relay has no <key>")
        if (!this._allocTx) this._allocTx = new Map() // txId hex -> { ip, port, tokenId }

        // The relay validates the allocate's XOR-RELAYED-ADDRESS against its own
        // address, and libwebrtc may have selected ANY of the offered candidates
        // (not necessarily this.endpoint). Send one allocate per known relay
        // endpoint with that endpoint's token; exactly the one matching the
        // connected relay succeeds. After a success, stick to the winner.
        const targets = []
        if (this._allocWinner) {
            targets.push(this._allocWinner)
        } else {
            const seen = new Set()
            const push = (ip, port, tokenId) => {
                const k = `${ip}:${port}#t${tokenId}`
                if (!ip || !port || seen.has(k)) return
                seen.add(k)
                targets.push({ ip, port, tokenId })
            }
            // Single candidate = single connected relay (the chosen te2
            // endpoint on the web port 3480). A wrong-XOR volley to many
            // relays caused error storms that got the channel killed.
            push(this.endpoint.ip, 3480, this.endpoint.tokenId)
            // plus the relay the error message told us about (if any)
            if (this._errorRelayHint) {
                for (let t = 0; t < (this.relay?.tokens?.length || 0); t++) {
                    push(this._errorRelayHint.ip, this._errorRelayHint.port, t)
                }
            }
        }
        if (!targets.length) throw new Error("no relay endpoints to allocate on")

        for (const target of targets) {
            const endpointXor = encodeXorRelayEndpoint(target.ip, target.port)
            if (!endpointXor) continue
            // credential source per target: the per-leg group block owns the
            // c01-family relays (its te2 token_id indexes ITS token table and
            // its <key> is the allocate MI key for them); everything else uses
            // the announcement block (this.relay)
            const gr = this.groupRelay
            const src = (this.group && gr?.key?.length && (gr.endpoints || []).some((e) => e && !e.isFna && e.ip === target.ip))
                ? gr
                : this.relay
            const token = src?.tokens?.[target.tokenId] || src?.tokens?.[0]
                || (src === gr ? (this.relay?.tokens?.[target.tokenId] || this.relay?.tokens?.[0]) : undefined)
            if (!token) continue
            const txId = crypto.randomBytes(12)
            const allocate = buildWasmAllocateRequest(
                txId, token, endpointXor, this.streamSsrcs, src.key,
                {
                    participantPids: this.group ? this._groupPids : [],
                    appDataSsrc: this.appDataSsrc,
                    hbhFecSsrcs: this.group && this._groupPids.length > 1 ? [this.hbhFecTxSsrc, this.hbhFecRxSsrc] : null,
                }
            )
            this._allocTx.set(txId.toString("hex"), target)
            if (!this._loggedAllocReq) {
                this._loggedAllocReq = true
                this.logger.info?.(
                    { hex: allocate.toString("hex").slice(0, 400), len: allocate.length, targets: targets.map((t) => `${t.ip}:${t.port}#t${t.tokenId}`), tokenLen: token.length },
                    "[call-media] allocate request dump (first)"
                )
            }
            this._dcSend(allocate)
        }
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

        if (!this._inboundCount) this._inboundCount = 0
        if (this._inboundCount < 8) {
            this._inboundCount++
            this.logger.info?.(
                { n: this._inboundCount, len: pkt.length, head: pkt.toString("hex").slice(0, 80) },
                "[call-media] inbound DC packet"
            )
        }

        const kind = classifyRelayPacket(pkt)
        if (kind !== RELAY_PACKET_STUN) {
            // log the first few non-STUN (media/other) packets regardless of
            // the cap — evidence of peer traffic / bridge state
            const kname = kind === RELAY_PACKET_RTP ? "rtp" : kind === RELAY_PACKET_RTCP ? "rtcp" : "other"
            if (!this._mediaInCount) this._mediaInCount = {}
            this._mediaInCount[kname] = (this._mediaInCount[kname] || 0) + 1
            if (this._mediaInCount[kname] <= 3) {
                this.logger.info?.(
                    { kind: kname, n: this._mediaInCount[kname], len: pkt.length, head: pkt.toString("hex").slice(0, 60) },
                    "[call-media] inbound MEDIA packet"
                )
            }
        }
        if (kind === RELAY_PACKET_STUN) {
            const mt = stunMessageType(pkt)
            if (!this._stunIn) this._stunIn = {}
            this._stunIn[mt] = (this._stunIn[mt] || 0) + 1
            if (mt === STUN_MSG_BINDING_REQUEST) {
                // answer the relay's consent-freshness binding request
                const resp = buildBindingSuccess(pkt, this.relay?.key)
                if (resp) this._dcSend(resp)
                if (!this._bindingReqCount) this._bindingReqCount = 0
                this._bindingReqCount++
                if (this._bindingReqCount <= 3) {
                    this.logger.info?.({ n: this._bindingReqCount, len: pkt.length }, "[call-media] relay binding-request → replied binding-success")
                }
            } else if (mt === STUN_MSG_ALLOCATE_SUCCESS) {
                const txHex = pkt.subarray(8, 20).toString("hex")
                const winner = this._allocTx?.get(txHex)
                if (winner) {
                    this._allocWinner = winner
                    this.logger.info?.(
                        { relay: `${winner.ip}:${winner.port}`, tokenId: winner.tokenId, len: pkt.length },
                        "[call-media] relay allocate SUCCESS ✅ (winner locked)"
                    )
                } else {
                    this.logger.info?.({ len: pkt.length }, "[call-media] relay allocate SUCCESS ✅")
                }
                this.emit("relay", { event: "allocate-success" })
            } else if (mt === STUN_MSG_ALLOCATE_ERROR) {
                // extract the relay's self-reported address from the reason
                // phrase: "… Destination address: A.B.C.D:P relay address: E.F.G.H:P"
                try {
                    const alen = pkt.readUInt16BE(2)
                    let p = 20
                    while (p + 4 <= 20 + alen) {
                        const at = pkt.readUInt16BE(p), l = pkt.readUInt16BE(p + 2)
                        if (at === 0x0009) {
                            const reason = pkt.subarray(p + 8, p + 4 + l).toString("utf8")
                            const m = reason.match(/relay address:\s*(\d+\.\d+\.\d+\.\d+):(\d+)/)
                            if (m && !this._errorRelayHint) {
                                this._errorRelayHint = { ip: m[1], port: +m[2] }
                                this.logger.info?.(
                                    { hint: `${m[1]}:${m[2]}`, reason: reason.slice(0, 110) },
                                    "[call-media] connected relay identified from allocate error — retrying with correct XOR"
                                )
                                // immediately retry with the correct endpoint
                                this._sendAllocate()
                            }
                            break
                        }
                        p += 4 + l + ((4 - l % 4) % 4)
                    }
                } catch { /* best effort */ }
                if (!this._loggedAllocErrs) this._loggedAllocErrs = 0
                if (this._loggedAllocErrs < 2) {
                    this._loggedAllocErrs++
                    this.logger.warn?.({ len: pkt.length, hex: pkt.toString("hex").slice(0, 260) }, "[call-media] relay allocate ERROR (dump)")
                }
                this.emit("relay", { event: "allocate-error" })
            } else if (mt === STUN_MSG_WHATSAPP_PONG) {
                this.emit("relay", { event: "pong" })
            }
            return
        }
        if (kind === RELAY_PACKET_RTCP) {
            this.emit("rtcp", { data: pkt })
            // [MOD] decode the peer's SRTCP receiver reports — their honest
            // view of OUR stream (packets received / lost / jitter). This is
            // the ground-truth diagnostic for one-way-audio bugs.
            try {
                if (!this._recvSrtcpCandidates) this._refreshRecvSrtcpKeys()
                let r = null
                let usedId = this._recvSrtcpVerifiedId
                if (usedId) {
                    const cand = this._recvSrtcpCandidates.find((c) => c.id === usedId)
                    if (cand) r = unprotectSrtcp(cand.keys, pkt)
                }
                if (!r || !r.verified) {
                    for (const cand of this._recvSrtcpCandidates || []) {
                        const rr = unprotectSrtcp(cand.keys, pkt)
                        if (rr?.verified) { r = rr; usedId = cand.id; this._recvSrtcpVerifiedId = cand.id; break }
                        if (!r) r = rr
                    }
                }
                if (r) {
                    const blocks = parseRtcpReportBlocks(r.plain)
                    if (!this._rtcpDbg) {
                        this._rtcpDbg = 1
                        this.logger.info?.(
                            { len: pkt.length, hex: pkt.toString("hex").slice(0, 200), verified: !!r.verified, encrypted: !!r.encrypted, via: usedId, blocksParsed: blocks.length, blockSsrcs: blocks.map((b) => b.ssrc), ourSsrc: this.ssrc },
                            "[call-media] first inbound RTCP (debug)"
                        )
                    }
                    for (const b of blocks) {
                        if (b.ssrc === this.ssrc) {
                            const cur = this._rrStats || (this._rrStats = {})
                            const isFirst = cur.extHighestSeq === undefined
                            const changed = !isFirst && cur.extHighestSeq !== b.extHighestSeq
                            Object.assign(cur, b, { srtcpVerified: !!r.verified, via: usedId })
                            if (isFirst || changed) {
                                this.logger.info?.(
                                    { ourSsrc: this.ssrc, theirHighestSeq: b.extHighestSeq, theirCumLost: b.cumLost, theirFractionLostPct: Math.round((b.fractionLost / 256) * 100), jitter: b.jitter, srtcpVerified: !!r.verified },
                                    "[call-media] 📊 peer RR — their view of OUR stream"
                                )
                            }
                        }
                    }
                }
            } catch { /* best effort */ }
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
        // per-SSRC verify stats: an unverified tag = our group key derivation
        // does not match that sender (epoch or participant id wrong)
        if (!this._rtpVerify) this._rtpVerify = {}
        {
            const s = this._rtpVerify[result.header.ssrc] || (this._rtpVerify[result.header.ssrc] = { v: 0, u: 0, firstAt: Date.now() })
            if (result.verified) s.v++; else s.u++
            if (s.v + s.u === 1) {
                this.logger.info?.(
                    { ssrc: result.header.ssrc, pt: result.header.payloadType, verified: !!result.verified, participantId: result.participantId, xBit: (media[0] & 0x10) !== 0, headerLen: result.header.headerLength },
                    "[call-media] new inbound SSRC"
                )
            }
        }
        this.rxCount++
        if (this.rxCount === 1) {
            this.logger.info?.({ bytes: pkt.length }, "[call-media] 🎉 FIRST RTP RECEIVED FROM PEER — media bridge is UP")
        }
        // [diag] full dump of the first inbound RTP packets — ground truth for
        // comparing THEIR wire shape (header, marker, ts cadence, payload TOC)
        // against ours.
        if (this.rxCount <= 24 && (this.rxCount <= 6 || this.rxCount % 6 === 0)) {
            const h = result.header
            const dts = this._dbgLastTs !== undefined && h.timestamp >= this._dbgLastTs ? h.timestamp - this._dbgLastTs : null
            this.logger.info?.(
                {
                    n: this.rxCount, ssrc: h.ssrc, pt: h.payloadType, seq: h.sequenceNumber, ts: h.timestamp,
                    dts, marker: h.marker, headerLen: h.headerLength, xBit: (media[0] & 0x10) !== 0,
                    payloadLen: result.payload?.length, payloadHex: result.payload?.toString("hex").slice(0, 80),
                },
                "[call-media] 🔬 inbound RTP dump"
            )
            this._dbgLastTs = h.timestamp
        }
        this.emit("rtp", {
            header: result.header,
            payload: result.payload,
            participantId: result.participantId,
            verified: !!result.verified,
            groupWrapped: unwrapped.wrapped,
        })
        // [diag] inbound payload first-byte histogram (MLow signature probe)
        if (result.payload?.length) {
            if (!this._payloadB0) this._payloadB0 = {}
            const b = result.payload[0]
            this._payloadB0[b] = (this._payloadB0[b] || 0) + 1
            // [MOD] full inbound frame capture — ground truth for the MLow
            // wire format (reverse-engineering). One JSON line per packet.
            try {
                if (!this._inboundCapStream) {
                    const capFd = fs.openSync("/home/user/wa-web-study/inbound-frames.jsonl", "a")
                    this._inboundCapStream = capFd
                }
                fs.writeSync(this._inboundCapStream, JSON.stringify({
                    at: Date.now(), ssrc: result.header.ssrc, seq: result.header.sequenceNumber,
                    ts: result.header.timestamp, len: result.payload.length,
                    rh: media.subarray(0, 24).toString("hex"),
                    hex: result.payload.toString("hex").slice(0, 340),
                }) + "\n")
            } catch { /* best effort */ }
        }
    }

    // ------------------------------------------------------------------
    // Audio source management (ffmpeg → Ogg Opus → frame queue)
    // ------------------------------------------------------------------

    _startFfmpeg(input) {
        this._stopFfmpeg()
        this._ffInput = input
        this._trackEnded = false
        this._frameQueue = []

        const args = input
            // [MOD] NO -re for file inputs: decode at full speed, buffer all
            // frames, and let OUR 60ms send timer pace the stream. With -re,
            // ffmpeg's decode jitter caused queue underruns (skipped ticks =
            // audible gaps: "glitching, not smooth") and the 64-frame cap
            // dropped burst frames.
            ? ["-hide_banner", "-loglevel", "error", "-i", input]
            // infinite generated silence keeps the stream alive pre-file / post-file
            : ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono"]

        // resolve ffmpeg: prefer system, fall back to ffmpeg-static (platform
        // wipes system packages between turns — ffmpeg-static in node_modules
        // is reinstalled the same way and survives within a session)
        const FF = (() => { try { return require("ffmpeg-static") || "ffmpeg" } catch { return "ffmpeg" } })()

        // ------------------------------------------------------------------
        // MLow profile: NATIVE smpl/MLow encoding. ffmpeg decodes any input to
        // 16 kHz mono PCM and pipes it into the opus_mlow encoder CLI, which
        // emits one native 60 ms MLow frame (TOC 0x50-family, the exact shape
        // the real client sends) per u16-BE-length-prefixed record. Frames go
        // on the wire untouched: no grouping, no Opus escape.
        // ------------------------------------------------------------------
        if (this._peerMlow) {
            this._fpp = 1
            args.push("-vn", "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1")
            this._ff = spawn(FF, args, { stdio: ["ignore", "pipe", "pipe"] })
            const ff = this._ff
            ff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:a] ${d}`))
            ff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg audio: " + e.message))
            const mlow = spawn(MLOWENC_BIN, [String(MLOW_BITRATE)], { stdio: ["pipe", "pipe", "pipe"] })
            this._mlowEnc = mlow
            mlow.on("error", (e) => this.logger.warn?.("[call-media] mlowenc: " + e.message + " — falling back to silence"))
            mlow.stderr.on("data", (d) => this.logger.debug?.(`[mlowenc] ${d}`))
            // EPIPE armor: if either side of the ffmpeg→mlowenc pipe dies, the
            // surviving end's write fails — swallow it or the unhandled
            // 'error' takes the whole bot down (took down bot1 at ~07:50).
            for (const s of [ff.stdout, ff.stderr, mlow.stdin, mlow.stdout, mlow.stderr]) {
                s.on("error", () => { /* pipe torn down — close handlers do the rest */ })
            }
            mlow.on("close", (code) => {
                if (this._mlowEnc === mlow && !this.closed && code !== 0 && code !== null) {
                    this.logger.warn?.({ code }, "[call-media] mlowenc exited nonzero — outbound audio stops")
                }
            })
            let mbuf = Buffer.alloc(0)
            mlow.stdout.on("data", (chunk) => {
                mbuf = mbuf.length ? Buffer.concat([mbuf, chunk]) : chunk
                while (mbuf.length >= 2) {
                    const len = mbuf.readUInt16BE(0)
                    if (mbuf.length < 2 + len) break
                    const frame = mbuf.subarray(2, 2 + len)
                    mbuf = mbuf.subarray(2 + len)
                    if (this._frameQueue.length < 20000) this._frameQueue.push(Buffer.from(frame))
                }
            })
            ff.stdout.pipe(mlow.stdin)
            ff.on("close", (code, signal) => {
                if (this._ff !== ff) return
                this._ff = null
                try { mlow.kill("SIGKILL") } catch { /* ignore */ }
                if (this._mlowEnc === mlow) this._mlowEnc = null
                if (input) {
                    this._trackEnded = true
                    // after a real file ends, keep the stream alive with silence
                    if (!this.closed) setTimeout(() => { if (this._ffInput === input) this._startFfmpeg(null) }, 200)
                    this.emit("trackEnd", { kind: "audio", skipped: signal === "SIGKILL" })
                }
            })
            return
        }

        this._demuxer = new OggOpusDemuxer()
        const q = { ...DEFAULT_AUDIO_QUALITY, ...(this._audioQuality || {}) }
        this._fpp = q.frameDuration === 20 ? 3 : 1
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
        this._ff = spawn(FF, args, { stdio: ["ignore", "pipe", "pipe"] })
        const ff = this._ff
        ff.stderr.on("data", (d) => this.logger.debug?.(`[ffmpeg:a] ${d}`))
        ff.on("error", (e) => this.logger.warn?.("[call-media] ffmpeg audio: " + e.message))
        ff.stdout.on("data", (chunk) => {
            for (const frame of this._demuxer.push(chunk)) {
                // cap covers a ~6 min track at 50 fps; the send timer paces it
                // out one 3-frame group per 60ms tick (~1.3 MB worst case)
                if (this._frameQueue.length < 20000) this._frameQueue.push(frame)
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
        if (this._mlowEnc) {
            const mlow = this._mlowEnc
            this._mlowEnc = null
            try { mlow.kill("SIGKILL") } catch { /* ignore */ }
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
        // _fpp=1 (standard-Opus/SILK mode): ffmpeg emits the wire frame
        // directly — a SILK WB 60 ms single (TOC 0x58), exactly what the real
        // client sends. No grouping, no builder.
        // _fpp=3 (CELT multiframe mode for a true-MLow peer): group 20 ms
        // singles into one 60 ms code-3 multiframe.
        if (!this._frameQueue || this._frameQueue.length < this._fpp) return
        const group = []
        while (group.length < this._fpp) group.push(this._frameQueue.shift())
        let payload = this._fpp === 1 ? group[0] : buildOpusMultiframe(group)
        if (!payload) {
            // builder null = all-DTX/silence group (tiny frames), or a group
            // the builder rejected. Tiny frames are forwarded raw so the
            // escape maps them to the MLow SID (0x90) and the stream keeps
            // flowing; anything else is dropped (peer PLC covers the 60 ms).
            const tiny = group.find((f) => f && f.length > 0 && f.length <= 2)
            if (!tiny) {
                this._builderRejects = (this._builderRejects || 0) + 1
                if (this._builderRejects === 1 || this._builderRejects % 100 === 0) {
                    this.logger.warn?.(
                        { rejects: this._builderRejects, shapes: group.map((f) => f && f.length) },
                        "[call-media] multiframe builder rejected group — dropping tick"
                    )
                }
                return
            }
            payload = tiny
        }
        // belt & braces: never put an Opus-escape-shaped payload (>2 B, top
        // bits 11) on the wire to an MLow peer from the NATIVE path — the
        // native encoder emits 0x50-family frames only. Native frames pass.
        if (this._peerMlow && payload.length > 2 && (payload[0] & 0xC0) === 0xC0) {
            this._builderRejects = (this._builderRejects || 0) + 1
            return
        }
        try {
            const packet = this.protectAudio(payload)
            // [diag] send-pacing: inter-send gap vs the 60 ms cadence — lets
            // the telemetry distinguish OUR pacing jitter from network jitter.
            const now = Date.now()
            if (this._lastSendAt) {
                const dev = Math.abs(now - this._lastSendAt - AUDIO_FRAME_MS)
                this._gapSum = (this._gapSum || 0) + dev
                this._gapN = (this._gapN || 0) + 1
                if (dev > (this._gapMax || 0)) this._gapMax = dev
            }
            this._lastSendAt = now
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
        if (this._summaryTimer) { clearInterval(this._summaryTimer); this._summaryTimer = null }
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
    selfKeyId,
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
    mlowEscapeOpus,
    buildOpusMultiframe,
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
    unprotectSrtcp,
    parseRtcpReportBlocks,
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
    FRAMES_PER_PACKET,
    ENCODER_FRAME_MS,
    // session
    WACallMediaSession,
}
