/** Emulation 1: realistic bot consumer. */
import makeWASocket, {
    useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, downloadMediaMessage, jidNormalizedUser,
    isJidGroup, getContentType, delay, proto, Browsers,
    type WASocket, type WAMessage, type WAMessageKey, type GroupMetadata,
    type AnyMessageContent, type ConnectionState, type ILogger
} from '@alexainc/baileys-mod'

declare const logger: ILogger
declare const boomLike: { output?: { statusCode?: number } }

async function main(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`WA v${version.join('.')} latest=${isLatest}`)

    const sock: WASocket = makeWASocket({
        version, logger, printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        generateHighQualityLinkPreview: true, markOnlineOnConnect: false, syncFullHistory: false
    })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr, isOnline, receivedPendingNotifications } = u
        if (qr) console.log('QR len', qr.length)
        if (isOnline !== undefined) console.log('online', isOnline)
        if (receivedPendingNotifications) console.log('pending flushed')
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            console.log('reconnect?', code !== DisconnectReason.loggedOut, lastDisconnect?.date.getTime())
        } else if (connection === 'open') console.log('me', sock.user?.id, sock.user?.lid)
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) {
            const key: WAMessageKey = msg.key
            const jid = key.remoteJid
            if (!jid || key.fromMe) continue
            const ctype = getContentType(msg.message)
            const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? ''
            console.log(`[${ctype}] ${jidNormalizedUser(jid)}: ${text}`)
            await sock.readMessages([key])
            await sock.sendPresenceUpdate('composing', jid)
            await delay(300)
            if (text === '!ping') await sock.sendMessage(jid, { text: 'pong' } as AnyMessageContent, { quoted: msg })
            if (ctype === 'imageMessage') {
                const buf = await downloadMediaMessage(msg, 'buffer')
                console.log('bytes', buf.length)
            }
            if (isJidGroup(jid)) {
                const meta: GroupMetadata = await sock.groupMetadata(jid)
                console.log(meta.subject, meta.participants.length, meta.announce, meta.isCommunity)
            }
        }
    })

    sock.ev.on('messages.update', us => {
        for (const { key, update } of us)
            if (update.status === proto.WebMessageInfo.Status.READ) console.log('read', key.id)
    })
    sock.ev.on('messaging-history.set', h => {
        console.log(h.chats.length, h.contacts.length, h.messages.length, h.isLatest, h.progress, h.syncType)
        for (const c of h.chats) console.log(c.id, c.unreadCount, c.lastMessageRecvTimestamp, c.muteEndTime)
    })
    sock.ev.on('groups.update', ([g]) => console.log(g?.id, g?.subject))
    sock.ev.on('call', calls => calls.forEach(c => console.log(c.from, c.status, c.isVideo, c.offline)))
}
export { main }
