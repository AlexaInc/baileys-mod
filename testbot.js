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
const AUTH_DIR = path.join(__dirname, 'testbot_auth')
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
            logger.info({ me: creds.me?.id, lid: creds.me?.lid }, '✅ connected')
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

    sock.ev.on('call', async ([call]) => {
        if (!call) return
        incomingCalls.set(call.id, call)
        logger.info(
            { callId: call.id, status: call.status, from: call.from, group: !!call.isGroup, video: !!call.isVideo, hasKey: !!call.callKey },
            '📞 call event'
        )
        if (call.status === 'offer' && !call.isGroup) {
            logger.info({ callId: call.id }, 'incoming 1:1 call — use POST /accept to answer (auto preaccept already sent)')
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
            if (text) {
                logger.info({ from: msg.key.remoteJid, text }, '💬 message')
                if (text === '!status') {
                    sock.sendMessage(msg.key.remoteJid, { text: JSON.stringify(statusPayload(), null, 1) })
                }
            }
        }
    })
}

let rtpSeen = 0

// ─── actions ────────────────────────────────────────────────────────────────
async function placeCall(to, audio) {
    const res = await sock.offerCall(to, false)
    logger.info({ callId: res.id, to }, '📞 outgoing call offered')
    if (audio !== undefined && audio !== null) {
        return sock.connectCall(res.id, to, audio || null, { relayTimeoutMs: 60000 })
    }
    return res
}

async function acceptPending(callId) {
    const id = callId || [...incomingCalls.keys()].pop()
    if (!id) throw new Error('no pending incoming call')
    const call = incomingCalls.get(id)
    await sock.acceptCall(id, call.from, { deferToMuteV2: true, connectMedia: false })
    logger.info({ callId: id }, '✅ accept armed (waiting for caller mute_v2)')
    return { id, armed: true }
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
            const out = await placeCall(to, audio)
            watchSessions()
            return json(res, { ok: true, callId: out.id, to })
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
        return json(res, { err: 'unknown route', routes: ['GET /status', 'POST /call', 'POST /accept', 'POST /connect', 'POST /joingroup', 'POST /stream', 'POST /stopstream', 'POST /hangup', 'POST /say'] }, 404)
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
