// Offline integration test: mock socket + drive handleCall / offerCall / acceptCall
// Verifies stanza shapes, relay parsing, deferred accept, and media-session wiring.
'use strict'
const EventEmitter = require('events')

const sent = [] // captured sendNode stanzas

// ── patch makeMessagesSocket BEFORE messages-recv is required ──
const sendMod = require('/home/user/baileys-mod/lib/Socket/messages-send')
sendMod.makeMessagesSocket = (config) => {
    const ev = new EventEmitter()
    ev.buffer = () => {}
    ev.flush = () => {}
    const ws = new EventEmitter()
    const logger = config.logger || { info() {}, debug() {}, warn() {}, error() {}, trace() {} }
    const suki = {
        ev, ws, logger,
        authState: {
            creds: {
                me: {
                    id: '94711111111:12@s.whatsapp.net',
                    lid: '777777777777777:12@lid',
                },
                account: { details: Buffer.from('{}'), signatureId: 5 },
            },
            keys: {},
        },
        messageMutex: { mutex: (k, f) => f() },
        notificationMutex: { mutex: (k, f) => f() },
        receiptMutex: { mutex: (k, f) => f() },
        query: async (node) => { sent.push({ via: 'query', node }); return { tag: 'result', attrs: {}, content: [] } },
        sendNode: async (node) => { sent.push({ via: 'sendNode', node }); return { tag: 'result', attrs: {} } },
        upsertMessage: async () => { },
        resyncAppState: async () => { },
        onUnexpectedError: (e) => { throw e },
        assertSessions: async () => { },
        relayMessage: async () => { },
        sendReceipt: async () => { },
        uploadPreKeys: async () => { },
        generateMessageTag: () => 'TAG-' + Math.random().toString(36).slice(2, 8),
        groupMetadata: async () => ({}),
        getUSyncDevices: async (jids) => jids.map((j) => {
            const [user, device] = String(j).replace(/@.*/, '').split(':')
            const server = String(j).includes('@lid') ? 'lid' : 's.whatsapp.net'
            return { user, device: +(device || 0), server, jid: `${user}:${device || 0}@${server}` }
        }),
        createParticipantNodes: async (jids, message, extraAttrs) => ({
            nodes: jids.map((jid, i) => ({
                tag: 'to', attrs: { jid },
                content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg', ...(extraAttrs || {}) }, content: Buffer.from([0xaa, 0xbb, i]) }],
            })),
            shouldIncludeDeviceIdentity: true,
        }),
        messageRetryManager: {},
        sendPeerDataOperationMessage: async () => { },
        signalRepository: {
            lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null },
            decryptMessage: async ({ jid, type, ciphertext }) => ciphertext, // echo "plaintext"
        },
    }
    return suki
}

const { makeMessagesRecvSocket } = require('/home/user/baileys-mod/lib/Socket/messages-recv.js')

const config = {
    logger: { info: (...a) => console.log('[info]', ...a), debug: (...a) => { }, warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a), trace: () => { } },
    callOfferCache: undefined,
    shouldIgnoreJid: () => false,
    getMessage: async () => undefined,
}
const sock = makeMessagesRecvSocket(config)
const ws = sock.ws || null
console.log('socket built OK. exports:', ['offerCall', 'acceptCall', 'preacceptCall', 'terminateCall', 'connectCall', 'joinGroupCall', 'getCallInfo'].every((k) => typeof sock[k] === 'function') ? 'ALL PRESENT' : 'MISSING!')

const dec = (user, device, server = 's.whatsapp.net') => ({ user, device, server })

// ── helper to build binary nodes the way baileys decodes them ──
const N = (tag, attrs, content) => ({ tag, attrs: attrs || {}, content })

