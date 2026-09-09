/**
 * ============================================================================
 *  call-demo.js — Real interactive call test bot
 * ============================================================================
 *
 *  Part of @alexainc/baileys-mod
 *
 *  WHAT THIS DOES:
 *    - Connects to WhatsApp (shows QR in terminal or uses pairing code)
 *    - Receives incoming calls → prints full call details, auto-answers,
 *      connects ICE media transport (if ffmpeg is on PATH you can stream audio)
 *    - Sends outgoing calls via the !call <number> text command
 *    - Reports every call event with timestamps in terminal
 *    - Gracefully handles reject / terminate / timeout
 *
 *  RUN:
 *    node examples/call-demo.js                        # QR login
 *    WA_NUMBER=94XXXXXXXXX node examples/call-demo.js --pairing  # pairing code
 *
 *  CALL FROM ANOTHER ACCOUNT:
 *    Simply call the linked number from your phone WhatsApp — the bot will
 *    auto-answer and print the decrypted media callKey + ICE result.
 *
 *  PLACE A CALL FROM THIS BOT:
 *    Send a WhatsApp message to THIS bot's number:
 *      !call 94XXXXXXXXX        (number without + or spaces)
 *      !vcall 94XXXXXXXXX       (video call)
 *      !reject                  (reject current incoming call)
 *      !hangup                  (terminate active call)
 *      !status                  (show active call state)
 *
 *  ⚠️  Automating calls can get a number banned. Use a throwaway number.
 * ============================================================================
 */

'use strict'

const path = require('path')
const P = require('pino')
const { Boom } = require('@hapi/boom')

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('..')   // repo root (lib/index.js)

// ─── config ──────────────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2))
const USE_PAIRING = ARGS.has('--pairing')
const WA_NUMBER = process.env.WA_NUMBER || ''
const AUTO_ANSWER = !ARGS.has('--no-auto-answer')   // answer incoming calls automatically
const AUDIO_FILE = process.env.CALL_AUDIO || null  // optional: path to audio file to stream
const AUTH_DIR = path.join(__dirname, 'call_demo_auth')

// ─── logger ──────────────────────────────────────────────────────────────────
const logger = P({ level: process.env.LOG_LEVEL || 'info' })

// ─── runtime state ───────────────────────────────────────────────────────────
let activeCalls = new Map()   // callId -> call object
let pendingCalls = new Map()   // callId -> call object (incoming, not yet answered)

