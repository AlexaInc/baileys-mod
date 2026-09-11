/**
 * ============================================================================
 *  testbot.js — WhatsApp call media test harness (real relay transport)
 * ============================================================================
 *
 *  Part of @alexainc/baileys-mod — https://github.com/Alexainc/baileys-mod
 *
 *  WHAT THIS DOES:
 *    - Connects to WhatsApp using the session in /home/user/uploads/creds.json
 *      (single-file creds, copied into ./testbot_auth/creds.json on boot)
 *    - HTTP control API on :3567 for driving live call tests:
 *        GET  /status                    connection + active calls + sessions
 *        POST /call      { to, audio? }  place a 1:1 call (and stream audio)
 *        POST /accept    { callId? }     answer the pending incoming call
 *        POST /joingroup { group? }      join the active group voice chat
 *        POST /stream    { input }       stream an audio file into the live call
 *        POST /stopstream                revert to silence
 *        POST /hangup    { callId? }     terminate
 *        POST /say       { to, text }    send a text message
 *    - Prints every signaling/media event so relay blocks, keys, epochs,
 *      and RTP stats can be verified live.
 *
 *  RUN:
 *    node testbot.js
 * ============================================================================
 */

'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const P = require('pino')

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('.')

const CREDS_SRC = process.env.CREDS || '/home/user/uploads/creds.json'
const AUTH_DIR = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(__dirname, 'testbot_auth')
const HTTP_PORT = +(process.env.PORT || 3567)
const TEST_TO = process.env.TEST_TO || '94766045156@s.whatsapp.net'
const TEST_GROUP = process.env.TEST_GROUP || '120363429485478824@g.us'
const AUTO_JOIN_GROUP = process.env.AUTO_JOIN_GROUP === '1'

const logger = P({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.LOG_PRETTY ? { target: 'pino-pretty' } : undefined,
})

let sock = null
let state = { connected: false, qr: null, lastDisconnect: null }
const incomingCalls = new Map() // callId → last event

async function connect() {
    // seed creds from the uploads copy, then use the standard auth state
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    const dst = path.join(AUTH_DIR, 'creds.json')
    if (!fs.existsSync(dst) && fs.existsSync(CREDS_SRC)) {
        fs.copyFileSync(CREDS_SRC, dst)
        logger.info({ from: CREDS_SRC }, 'creds seeded')
    }
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger),
        },
        markOnlineOnConnect: false,
        syncFullHistory: false,
        browser: ['Baileys-Mod', 'Chrome', '120.0.0'],
    })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { state.qr = qr; logger.info('QR available (should not be needed with seeded creds)') }
        if (connection === 'open') {
            state.connected = true
            state.qr = null
            const me = sock?.authState?.creds?.me
            logger.info({ me: me?.id, lid: me?.lid }, '✅ connected')
            if (AUTO_JOIN_GROUP) joinGroup(TEST_GROUP).catch((e) => logger.error({ err: e.message }, 'auto join failed'))
        }
        if (connection === 'close') {
            state.connected = false
            state.lastDisconnect = lastDisconnect?.error?.message || String(lastDisconnect?.error?.output?.statusCode)
            const code = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = code !== DisconnectReason.loggedOut
            logger.warn({ code, shouldReconnect }, 'connection closed')
            if (shouldReconnect) setTimeout(connect, 3000)
        }
    })

    const seenStatuses = new Map()
    sock.ev.on('call', async ([call]) => {
        if (!call) return
        incomingCalls.set(call.id, call)
        const seen = seenStatuses.get(call.id) || new Set()
        seenStatuses.set(call.id, seen)
        if (!seen.has(call.status)) {
            seen.add(call.status)
            logger.info(
                { callId: call.id, status: call.status, from: call.from, group: !!call.isGroup, video: !!call.isVideo, hasKey: !!call.callKey },
                '📞 call event'
            )
        }
        if (call.status === 'offer' && !call.isGroup) {
            // [MOD] auto-answer every 1:1 call within seconds (standing
            // requirement) and stream the song immediately. Inbound offers
            // carry relays near the CALLER (their region), so answering gives
            // the caller a short local media leg — usually much better than
            // our outbound calls (server hands our US egress US-only relays).
            const song = process.env.INBOUND_AUDIO || '/home/user/uploads/55BS8QO5C9o.mp3'
            const fsOk = require('fs').existsSync(song)
            logger.info({ callId: call.id, from: call.from, song: fsOk ? song : null },
                '📥 incoming 1:1 call — AUTO-ANSWERING (immediate accept + song)')
            try {
                // claim the call in monitor.sh's HANDLED file so its slower
                // poll-based accept+connect doesn't double-answer behind us
                try { require('fs').appendFileSync('/home/user/.watcher_handled.txt', call.id + '\n') } catch { /* best effort */ }
                await sock.acceptCall(call.id, call.from, {
                    deferToMuteV2: false,
                    connectMedia: fsOk,
                    audioInput: fsOk ? song : undefined,
                    relayTimeoutMs: 60000,
                })
                logger.info({ callId: call.id }, '✅ auto-accept sent (immediate)')
            } catch (e) {
                logger.warn({ callId: call.id, err: e?.message }, 'auto-accept failed — POST /accept still possible')
            }
        }
        if (call.status === 'terminate' || call.status === 'reject' || call.status === 'timeout') {
            incomingCalls.delete(call.id)
        }
    })

    sock.ev.on('call.media', (m) => {
        if (m.status === 'rtp') {
            // log first few inbound RTP packets, then every 100th
            rtpSeen++
            if (rtpSeen <= 5 || rtpSeen % 100 === 0) {
                logger.info({ callId: m.callId, n: rtpSeen, pt: m.header?.payloadType, seq: m.header?.sequenceNumber, bytes: m.payload?.length, from: m.participantId }, '🔊 inbound RTP decrypted')
            }
        } else if (m.status !== 'rtp') {
            logger.info({ ...m }, '🎧 media event: ' + m.status)
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption
            if (text) {
                logger.info({ from: msg.key.remoteJid, text, ts: msg.messageTimestamp }, '💬 message')
                // always acknowledge so the sender knows it reached the bot
                try {
                    const st = statusPayload()
                    const live = (st.sessions || []).length ? ` | 🎵 streaming: ${st.sessions.length} session(s)` : ' | no live call'
                    await sock.sendMessage(msg.key.remoteJid, { text: '👀 got it — operator is watching.' + live })
                } catch { /* best effort */ }
                if (text === '!status') {
                    sock.sendMessage(msg.key.remoteJid, { text: JSON.stringify(statusPayload(), null, 1) })
                }
            } else if (msg.message) {
                // non-text messages (images, voice notes, stickers...) — note them
                const kinds = Object.keys(msg.message).join(',')
                logger.info({ from: msg.key.remoteJid, kinds }, '💬 message (non-text)')
            }
        }
    })
}