let pass = 0, fail = 0
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + JSON.stringify(detail)}`) }

async function main() {
// ═══════════════════════════════════════════════════════════════════
// TEST 1: inbound offer with relay block → receipt + preaccept + relay cached
// ═══════════════════════════════════════════════════════════════════
const callId = 'AABBCCDD00112233445566778899EEFF'
const relayKey = Buffer.from('relaySecretKey123', 'utf8') // 17B ascii
const offerNode = N('call', {
    from: '222222222222222:3@lid', to: '777777777777777:12@lid', id: 'OFFER-STANZA-1', t: '1700000000',
}, [
    N('offer', { 'call-id': callId, 'call-creator': '222222222222222:3@lid' }, [
        N('audio', { enc: 'opus', rate: '16000' }),
        N('encopt', { keygen: '2' }),
        N('enc', { v: '2', type: 'msg', count: '0' }, Buffer.from('fakeencpayload')),
        N('relay', {
            self_pid: '7', peer_pid: '3',
        }, [
            N('key', {}, relayKey),
            N('token', { id: '0' }, Buffer.from('token0000000000')),
            N('token', { id: '1' }, Buffer.from('token1111111111')),
            N('te2', { relay_id: '5', relay_name: 'waweb5', token_id: '1', auth_token_id: '2', is_fna: '0' }, Buffer.from([157, 240, 1, 100, 0x0d, 0x96])),
            N('te2', { relay_id: '5', relay_name: 'waweb5', token_id: '0', auth_token_id: '0', is_fna: '1' }, Buffer.from([157, 240, 1, 101, 0x0d, 0x96])),
            N('participant', { pid: '3', jid: '222222222222222:3@lid' }),
            N('participant', { pid: '7', jid: '777777777777777:12@lid' }),
        ]),
    ]),
])

const callEvents = []
sock.ev.on('call', (c) => callEvents.push(c[0] || c))

await ws.emit('CB:call', offerNode)
await new Promise((r) => setTimeout(r, 100))

const receipt = sent.find((s) => s.node.tag === 'receipt')
check('offer receipt sent', !!receipt, sent.map((s) => s.node.tag))
check('offer receipt carries <offer call-id call-creator>',
    receipt?.node?.content?.[0]?.tag === 'offer'
    && receipt.node.content[0].attrs['call-id'] === callId
    && receipt.node.content[0].attrs['call-creator'] === '222222222222222:3@lid',
    receipt?.node)

const preaccept = sent.find((s) => s.node.content?.[0]?.tag === 'preaccept')
check('eager preaccept sent', !!preaccept)
if (preaccept) {
    const kids = preaccept.node.content[0].content.map((c) => c.tag)
    check('preaccept child order [audio, encopt, capability]', JSON.stringify(kids) === JSON.stringify(['audio', 'encopt', 'capability']), kids)
    check('preaccept capability blob (standard-opus, MLow cleared)', Buffer.from(preaccept.node.content[0].content[2].content).toString('hex') === '0105f709e03b07')
    check('preaccept single rate 16000', preaccept.node.content[0].content[0].attrs.rate === '16000')
}

const cached = await sock.callOfferCacheTest?.() // not exported; check via behavior instead
// verify relay cached: connectCall should NOT time out on relay, only on... it has no callKey (fake enc undecryptable → callKey null) → will wait for callKey. So instead verify via internal: we can't. Use behavior: the '[MOD] relay block cached' log appeared:
// (log printed above if parsed). Instead, test parseRelayBlock indirectly through a second emit with ONLY relay → check log. Simplest: assert the log line was printed.
// We'll trust the log + move on to a direct unit test of exported parseRelayBlock? Not exported. OK — check via connectCall timing: give it a real callKey by re-emitting offer whose enc "decrypts" (mock decryptMessage echoes ciphertext, which won't proto-decode) — skip.

// ═══════════════════════════════════════════════════════════════════
// TEST 2: relaylatency probe → echo
// ═══════════════════════════════════════════════════════════════════
sent.length = 0
await ws.emit('CB:call', N('call', { from: '222222222222222:3@lid', id: 'X1', t: '1' }, [
    N('relaylatency', { 'call-id': callId, 'call-creator': '222222222222222:3@lid' }, [
        N('te', { latency: '33554432', relay_name: 'waweb5' }, Buffer.from([157, 240, 1, 100, 0x0d, 0x96])),
    ]),
]))
await new Promise((r) => setTimeout(r, 50))
const echo = sent.find((s) => s.node.content?.[0]?.tag === 'relaylatency')
check('relaylatency echoed', !!echo)
check('relaylatency echo te attrs',
    echo?.node?.content?.[0]?.content?.[0]?.attrs?.latency === '33554432'
    && echo.node.content[0].content[0].attrs.relay_name === 'waweb5'
    && Buffer.from(echo.node.content[0].content[0].content).toString('hex') === '9df001640d96',
    echo?.node?.content?.[0])

// ═══════════════════════════════════════════════════════════════════
// TEST 3: mute_v2 releases deferred accept
// ═══════════════════════════════════════════════════════════════════
sent.length = 0
// arm accept (deferred)
const armed = await sock.acceptCall(callId, '222222222222222:3@lid', { deferToMuteV2: true, connectMedia: false })
check('accept deferred', armed.deferred === true)
check('no accept stanza yet', !sent.some((s) => s.node.content?.[0]?.tag === 'accept'))
await ws.emit('CB:call', N('call', { from: '222222222222222:3@lid', id: 'X2', t: '1' }, [
    N('mute_v2', { 'call-id': callId, 'call-creator': '222222222222222:3@lid', 'mute-state': '0' }),
]))
await new Promise((r) => setTimeout(r, 100))
const accept = sent.find((s) => s.node.content?.[0]?.tag === 'accept')
check('accept sent after mute_v2', !!accept)
if (accept) {
    const a = accept.node.content[0]
    check('accept attrs: call-id + call-creator only', a.attrs['call-id'] === callId && a.attrs['call-creator'] === '222222222222222:3@lid' && a.attrs.count === undefined, a.attrs)
    const kids = a.content.map((c) => c.tag)
    check('accept child order [audio, net, encopt, capability] (no relay — it gets dropped)', JSON.stringify(kids) === JSON.stringify(['audio', 'net', 'encopt', 'capability']), kids)
    check('accept net medium 2 child', a.content[1].attrs.medium === '2')
    check('accept capability blob (standard-opus, MLow cleared)', Buffer.from(a.content[3].content).toString('hex') === '0105f709e03b13')
    check('accept single rate 16000', a.content[0].attrs.rate === '16000')
    check('accept has NO rekey enc and NO voip_settings', !kids.includes('enc') && !kids.includes('voip_settings'))
}

// ═══════════════════════════════════════════════════════════════════
// TEST 4: offerCall stanza shape
// ═══════════════════════════════════════════════════════════════════
sent.length = 0
const offered = await sock.offerCall('94766045156@s.whatsapp.net', false)
await new Promise((r) => setTimeout(r, 50))
const offerSent = sent.find((s) => s.node.content?.[0]?.tag === 'offer')
check('offer sent via sendNode', !!offerSent && offerSent.via === 'sendNode')
if (offerSent) {
    const o = offerSent.node.content[0]
    check('offer call-creator is our LID', o.attrs['call-creator'] === '777777777777777:12@lid', o.attrs)
    const kids = o.content.map((c) => c.tag)
    check('offer child order [audio8000, audio16000, net, capability, enc, encopt, device-identity]',
        JSON.stringify(kids) === JSON.stringify(['audio', 'audio', 'net', 'capability', 'enc', 'encopt', 'device-identity']), kids)
    check('offer rates 8000+16000', o.content[0].attrs.rate === '8000' && o.content[1].attrs.rate === '16000')
    check('offer net medium 3', o.content[2].attrs.medium === '3')
    check('offer capability blob', Buffer.from(o.content[3].content).toString('hex') === '0105f709e03b13')
    check('offer encopt keygen 2', o.content[5].attrs.keygen === '2')
    check('offer device-identity present', o.content[6].tag === 'device-identity')
    check('offer call-id = returned id', o.attrs['call-id'] === offered.id)
}

// ═══════════════════════════════════════════════════════════════════
// TEST 5: ack class=call relay allocation (outgoing relay path)
// ═══════════════════════════════════════════════════════════════════
sent.length = 0
await ws.emit('CB:ack,class:call', N('ack', { class: 'call', id: offered.id, t: '1' }, [
    N('relay', { 'call-id': offered.id }, [
        N('key', {}, Buffer.from('callerRelayKey99')),
        N('token', { id: '0' }, Buffer.from('ctoken00000000')),
        N('te2', { relay_id: '9', relay_name: 'waweb9', token_id: '0', auth_token_id: '1', is_fna: '0' }, Buffer.from([157, 240, 24, 133, 0x0d, 0x96])),
    ]),
]))
await new Promise((r) => setTimeout(r, 50))
// verify via connectCall: should fail on callKey missing? No — offerCall cached callKey. So connectCall should reach relay but DataChannel connect will fail (no real relay at 157.240.24.133). Time-bound it.
try {
    const sess = await sock.connectCall(offered.id, '94766045156@s.whatsapp.net', null, { relayTimeoutMs: 2000, channelTimeoutMs: 1500 })
    check('outgoing connectCall reached session (unexpected here)', false)
    sess.close()
} catch (e) {
    // We expect a relay-channel/timeout error — NOT a "no relay" error, proving the ack relay was cached.
    const noRelay = /relay block/.test(e.message)
    check('ack relay block cached (connectCall got past relay wait)', !noRelay, e.message)
}

// ═══════════════════════════════════════════════════════════════════
// TEST 6: group offer → roster + indexing
// ═══════════════════════════════════════════════════════════════════
const gCallId = '1111111111111111111111111111ABC2'
await ws.emit('CB:call', N('call', { from: gCallId + '@call', id: 'GOFFER', t: '1' }, [
    N('offer', { 'call-id': gCallId, 'call-creator': '222222222222222:3@lid', type: 'group' }, [
        N('audio', { enc: 'opus', rate: '16000' }),
        N('group_info', { 'group-jid': '120363429485478824@g.us', joinable: '1', 'transaction-id': '4', 'connected-limit': '8', media: 'audio' }, [
            N('user', { jid: '222222222222222:3@lid', state: 'connected' }, [
                N('device', { jid: '222222222222222:3@lid', platform: 'android', pid: '3' }),
            ]),
            N('user', { jid: '94766045156:0@s.whatsapp.net', state: 'connected' }, [
                N('device', { jid: '94766045156:0@s.whatsapp.net', platform: 'android', pid: '11' }),
            ]),
        ]),
    ]),
]))
await new Promise((r) => setTimeout(r, 100))
const info = await sock.getCallInfo('120363429485478824@g.us')
check('group call indexed', info?.callId === gCallId, info)
check('group call creator', info?.callCreator === '222222222222222:3@lid')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

}
main().then((r) => process.exit(r || 0), (e) => { console.error(e); process.exit(1) })