// pretty-print a call event
function logCall(label, call) {
    const ts = new Date().toISOString()
    const key = call.callKeyHex ? call.callKeyHex.substring(0, 16) + '...' : 'null'
    logger.info(
        `[${ts}] *** CALL ${label} ***\n` +
        `  id:       ${call.id}\n` +
        `  from:     ${call.from || call.chatId}\n` +
        `  status:   ${call.status}\n` +
        `  video:    ${call.isVideo ? 'yes' : 'no'}\n` +
        `  group:    ${call.isGroup ? 'yes' : 'no'}\n` +
        `  callKey:  ${key}`
    )
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version, isLatest } = await fetchLatestBaileysVersion()
    logger.info({ version, isLatest }, 'WA version')

    const sock = makeWASocket({
        version,
        logger: logger.child({ name: 'sock' }),
        printQRInTerminal: !USE_PAIRING,   // QR drawn here in terminal
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['CallDemoBot', 'Chrome', '1.0.0'],
    })

    // ── pairing code path ──────────────────────────────────────────────────
    if (USE_PAIRING && !sock.authState.creds.registered) {
        if (!WA_NUMBER) {
            logger.error('Set WA_NUMBER=<number> for --pairing mode')
            process.exit(1)
        }
        setTimeout(async () => {
            let pairingCode = ''
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
            for (let i = 0; i < 8; i++) pairingCode += chars.charAt(Math.floor(Math.random() * chars.length))
            const code = await sock.requestPairingCode(WA_NUMBER, pairingCode)

            // Format code with a dash for readability (e.g. ABCD-EFGH)
            const formattedCode = code.match(/.{1,4}/g)?.join('-') || code

            console.log('\n╔══════════════════════════════╗')
            console.log('║  PAIRING CODE: ' + formattedCode.padEnd(11) + '   ║')
            console.log('╚══════════════════════════════╝\n')
            console.log('Enter this code in WhatsApp → Linked Devices → Link a Device\n')
        }, 3000)
    }

    sock.ev.on('creds.update', saveCreds)

    // ── connection status ──────────────────────────────────────────────────
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u
        if (qr) {
            console.log('\n✅  Scan the QR code above with WhatsApp to link your account.\n')
        }
        if (connection === 'open') {
            const me = sock.authState.creds.me
            console.log('\n╔════════════════════════════════════════╗')
            console.log('║  ✅  CONNECTED TO WHATSAPP              ║')
            console.log(`║  Number: ${(me?.id || '').split(':')[0].padEnd(30)}║`)
            console.log('╠════════════════════════════════════════╣')
            console.log('║  CALL COMMANDS (send to this bot):     ║')
            console.log('║  !call <number>   — place voice call   ║')
            console.log('║  !vcall <number>  — place video call   ║')
            console.log('║  !reject          — reject pending call ║')
            console.log('║  !hangup          — terminate call      ║')
            console.log('║  !status          — show call state     ║')
            console.log('╚════════════════════════════════════════╝\n')
            console.log('↓  Waiting for events... (call this number from another account)\n')
        }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode
            logger.warn({ code }, 'Connection closed')
            if (code !== DisconnectReason.loggedOut) {
                logger.info('Reconnecting in 3 s...')
                setTimeout(start, 3000)
            } else {
                logger.error('Logged out — delete call_demo_auth/ and restart to re-login')
                process.exit(1)
            }
        }
    })

    // ─────────────────────────────────────────────────────────────────────────
    //  CALL EVENT HANDLER
    // ─────────────────────────────────────────────────────────────────────────
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            logCall(call.status.toUpperCase(), call)

            if (call.status === 'offer') {
                // WhatsApp retransmits offer stanzas — answer each call ONCE
                if (pendingCalls.has(call.id) || activeCalls.has(call.id)) {
                    console.log(`\n[SKIP] Duplicate offer for ${call.id} — already handled\n`)
                    continue
                }
                pendingCalls.set(call.id, call)

                if (AUTO_ANSWER) {
                    console.log(`\n[AUTO-ANSWER] Answering call ${call.id} in 1 s...\n`)
                    setTimeout(() => answerCall(sock, call), 1000)
                } else {
                    console.log(`\n[INCOMING CALL] Use !reject to reject or !status to check\n`)
                }
            }

            if (call.status === 'accept') {
                console.log(`\n✅  Remote side accepted call ${call.id}`)
                activeCalls.set(call.id, call)
            }

            if (['terminate', 'reject', 'timeout'].includes(call.status)) {
                pendingCalls.delete(call.id)
                activeCalls.delete(call.id)
                sock.stopCallMedia(call.id)
                console.log(`\n📵  Call ${call.id} ended (${call.status})\n`)
            }
        }
    })

    // ─────────────────────────────────────────────────────────────────────────
    //  TEXT COMMAND HANDLER  (send messages TO THIS BOT from any account)
    // ─────────────────────────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue
            const text =
                m.message.conversation ||
                m.message.extendedTextMessage?.text || ''
            if (!text.startsWith('!')) continue

            const [cmd, ...rest] = text.trim().split(/\s+/)
            const arg = rest.join('').trim()
            const jid = m.key.remoteJid
            const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

            try {
                switch (cmd.toLowerCase()) {
                    case '!call':
                    case '!vcall': {
                        if (!arg) { await reply('Usage: !call <number>  (digits only, no spaces)'); break }
                        const toJid = arg.includes('@') ? arg : `${arg}@s.whatsapp.net`
                        const isVideo = cmd === '!vcall'
                        await reply(`📞 Placing ${isVideo ? 'video ' : ''}call to ${arg}…`)
                        const { id } = await sock.offerCall(toJid, isVideo)
                        activeCalls.set(id, { id, to: toJid, isVideo, status: 'offer' })
                        console.log(`\n[OUTGOING CALL] callId=${id} to=${toJid}\n`)
                        await reply(`✅ Call placed. callId: ${id}`)
                        break
                    }
                    case '!reject': {
                        const [callId, call] = [...pendingCalls.entries()][0] || []
                        if (!call) { await reply('No pending call to reject'); break }
                        await sock.rejectCall(call.id, call.chatId || call.from)
                        pendingCalls.delete(callId)
                        await reply('📵 Call rejected')
                        break
                    }
                    case '!hangup': {
                        const [callId, call] = [...activeCalls.entries()][0] || []
                        if (!call) { await reply('No active call to hang up'); break }
                        await sock.terminateCall(call.id, call.chatId || call.from)
                        activeCalls.delete(callId)
                        pendingCalls.delete(callId)
                        await reply('📵 Hung up')
                        break
                    }
                    case '!status': {
                        const pending = [...pendingCalls.values()].map(c => `⏳ PENDING  ${c.id.substring(0, 12)} from=${c.from || c.chatId}`).join('\n') || '(none)'
                        const active = [...activeCalls.values()].map(c => `✅ ACTIVE   ${c.id.substring(0, 12)}`).join('\n') || '(none)'
                        await reply(`📊 Call Status\nPending:\n${pending}\nActive:\n${active}`)
                        break
                    }
                    default:
                        break
                }
            } catch (e) {
                logger.error(e, 'command error')
                await reply('⚠️ ' + (e.message || 'error'))
            }
        }
    })

    return sock
}