let rtpSeen = 0

// ─── actions ────────────────────────────────────────────────────────────────
async function placeCall(to, audio) {
    const res = await sock.offerCall(to, false)
    logger.info({ callId: res.id, to }, '📞 outgoing call offered')
    if (audio !== undefined && audio) {
        // connect media RIGHT AWAY with SILENCE (the phone drops the call
        // ~30s after accepting if it sees no media), and start the actual
        // song when the callee ACCEPTS — by then the preaccept/accept
        // capability sniff has set the peer's MLOW profile, so every song
        // frame goes out in the right format from the very first packet.
        const p = sock.connectCall(res.id, to, null, { relayTimeoutMs: 60000 })
        const onAccept = (calls) => {
            for (const c of calls || []) {
                if (c?.id === res.id && c?.status === 'accept') {
                    sock.ev.off('call', onAccept)
                    try {
                        const s = sock.getCallMediaSession(res.id)
                        if (s) { s.streamAudio(audio); logger.info({ callId: res.id, input: audio }, '🎵 song started at callee accept') }
                    } catch (e) { logger.warn({ err: e.message }, 'song start failed') }
                    return
                }
                if (c?.id === res.id && (c?.status === 'terminate' || c?.status === 'timeout' || c?.status === 'reject')) {
                    sock.ev.off('call', onAccept)
                }
            }
        }
        sock.ev.on('call', onAccept)
        return p
    }
    if (audio !== undefined) {
        return sock.connectCall(res.id, to, null, { relayTimeoutMs: 60000 })
    }
    return res
}

async function acceptPending(callId) {
    const id = callId || [...incomingCalls.keys()].pop()
    if (!id) throw new Error('no pending incoming call')
    const call = incomingCalls.get(id)
    // [fix] deferToMuteV2 waits for the caller's mute_v2 before sending
    // <accept> — but this caller's client sends mute/transport only AFTER
    // seeing our accept (verified live 00:37 run). Accept immediately.
    await sock.acceptCall(id, call.from, { deferToMuteV2: false, connectMedia: false })
    logger.info({ callId: id }, '✅ accept sent (immediate)')
    return { id, accepted: true }
}

async function joinGroup(groupJid, audio) {
    const session = await sock.joinGroupCall(groupJid, audio ?? null, { relayTimeoutMs: 90000 })
    logger.info({ group: groupJid }, '🎧 group call joined')
    return session
}

async function streamInto(input, callId) {
    const id = callId || currentSessionId()
    const session = sock.getCallMediaSession(id)
    if (!session) throw new Error('no live media session for ' + id)
    session.streamAudio(input)
    return { ok: true, callId: id, input }
}

function currentSessionId() {
    // last connected session id
    const ids = sock.getActiveGroupCalls?.() || []
    return ids.length ? ids[ids.length - 1].callId : null
}

