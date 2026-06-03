/**
 * ============================================================================
 *  music-bot.js — group voice-chat music bot (pytgcalls style)
 * ============================================================================
 *
 *  Part of @alexainc/baileys-mod — https://github.com/Alexainc/baileys-mod
 *  Author: hansaka@alexainc
 *
 *  A copy-paste starting point for building music / stream bots on top of this
 *  the baileys-mod call API. It joins an ongoing WhatsApp group voice chat and streams
 *  audio, with a per-group queue.
 *
 *  Commands (send in a group the bot is in):
 *    !play <url|file>   queue a track; joins the voice chat if not already in
 *    !vplay <url> [q]   stream video (optional quality: 360p/480p/720p/1080p)
 *    !skip              skip the current track
 *    !stop              stop playback, clear queue, leave the voice chat
 *    !queue             show the queue
 *    !ping              health check
 *
 *  Audio source: anything FFmpeg can read — a direct media URL, a local file,
 *  an HLS/DASH manifest, an icecast/radio stream, etc. For YouTube etc. pipe a
 *  resolver (e.g. yt-dlp -o -) into a file/URL first; that's out of scope here.
 *
 *  Requirements:
 *    - ffmpeg on PATH
 *    - a started group voice chat (the bot discovers it via getCallInfo)
 *
 *  Run:
 *    node examples/music-bot.js              # QR login
 *    WA_NUMBER=94XXXXXXXXX node examples/music-bot.js --pairing
 *
 *  ⚠️  Automating calls can get a number banned. Use a throwaway number.
 * ============================================================================
 */

const path = require('path')
const P = require('pino')

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('..') // the modified fork (repo root)

const { Boom } = require('@hapi/boom')

const ARGS = new Set(process.argv.slice(2))
const USE_PAIRING = ARGS.has('--pairing')
const PREFIX = '!'

const logger = P({ level: process.env.LOG_LEVEL || 'info' })

// per-group player state: groupJid -> { session, queue: [], current, playing }
const players = new Map()

