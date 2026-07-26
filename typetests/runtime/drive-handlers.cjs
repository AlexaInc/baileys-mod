/**
 * Drives baileys-mod's REAL internal processing functions with authentic
 * WhatsApp protobuf/binary-node payloads, then compares the objects the
 * library actually produces against what types.d.ts declares.
 *
 * This covers the code paths a live pairing would exercise (history sync,
 * contact sync, chat mutations, receipts, calls, group metadata) without
 * needing WhatsApp's TLS endpoint.
 */
const P = require('../../lib')
const pino = require('../../node_modules/pino')
const { proto } = P
const logger = pino({ level: 'silent' })

const results = []
const check = (name, obj, expectKeys) => {
    const keys = obj && typeof obj === 'object' ? Object.keys(obj) : []
    results.push({ name, keys, obj })
    console.log('\n=== ' + name)
    console.log('  runtime keys: ' + JSON.stringify(keys))
    if (expectKeys) {
        const missing = expectKeys.filter(k => !keys.includes(k))
        if (missing.length) console.log('  !! expected-but-absent: ' + missing.join(','))
    }
}

;(async () => {
    /* ---------- 1. processHistoryMessage (messaging-history.set payload) ---------- */
    const histSync = proto.HistorySync.create({
        syncType: proto.HistorySync.HistorySyncType.RECENT,
        conversations: [{
            id: '94770000000@s.whatsapp.net',
            unreadCount: 2,
            conversationTimestamp: 1700000000,
            name: 'Test Chat',
            messages: [{
                message: {
                    key: { remoteJid: '94770000000@s.whatsapp.net', fromMe: false, id: 'ABC123' },
                    messageTimestamp: 1700000000,
                    message: { conversation: 'hello from history' },
                    pushName: 'Tester'
                }
            }]
        }],
        pushnames: [{ id: '94770000000@s.whatsapp.net', pushname: 'Tester' }],
        progress: 42
    })
    const hist = P.processHistoryMessage(histSync)
    check('processHistoryMessage -> messaging-history.set payload', hist,
        ['chats', 'contacts', 'messages'])
    console.log('  chats[0] keys:', JSON.stringify(Object.keys(hist.chats[0] || {})))
    console.log('  contacts[0]  :', JSON.stringify(hist.contacts[0]))
    console.log('  syncType     :', hist.syncType, ' progress:', hist.progress)
    console.log('  isLatest     :', hist.isLatest)

    /* ---------- 2. getContentType across every message shape ---------- */
    const shapes = {
        conversation: { conversation: 'x' },
        extendedTextMessage: { extendedTextMessage: { text: 'x' } },
        imageMessage: { imageMessage: {} },
        videoMessage: { videoMessage: {} },
        audioMessage: { audioMessage: {} },
        documentMessage: { documentMessage: {} },
        stickerMessage: { stickerMessage: {} },
        reactionMessage: { reactionMessage: {} },
        pollCreationMessageV3: { pollCreationMessageV3: {} },
        protocolMessage: { protocolMessage: {} },
        eventMessage: { eventMessage: {} }
    }
    console.log('\n=== getContentType over real shapes')
    for (const [expect, content] of Object.entries(shapes)) {
        const got = P.getContentType(content)
        console.log('  ' + expect.padEnd(24) + ' -> ' + got + (got === expect ? '' : '   <-- differs'))
    }

    /* ---------- 3. normalizeMessageContent / extractMessageContent ---------- */
    const wrapped = {
        ephemeralMessage: {
            message: {
                viewOnceMessage: { message: { imageMessage: { caption: 'deep' } } }
            }
        }
    }
    const norm = P.normalizeMessageContent(wrapped)
    check('normalizeMessageContent(nested)', norm)
    console.log('  extractMessageContent:', JSON.stringify(Object.keys(P.extractMessageContent(wrapped) || {})))

    /* ---------- 4. updateMessageWithReaction / PollUpdate / Receipt ---------- */
    const msg = {
        key: { remoteJid: '1@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' }
    }
    P.updateMessageWithReaction(msg, { key: msg.key, text: '👍' })
    console.log('\n=== updateMessageWithReaction')
    console.log('  msg.reactions:', JSON.stringify(msg.reactions))

    const pmsg = { key: msg.key, message: { conversation: 'poll' } }
    P.updateMessageWithPollUpdate(pmsg, { pollUpdateMessageKey: msg.key, vote: { selectedOptions: [] }, senderTimestampMs: 1 })
    console.log('  msg.pollUpdates:', JSON.stringify(pmsg.pollUpdates))

    const rmsg = { key: msg.key }
    P.updateMessageWithReceipt(rmsg, { userJid: '2@s.whatsapp.net', receiptTimestamp: 5 })
    console.log('  msg.userReceipt:', JSON.stringify(rmsg.userReceipt))

    /* ---------- 5. binary node round-trip (real encode/decode) ---------- */
    const node = {
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:profile:picture', id: '1' },
        content: [{ tag: 'picture', attrs: { type: 'image', query: 'url' } }]
    }
    const enc = P.encodeBinaryNode(node)
    const dec = await P.decodeBinaryNode(enc.slice(0))
    console.log('\n=== binary node round-trip')
    console.log('  encoded bytes:', enc.length)
    console.log('  decoded tag  :', dec.tag, 'attrs:', JSON.stringify(dec.attrs))
    console.log('  child        :', JSON.stringify(P.getBinaryNodeChild(dec, 'picture')))

    /* ---------- 6. aggregate helpers ---------- */
    console.log('\n=== aggregateMessageKeysNotFromMe')
    const agg = P.aggregateMessageKeysNotFromMe([
        { remoteJid: '1@g.us', id: 'a', fromMe: false, participant: '2@s.whatsapp.net' },
        { remoteJid: '1@g.us', id: 'b', fromMe: false, participant: '2@s.whatsapp.net' }
    ])
    console.log('  ->', JSON.stringify(agg))

    /* ---------- 7. jid helpers on real-world jids ---------- */
    console.log('\n=== jid helpers')
    for (const j of ['1@s.whatsapp.net', '1:3@s.whatsapp.net', '1@lid', '1@g.us', 'status@broadcast', '1@newsletter', '1@bot']) {
        const d = P.jidDecode(j)
        console.log('  ' + j.padEnd(22) + ' decode=' + JSON.stringify(d) + ' group=' + P.isJidGroup(j) + ' lid=' + P.isLidUser(j))
    }

    require('fs').writeFileSync('/tmp/proto_out.json', JSON.stringify(results, null, 1))
    console.log('\nDONE')
    process.exit(0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