function statusPayload() {
    const sessions = []
    for (const [callId, s] of (sock.getCallMediaSession ? allSessions() : [])) {
        sessions.push({
            callId, connected: s.connected, closed: s.closed,
            tx: s.txCount, rx: s.rxCount,
            endpoint: s.endpoint ? `${s.endpoint.ip}:${s.endpoint.port}` : null,
            ssrc: s.ssrc, group: s.group,
        })
    }
    return {
        connected: state.connected,
        me: sock?.authState?.creds?.me,
        groupCalls: (sock?.getActiveGroupCalls?.() || []).map((c) => ({ group: c.groupJid, callId: c.callId, creator: c.callCreator })),
        incoming: [...incomingCalls.values()].map((c) => ({ id: c.id, from: c.from, status: c.status, group: !!c.isGroup, hasKey: !!c.callKey })),
        sessions,
    }
}

// track sessions via call.media events (media sessions map is internal)
const liveSessions = new Map()
function watchSessions() {
    if (!sock) return
    sock.ev.on('call.media', (m) => {
        if (m.status === 'connected') liveSessions.set(m.callId, true)
        if (m.status === 'closed') liveSessions.delete(m.callId)
    })
}
function allSessions() {
    const out = []
    for (const callId of liveSessions.keys()) {
        const s = sock.getCallMediaSession(callId)
        if (s) out.push([callId, s])
    }
    return out
}

// ─── HTTP control ───────────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => {
            try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) }
        })
    })
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost')
        const route = req.method + ' ' + url.pathname
        const body = req.method === 'POST' ? await readBody(req) : {}

        if (route === 'GET /status') {
            return json(res, statusPayload())
        }
        if (route === 'POST /call') {
            const to = body.to || TEST_TO
            const audio = body.audio !== undefined ? body.audio : null
            placeCall(to, audio).catch((e) => logger.error({ err: e.message }, 'placeCall failed'))
            watchSessions()
            return json(res, { ok: true, to, note: 'connecting media in background — watch logs / GET /status' })
        }
        if (route === 'POST /accept') {
            const out = await acceptPending(body.callId)
            watchSessions()
            return json(res, out)
        }
        if (route === 'POST /connect') {
            // connect media for an existing call (e.g. after arming accept)
            const id = body.callId || [...incomingCalls.keys()].pop()
            const call = incomingCalls.get(id)
            const session = await sock.connectCall(id, body.from || call?.from || id, body.audio ?? null, { relayTimeoutMs: 60000 })
            watchSessions()
            return json(res, { ok: true, callId: id })
        }
        if (route === 'POST /joingroup') {
            const session = await joinGroup(body.group || TEST_GROUP, body.audio ?? null)
            watchSessions()
            return json(res, { ok: true })
        }
        if (route === 'POST /stream') {
            const out = await streamInto(body.input || '/home/user/uploads/test.mp3', body.callId)
            return json(res, out)
        }
        if (route === 'POST /stopstream') {
            const id = body.callId || [...liveSessions.keys()].pop()
            const s = sock.getCallMediaSession(id)
            if (s) { s.stopAudio(); return json(res, { ok: true }) }
            return json(res, { ok: false, err: 'no session' }, 404)
        }
        if (route === 'POST /acceptcfg') {
            Object.assign(sock.acceptConfig, body || {})
            return json(res, { ok: true, cfg: sock.acceptConfig })
        }
        if (route === 'POST /hangup') {
            const id = body.callId || [...incomingCalls.keys()].pop() || [...liveSessions.keys()].pop()
            if (!id) return json(res, { ok: false, err: 'no call' }, 404)
            await sock.terminateCall(id, incomingCalls.get(id)?.from || TEST_TO).catch(() => {})
            sock.stopCallMedia?.(id)
            return json(res, { ok: true, callId: id })
        }
        if (route === 'POST /say') {
            await sock.sendMessage(body.to || TEST_TO, { text: body.text || 'hello from testbot' })
            return json(res, { ok: true })
        }
        if (route === 'POST /sayimage') {
            // send an image file (e.g. the headless WA Web QR) to a chat
            await sock.sendMessage(body.to || TEST_TO, { image: { url: body.path }, caption: body.caption || '' })
            return json(res, { ok: true })
        }
        return json(res, { err: 'unknown route', routes: ['GET /status', 'POST /call', 'POST /accept', 'POST /connect', 'POST /joingroup', 'POST /stream', 'POST /stopstream', 'POST /hangup', 'POST /say', 'POST /acceptcfg'] }, 404)
    } catch (e) {
        return json(res, { err: e.message, stack: (e.stack || '').split('\n').slice(0, 4) }, 500)
    }
})

function json(res, obj, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj, null, 1))
}

// ─── go ─────────────────────────────────────────────────────────────────────
connect().then(() => {
    watchSessions()
    server.listen(HTTP_PORT, '0.0.0.0', () => {
        logger.info(`🤖 testbot control API on http://0.0.0.0:${HTTP_PORT} (GET /status)`)
        logger.info({ TEST_TO, TEST_GROUP, AUTO_JOIN_GROUP }, 'config')
    })
})

process.on('unhandledRejection', (e) => logger.error({ err: e?.message, stack: e?.stack?.split('\n')?.slice(0, 3) }, 'unhandledRejection'))