function getPlayer(groupJid) {
    if (!players.has(groupJid)) {
        players.set(groupJid, { session: null, queue: [], current: null, playing: false })
    }
    return players.get(groupJid)
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(__dirname, 'auth_state')
    )
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: !USE_PAIRING,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['MusicBot', 'Chrome', '1.0.0'],
    })

    if (USE_PAIRING && !sock.authState.creds.registered) {
        const number = process.env.WA_NUMBER
        if (!number) { logger.error('Set WA_NUMBER for --pairing'); process.exit(1) }
        setTimeout(async () => logger.info('PAIRING CODE: ' + await sock.requestPairingCode(number)), 3000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u
        if (connection === 'close') {
            const reconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            logger.warn({ reconnect }, 'connection closed')
            if (reconnect) start()
        } else if (connection === 'open') {
            logger.info('✅ music bot online. Start a group voice chat, then send !play <url>')
        }
    })

    // ----------------------------------------------------------------------
    //  command handling
    // ----------------------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue
            const jid = m.key.remoteJid
            if (!jid || !jid.endsWith('@g.us')) continue // groups only

            const text =
                m.message.conversation ||
                m.message.extendedTextMessage?.text || ''
            if (!text.startsWith(PREFIX)) continue

            const [cmd, ...rest] = text.slice(PREFIX.length).trim().split(/\s+/)
            const arg = rest.join(' ').trim()
            const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

            try {
                switch (cmd.toLowerCase()) {
                    case 'ping':
                        await reply('🏓 pong')
                        break

                    case 'play':
                        await cmdPlay(sock, jid, arg, reply)
                        break

                    case 'vplay': // !vplay <url|file> [preset]  e.g. !vplay clip.mp4 720p
                        await cmdVplay(sock, jid, rest, reply)
                        break

                    case 'skip':
                        await cmdSkip(sock, jid, reply)
                        break

                    case 'stop':
                        await cmdStop(sock, jid, reply)
                        break

                    case 'queue':
                        await cmdQueue(jid, reply)
                        break

                    default:
                        // ignore unknown commands
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

// --------------------------------------------------------------------------
//  commands
// --------------------------------------------------------------------------

// stream video into the call with an optional quality preset
async function cmdVplay(sock, groupJid, rest, reply) {
    const source = rest[0]
    const preset = rest[1] // e.g. 720p, 480p
    if (!source) return reply('usage: !vplay <url|file> [144p|240p|360p|480p|720p|1080p]')

    const player = getPlayer(groupJid)
    if (!player.session) {
        await reply('🔎 looking for an active voice chat…')
        const info = await sock.getCallInfo(groupJid).catch(() => null)
        if (!info || !info.callId) {
            return reply('❌ no active group call found. Start a voice/video chat first.')
        }
        await reply('🎙️ joining…')
        player.session = await sock.joinGroupCall(groupJid)
        wireSession(sock, groupJid, player)
    }
    const quality = preset ? { preset } : {}
    player.session.streamVideo(source, quality)
    await reply(`📹 streaming video${preset ? ` @ ${preset}` : ''}:\n${source}`)
}

async function cmdPlay(sock, groupJid, source, reply) {
    if (!source) return reply('usage: !play <url|file>')

    const player = getPlayer(groupJid)
    player.queue.push(source)
    logger.info({ groupJid, source }, 'queued track')

    if (!player.session) {
        // discover + join the ongoing group voice chat (pytgcalls join_group_call)
        await reply('🔎 looking for an active voice chat…')
        const info = await sock.getCallInfo(groupJid).catch(() => null)
        if (!info || !info.callId) {
            player.queue.pop()
            return reply('❌ no active group voice chat found. Start one in the group first, then !play again.')
        }
        await reply('🎙️ joining voice chat…')
        player.session = await sock.joinGroupCall(groupJid)
        wireSession(sock, groupJid, player)
        await reply(`✅ joined. Added to queue:\n${source}`)
        playNext(sock, groupJid, reply)
    } else if (!player.playing) {
        await reply(`▶️ added & starting:\n${source}`)
        playNext(sock, groupJid, reply)
    } else {
        await reply(`➕ queued (#${player.queue.length}):\n${source}`)
    }
}

function wireSession(sock, groupJid, player) {
    const s = player.session
    if (!s) return
    s.on('connected', (pair) => logger.info({ pair }, '[music] media connected'))
    s.on('trackEnd', ({ skipped }) => {
        logger.info({ groupJid, skipped }, '[music] track ended')
        player.playing = false
        player.current = null
        playNext(sock, groupJid, (t) => sock.sendMessage(groupJid, { text: t }))
    })
    s.on('closed', () => {
        logger.info({ groupJid }, '[music] session closed')
        players.delete(groupJid)
    })
}

function playNext(sock, groupJid, reply) {
    const player = getPlayer(groupJid)
    if (player.playing) return
    const next = player.queue.shift()
    if (!next) {
        // nothing left — stay in the call idle (or auto-leave: uncomment below)
        // cmdStop(sock, groupJid, reply)
        return
    }
    player.current = next
    player.playing = true
    try {
        player.session.streamAudio(next)
        reply(`🎵 now playing:\n${next}`)
    } catch (e) {
        player.playing = false
        reply('⚠️ failed to play: ' + e.message)
        playNext(sock, groupJid, reply)
    }
}

async function cmdSkip(sock, groupJid, reply) {
    const player = players.get(groupJid)
    if (!player || !player.session || !player.playing) return reply('nothing is playing')
    await reply('⏭️ skipping…')
    // stopAudio triggers trackEnd(skipped:true) -> playNext advances
    player.session.stopAudio()
    player.playing = false
    playNext(sock, groupJid, reply)
}

async function cmdStop(sock, groupJid, reply) {
    const player = players.get(groupJid)
    if (!player || !player.session) return reply('not in a voice chat')
    player.queue = []
    player.playing = false
    player.current = null
    try { sock.stopCallMedia(player.session.callId) } catch {}
    try { player.session.close() } catch {}
    players.delete(groupJid)
    await reply('⏹️ stopped & left the voice chat')
}

async function cmdQueue(groupJid, reply) {
    const player = players.get(groupJid)
    if (!player || (!player.current && player.queue.length === 0)) return reply('queue is empty')
    let out = ''
    if (player.current) out += `▶️ now: ${player.current}\n`
    if (player.queue.length) {
        out += '\nup next:\n' + player.queue.map((t, i) => `${i + 1}. ${t}`).join('\n')
    }
    await reply(out.trim())
}

start().catch((e) => { logger.error(e, 'fatal'); process.exit(1) })
