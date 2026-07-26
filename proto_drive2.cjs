/**
 * Second protocol-drive pass: app-state (chat mutations), receipts,
 * call nodes, group metadata parsing and the event buffer — i.e. the
 * paths that only run against a live server.
 */
const P = require('./lib')
const pino = require('pino')
const { proto } = P
const logger = pino({ level: 'silent' })
const EventEmitter = require('events')

const show = (label, v) => {
    let s
    try { s = JSON.stringify(v) } catch { s = '<circular>' }
    console.log('  ' + label.padEnd(34) + (s === undefined ? 'undefined' : s.slice(0, 150)))
}

;(async () => {
    /* ---------- 1. chatModificationToAppPatch: every ChatModification variant ---------- */
    console.log('\n=== chatModificationToAppPatch (all variants)')
    const jid = '94770000000@s.whatsapp.net'
    const lastMessages = [{
        key: { remoteJid: jid, id: 'M1', fromMe: false },
        messageTimestamp: 1700000000
    }]
    const mods = {
        archive:        { archive: true, lastMessages },
        pin:            { pin: true },
        mute:           { mute: 8 * 60 * 60 * 1000 },
        clear:          { clear: true, lastMessages },
        star:           { star: { messages: [{ id: 'M1', fromMe: false }], star: true } },
        markRead:       { markRead: true, lastMessages },
        delete:         { delete: true, lastMessages },
        pushNameSetting:{ pushNameSetting: 'MyName' },
        contact:        { contact: { fullName: 'Full Name' } }
    }
    for (const [name, mod] of Object.entries(mods)) {
        try {
            const patch = P.chatModificationToAppPatch(mod, jid)
            console.log('  ' + name.padEnd(18) + ' -> type=' + patch.type +
                ' keys=' + JSON.stringify(Object.keys(patch)))
        } catch (e) {
            console.log('  ' + name.padEnd(18) + ' THREW ' + e.message.slice(0, 60))
        }
    }

    /* ---------- 2. processSyncAction: emitted events for real sync actions ---------- */
    console.log('\n=== processSyncAction -> emitted events')
    const ev = new EventEmitter()
    const seen = []
    for (const e of ['chats.update','chats.delete','contacts.update','contacts.upsert',
                     'messages.update','messages.delete','settings.update','lid-mapping.update']) {
        ev.on(e, d => seen.push(e + ':' + JSON.stringify(d).slice(0, 90)))
    }
    const me = { id: jid }
    const actions = [
        ['archive',  { index: ['archive', jid], syncAction: { value: { archiveChatAction: { archived: true } } } }],
        ['pin',      { index: ['pin_v1', jid],  syncAction: { value: { pinAction: { pinned: true } } } }],
        ['mute',     { index: ['mute', jid],    syncAction: { value: { muteAction: { muted: true, muteEndTimestamp: 123 } } } }],
        ['contact',  { index: ['contact', jid], syncAction: { value: { contactAction: { fullName: 'N' } } } }],
        ['star',     { index: ['star', jid, 'M1', '0'], syncAction: { value: { starAction: { starred: true } } } }],
        ['delete',   { index: ['deleteChat', jid], syncAction: { value: { deleteChatAction: {} } } }],
        ['pushName', { index: ['setting_pushName'], syncAction: { value: { pushNameSetting: { name: 'Me' } } } }]
    ]
    for (const [name, a] of actions) {
        seen.length = 0
        try {
            P.processSyncAction(a, ev, me, undefined, logger)
            console.log('  ' + name.padEnd(10) + ' -> ' + (seen.join(' | ') || '(no event)'))
        } catch (e) {
            console.log('  ' + name.padEnd(10) + ' THREW ' + e.message.slice(0, 70))
        }
    }

    /* ---------- 3. call node -> WACallEvent (real stanza) ---------- */
    console.log('\n=== call stanza shape (WACallEvent fields)')
    // mirror what messages-recv builds
    const callNode = {
        tag: 'call',
        attrs: { from: '94770000001@s.whatsapp.net', t: '1700000000', id: 'callstanza1' },
        content: [{
            tag: 'offer',
            attrs: { 'call-id': 'CALLID123', 'call-creator': '94770000001@s.whatsapp.net' },
            content: [{ tag: 'video', attrs: {} }, { tag: 'enc', attrs: {}, content: Buffer.alloc(4) }]
        }]
    }
    const offer = P.getBinaryNodeChild(callNode, 'offer')
    show('offer tag', offer && offer.tag)
    show('call-id attr', offer && offer.attrs['call-id'])
    show('has <video>', !!P.getBinaryNodeChild(offer, 'video'))
    show('extractCandidates(offer)', P.extractCandidates(offer))

    /* ---------- 4. group metadata parsing from a real <group> node ---------- */
    console.log('\n=== group metadata from binary node')
    const groupNode = {
        tag: 'group',
        attrs: { id: '120363000000000000', creator: jid, subject: 'My Group',
                 s_t: '1700000000', creation: '1699000000', addressing_mode: 'pn' },
        content: [
            { tag: 'participant', attrs: { jid: jid, type: 'superadmin' } },
            { tag: 'participant', attrs: { jid: '94770000002@s.whatsapp.net' } },
            { tag: 'announcement', attrs: {} },
            { tag: 'locked', attrs: {} },
            { tag: 'description', attrs: { id: 'D1' }, content: [{ tag: 'body', attrs: {}, content: Buffer.from('desc') }] }
        ]
    }
    if (typeof P.extractGroupMetadata === 'function') {
        const gm = P.extractGroupMetadata({ tag: 'x', attrs: {}, content: [groupNode] })
        show('GroupMetadata keys', Object.keys(gm))
        show('announce/restrict', [gm.announce, gm.restrict])
        show('participants', gm.participants)
    } else {
        console.log('  extractGroupMetadata not exported from root (internal)')
    }

    /* ---------- 5. event buffer consolidation ---------- */
    console.log('\n=== makeEventBuffer consolidation')
    const buf = P.makeEventBuffer(logger)
    const got = []
    buf.on('messages.upsert', d => got.push('upsert:' + d.messages.length + ':' + d.type))
    buf.on('chats.update', d => got.push('chats.update:' + JSON.stringify(d)))
    buf.buffer()
    buf.emit('messages.upsert', { messages: [{ key: { id: 'A', remoteJid: jid }, message: {} }], type: 'notify' })
    buf.emit('messages.upsert', { messages: [{ key: { id: 'B', remoteJid: jid }, message: {} }], type: 'notify' })
    buf.emit('chats.update', [{ id: jid, unreadCount: 1 }])
    buf.emit('chats.update', [{ id: jid, unreadCount: 2 }])
    const flushed = buf.flush()
    show('flush() returned', flushed)
    show('consolidated events', got)

    console.log('\nDONE2')
    process.exit(0)
})().catch(e => { console.error('FATAL', e.stack); process.exit(1) })