// ─── answer helper ────────────────────────────────────────────────────────────
async function answerCall(sock, call) {
    try {
        console.log(`\n[ACCEPT] Arming accept for ${call.id} (real clients send it after the caller's first mute_v2)`)
        const res = await sock.acceptCall(call.id, call.chatId || call.from)

        console.log(`✅  acceptCall armed (deferred to caller's mute_v2; preaccept already sent on offer)`)
        console.log(`   callKey (hex): ${res.callKeyHex || 'null'}`)
        console.log(`   isVideo:       ${res.isVideo}`)

        pendingCalls.delete(call.id)
        activeCalls.set(call.id, { ...call, callKey: res.callKey })

        // Attempt to connect ICE media transport
        console.log(`\n[ICE] Connecting media transport (8 s timeout)…`)
        try {
            const session = await sock.connectCall(
                call.id,
                call.chatId || call.from,
                AUDIO_FILE || undefined,   // stream audio file if set
                { relayTimeoutMs: 30000 }
            )
            console.log(`✅  Relay DataChannel connected — media session open`)

            session.on('rtp', ({ from }) => {
                process.stdout.write('.')  // show incoming RTP without log spam
            })
            session.on('closed', () => {
                console.log(`\n[MEDIA] Session closed for ${call.id}`)
                activeCalls.delete(call.id)
            })

            if (AUDIO_FILE) {
                session.streamAudio(AUDIO_FILE)
                console.log(`▶️  Streaming: ${AUDIO_FILE}`)
            } else {
                console.log(`ℹ️  No CALL_AUDIO set — call connected but no audio streamed.`)
                console.log(`   Set CALL_AUDIO=/path/to/file.mp3 to stream audio.`)
            }
        } catch (iceErr) {
            console.log(`\n⚠️  media connect failed (${iceErr.message})`)
            console.log(res.callKeyHex
                ? `   Signaling (accept/preaccept) DID work — callKey was decrypted.`
                : `   ⚠️  callKey is MISSING — check the [MOD] decryptCallKey logs above.`)
        }
    } catch (e) {
        console.error('[ACCEPT ERROR]', e.message)
        logger.error(e, 'answerCall failed')
    }
}

// ─── entry point ─────────────────────────────────────────────────────────────
start().catch((e) => { logger.error(e, 'fatal'); process.exit(1) })
