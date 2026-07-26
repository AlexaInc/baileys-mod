/**
 * Regression tests for WhatsApp call answering + media streaming.
 *
 * These cover the bugs that made `acceptCall` crash and made `callKey` /
 * `mediakey` come back undefined:
 *
 *   1. `jidEncode is not defined`         -> ReferenceError inside acceptCall
 *   2. acceptCall minted a RANDOM key     -> returned a key nobody uses
 *   3. callKey was never unpadded         -> proto decode failed
 *   4. callKey only on the first event    -> undefined on every later event
 *   5. offer cache dropped on 'accept'    -> connectCall lost the offer
 *   6. candidates parsed from attributes  -> 0 candidates on real offers
 *   7. Opus cut into fixed-size chunks    -> undecodable audio
 */
const { EventEmitter } = require('events')
const dgram = require('dgram')
const crypto = require('crypto')

const { encodeWAMessage } = require('../lib/Utils')
const {
    WACallMediaSession,
    extractCandidates,
    extractRelayToken,
    decodeEndpoint,
    OggOpusDemuxer,
    parseStun,
    callKdf,
    CALL_KDF_LABELS,
    srtpDeriveSessionKey,
    srtpIv
} = require('../lib/Utils/call-media')
const { getCallStatusFromNode } = require('../lib/Utils/generics')

const CALLER = '15559998888@s.whatsapp.net'
const CALL_ID = 'CALL_TEST_1'
const REAL_KEY = Buffer.from('deadbeef'.repeat(8), 'hex')

const silentLogger = {
    info() {}, warn() {}, debug() {}, trace() {}, error() {},
    level: 'silent',
    child() { return silentLogger }
}

// messages-recv builds its whole socket stack on top of messages-send (which
// would open a real WebSocket). Swap it for a mock we control per test.
let mockSendSocket = null
jest.mock('../lib/Socket/messages-send', () => ({
    makeMessagesSocket: () => mockSendSocket
}))

/** Build a socket whose messages-send dependency is mocked out. */
function makeSock({ decryptOk = true } = {}) {
    const sent = []
    const ws = new EventEmitter()
    ws.isOpen = true

    const ev = new EventEmitter()
    ev.buffer = () => {}
    ev.flush = () => {}
    ev.isBuffering = () => false
    ev.process = () => {}
    ev.createBufferedFunction = f => f

    const plaintext = encodeWAMessage({ call: { callKey: REAL_KEY } })

    const mock = {
        ev,
        ws,
        authState: {
            creds: {
                me: { id: '15550001111:12@s.whatsapp.net', lid: '99887766:12@lid' },
                account: {}
            }
        },
        messageMutex: {}, notificationMutex: {}, receiptMutex: {},
        signalRepository: {
            decryptMessage: async ({ jid }) => {
                if (decryptOk && jid.startsWith('15559998888')) return plaintext
                throw new Error('no session for ' + jid)
            },
            encryptMessage: async () => ({ type: 'msg', ciphertext: Buffer.alloc(8) }),
            jidToSignalProtocolAddress: j => j,
            validateSession: async () => ({ exists: true }),
            lidMapping: {
                getLIDForPN: async () => undefined,
                getPNForLID: async () => undefined
            }
        },
        query: async n => { sent.push(n); return { tag: 'call', attrs: {} } },
        sendNode: async n => { sent.push(n) },
        upsertMessage: async () => {},
        resyncAppState: async () => {},
        onUnexpectedError: () => {},
        assertSessions: async () => {},
        relayMessage: async () => {},
        sendReceipt: async () => {},
        uploadPreKeys: async () => {},
        groupMetadata: async () => ({}),
        getUSyncDevices: async () => ([
            { user: '15559998888', device: 0, server: 's.whatsapp.net', jid: '15559998888:0@s.whatsapp.net' }
        ]),
        createParticipantNodes: async () => ({ nodes: [], shouldIncludeDeviceIdentity: false }),
        messageRetryManager: null,
        sendPeerDataOperationMessage: async () => {}
    }

    mockSendSocket = mock
    const { makeMessagesRecvSocket } = require('../lib/Socket/messages-recv')
    const sock = makeMessagesRecvSocket({
        logger: silentLogger,
        getMessage: async () => undefined
    })
    return { sock, ws, sent }
}

/** A realistic incoming-call stanza, shaped like the real wire format. */
function offerStanza() {
    return {
        tag: 'call',
        attrs: { from: CALLER, t: String(Math.floor(Date.now() / 1000)), id: 'stanza-1' },
        content: [{
            tag: 'offer',
            attrs: { 'call-id': CALL_ID, 'call-creator': CALLER },
            content: [
                { tag: 'audio', attrs: { rate: '16000', enc: 'opus' } },
                { tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: Buffer.from('ciphertext') },
                { tag: 'encopt', attrs: { keygen: '2' } },
                { tag: 'relay', attrs: {}, content: [
                    { tag: 'token', attrs: {}, content: Buffer.from('relay-token') },
                    // real captured endpoints
                    { tag: 'te2', attrs: { relay_id: '0' }, content: Buffer.from('nfAJMw2W', 'base64') },
                    { tag: 'te2', attrs: { relay_id: '0' }, content: Buffer.from('KgMogPIoAMP6zrAMAAABdw2W', 'base64') }
                ] },
                { tag: 'rte', attrs: {}, content: Buffer.from('UdWB2JN1', 'base64') }
            ]
        }]
    }
}

const settle = (ms = 250) => new Promise(r => setTimeout(r, ms))

describe('call offer parsing', () => {
    test('decodes packed IPv4 and IPv6 transport endpoints', () => {
        expect(decodeEndpoint(Buffer.from('nfAJMw2W', 'base64')))
            .toEqual({ ip: '157.240.9.51', port: 3478, family: 4 })
        expect(decodeEndpoint(Buffer.from('KgMogPIoAMP6zrAMAAABdw2W', 'base64')))
            .toEqual({ ip: '2a03:2880:f228:c3:face:b00c:0:177', port: 3478, family: 6 })
        expect(decodeEndpoint(Buffer.alloc(5))).toBeNull()
    })

    test('extracts candidates from binary te2/rte nodes (not just attributes)', () => {
        const cands = extractCandidates(offerStanza().content[0])
        expect(cands.length).toBe(3)
        // the peer's own reflexive endpoint must be preferred over relays
        expect(cands[0]).toMatchObject({ ip: '81.213.129.216', port: 37749, type: 'srflx' })
        expect(cands.some(c => c.type === 'relay' && c.ip === '157.240.9.51')).toBe(true)
        // IPv4 ordered before IPv6
        expect(cands.findIndex(c => c.family === 4))
            .toBeLessThan(cands.findIndex(c => c.family === 6))
    })

    test('still supports attribute-style candidates', () => {
        const cands = extractCandidates({
            tag: 'offer', attrs: {},
            content: [{ tag: 'candidate', attrs: { ip: '10.0.0.5', port: '5000', type: 'host' } }]
        })
        expect(cands).toEqual([
            expect.objectContaining({ ip: '10.0.0.5', port: 5000, type: 'host' })
        ])
    })

    test('extracts the relay auth token', () => {
        expect(extractRelayToken(offerStanza().content[0]).toString()).toBe('relay-token')
    })

    test('maps preaccept/transport/relaylatency to call statuses', () => {
        expect(getCallStatusFromNode({ tag: 'preaccept', attrs: {} })).toBe('preaccept')
        expect(getCallStatusFromNode({ tag: 'transport', attrs: {} })).toBe('transport')
        expect(getCallStatusFromNode({ tag: 'relaylatency', attrs: {} })).toBe('relaylatency')
        expect(getCallStatusFromNode({ tag: 'offer', attrs: {} })).toBe('offer')
    })
})

describe('incoming call -> event -> accept', () => {
    test('offer event exposes the real decrypted media key', async () => {
        const { sock, ws } = makeSock()
        const events = []
        sock.ev.on('call', calls => events.push(...calls))

        ws.emit('CB:call', offerStanza())
        await settle()

        const offer = events.find(e => e.status === 'offer')
        expect(offer).toBeDefined()
        expect(offer.from).toBe(CALLER)
        expect(Buffer.isBuffer(offer.callKey)).toBe(true)
        expect(offer.callKey.equals(REAL_KEY)).toBe(true)
        expect(offer.callKeyHex).toBe(REAL_KEY.toString('hex'))
    })

    test('acceptCall does not throw ReferenceError and returns the OFFER key', async () => {
        const { sock, ws, sent } = makeSock()
        ws.emit('CB:call', offerStanza())
        await settle()

        const res = await sock.acceptCall(CALL_ID, CALLER)

        // regression #2: must be the caller's key, never a freshly minted one
        expect(res.callKey.equals(REAL_KEY)).toBe(true)
        expect(res.callKeyHex).toBe(REAL_KEY.toString('hex'))
        expect(res.id).toBe(CALL_ID)

        // regression: real clients preaccept before accept
        const tags = sent.filter(s => s.tag === 'call').map(s => s.content[0].tag)
        expect(tags).toEqual(['preaccept', 'accept'])

        const accept = sent.find(s => s.tag === 'call' && s.content[0].tag === 'accept')
        expect(accept.content[0].attrs).toMatchObject({
            'call-id': CALL_ID,
            'call-creator': CALLER
        })
    })

    test('acceptCall can skip preaccept and can force video', async () => {
        const { sock, ws, sent } = makeSock()
        ws.emit('CB:call', offerStanza())
        await settle()

        await sock.acceptCall(CALL_ID, CALLER, { preaccept: false, isVideo: true })
        const calls = sent.filter(s => s.tag === 'call').map(s => s.content[0].tag)
        expect(calls).toEqual(['accept'])

        const accept = sent.find(s => s.content?.[0]?.tag === 'accept')
        expect(accept.content[0].content.some(c => c.tag === 'video')).toBe(true)
    })

    test('the media key persists onto follow-up call events', async () => {
        const { sock, ws } = makeSock()
        const events = []
        sock.ev.on('call', calls => events.push(...calls))

        ws.emit('CB:call', offerStanza())
        await settle()
        ws.emit('CB:call', {
            tag: 'call',
            attrs: { from: CALLER, t: '1', id: 'stanza-2' },
            content: [{ tag: 'accept', attrs: { 'call-id': CALL_ID, 'call-creator': CALLER }, content: [] }]
        })
        await settle()

        const acc = events.find(e => e.status === 'accept')
        expect(acc).toBeDefined()
        expect(acc.callKeyHex).toBe(REAL_KEY.toString('hex'))
    })

    test("the offer cache survives 'accept' so connectCall still works", async () => {
        const { sock, ws } = makeSock()
        ws.emit('CB:call', offerStanza())
        await settle()
        ws.emit('CB:call', {
            tag: 'call',
            attrs: { from: CALLER, t: '1', id: 'stanza-3' },
            content: [{ tag: 'accept', attrs: { 'call-id': CALL_ID, 'call-creator': CALLER }, content: [] }]
        })
        await settle()

        // must fail at ICE (unreachable relays), NOT at "No cached offer"
        await expect(
            sock.connectCall(CALL_ID, CALLER, undefined, { iceTimeoutMs: 400 })
        ).rejects.toThrow(/ICE failed/)
    })

    test('a malformed call node is still acked instead of killing the handler', async () => {
        const { sock, ws, sent } = makeSock()
        ws.emit('CB:call', { tag: 'call', attrs: { from: CALLER, t: '1', id: 'bad' }, content: [] })
        await settle()
        expect(sent.some(s => s.tag === 'ack')).toBe(true)
    })

    test('accept still signals when the key cannot be decrypted', async () => {
        const { sock, ws, sent } = makeSock({ decryptOk: false })
        ws.emit('CB:call', offerStanza())
        await settle()

        const res = await sock.acceptCall(CALL_ID, CALLER)
        expect(res.callKey).toBeNull()
        expect(sent.some(s => s.content?.[0]?.tag === 'accept')).toBe(true)
    })
})

describe('media transport', () => {
    /** A stand-in for a WhatsApp relay: answers STUN, records RTP. */
    function mockRelay() {
        return new Promise(resolve => {
            const s = dgram.createSocket('udp4')
            const rtp = []
            let bindings = 0
            s.on('message', (msg, rinfo) => {
                const st = parseStun(msg)
                if (st.isStun && st.type === 0x0001) {
                    bindings++
                    const tx = msg.subarray(8, 20)
                    const xport = Buffer.alloc(2)
                    xport.writeUInt16BE(rinfo.port ^ 0x2112)
                    const xip = Buffer.from(
                        rinfo.address.split('.').map(Number)
                            .map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i])
                    )
                    const val = Buffer.concat([Buffer.from([0, 1]), xport, xip])
                    const ah = Buffer.alloc(4)
                    ah.writeUInt16BE(0x0020, 0)
                    ah.writeUInt16BE(val.length, 2)
                    const attr = Buffer.concat([ah, val])
                    const hdr = Buffer.alloc(20)
                    hdr.writeUInt16BE(0x0101, 0)
                    hdr.writeUInt16BE(attr.length, 2)
                    hdr.writeUInt32BE(0x2112a442, 4)
                    tx.copy(hdr, 8)
                    s.send(Buffer.concat([hdr, attr]), rinfo.port, rinfo.address)
                } else if (!st.isStun) {
                    rtp.push(msg)
                }
            })
            s.bind(0, '127.0.0.1', () => resolve({
                port: s.address().port,
                rtp,
                bindings: () => bindings,
                close: () => s.close()
            }))
        })
    }

    test('ICE selects a responsive candidate and ignores dead ones', async () => {
        const relay = await mockRelay()
        const session = new WACallMediaSession({
            callId: CALL_ID,
            callKey: REAL_KEY,
            relayToken: Buffer.from('tok'),
            logger: silentLogger,
            candidates: [
                { ip: '127.0.0.1', port: 1, type: 'relay', family: 4 },
                { ip: '127.0.0.1', port: relay.port, type: 'relay', family: 4 }
            ]
        })
        try {
            const pair = await session.connect(4000)
            expect(pair.port).toBe(relay.port)
            expect(relay.bindings()).toBeGreaterThan(0)
        } finally {
            session.close()
            relay.close()
        }
    })

    test('connect() rejects clearly when the offer had no candidates', async () => {
        const session = new WACallMediaSession({
            callId: CALL_ID, callKey: REAL_KEY, candidates: [], logger: silentLogger
        })
        await expect(session.connect(200)).rejects.toThrow(/no transport candidates/)
        session.close()
    })

    test('RTP packets are well-formed, SRTP-protected and reach the peer', async () => {
        const relay = await mockRelay()
        const session = new WACallMediaSession({
            callId: CALL_ID,
            callKey: REAL_KEY,
            logger: silentLogger,
            candidates: [{ ip: '127.0.0.1', port: relay.port, type: 'relay', family: 4 }]
        })
        try {
            await session.connect(4000)

            const frame = Buffer.from('an-opus-frame-payload')
            const seq = session.seq & 0xffff
            const ssrc = session.ssrc
            const pkt = session._packetize(frame, 'audio', 960)

            expect(pkt[0]).toBe(0x80)              // RTP v2
            expect(pkt[1] & 0x7f).toBe(111)        // Opus payload type
            expect(pkt.readUInt16BE(2)).toBe(seq)

            // 12-byte header + ciphertext + 10-byte HMAC-SHA1-80 auth tag
            expect(pkt.length).toBe(12 + frame.length + 10)

            const body = pkt.subarray(12, pkt.length - 10)
            const tag = pkt.subarray(pkt.length - 10)
            expect(body.equals(frame)).toBe(false) // encrypted

            // decrypt exactly as an SRTP peer would: derive session keys from
            // the master key/salt, build the RFC 3711 IV, then verify the tag.
            const sk = srtpDeriveSessionKey(session.srtpKey, session.srtpSalt, 0x00, 16)
            const ak = srtpDeriveSessionKey(session.srtpKey, session.srtpSalt, 0x01, 20)
            const ss = srtpDeriveSessionKey(session.srtpKey, session.srtpSalt, 0x02, 14)
            const d = crypto.createDecipheriv('aes-128-ctr', sk, srtpIv(ss, ssrc, seq))
            const back = Buffer.concat([d.update(body), d.final()])
            expect(back.equals(frame)).toBe(true)

            const expectTag = crypto.createHmac('sha1', ak)
                .update(pkt.subarray(0, 12)).update(body).update(Buffer.alloc(4))
                .digest().subarray(0, 10)
            expect(tag.equals(expectTag)).toBe(true)

            session._send(pkt)
            await settle(300)
            expect(relay.rtp.length).toBe(1)
        } finally {
            session.close()
            relay.close()
        }
    })

    test('audio/video use independent SSRCs and sequence spaces', () => {
        const s = new WACallMediaSession({
            callId: CALL_ID, callKey: REAL_KEY, candidates: [], logger: silentLogger
        })
        const a = s._packetize(Buffer.alloc(8), 'audio', 960)
        const v = s._packetize(Buffer.alloc(8), 'video', 3000)
        expect(a.readUInt32BE(8)).not.toBe(v.readUInt32BE(8))
        expect(v[1] & 0x7f).toBe(96) // VP8
        s.close()
    })
})

describe('call crypto (recovered from WhatsApp Web VoIP WASM)', () => {
    test('uses the real hop-by-hop derivation labels', () => {
        // These strings sit next to `derive_hbh_srtp_key` in whatsapp.wasm.
        expect(CALL_KDF_LABELS).toMatchObject({
            SRTP_KEY: 'hbh srtp key',
            SRTP_SALT: 'hbh srtp salt',
            SRTCP_UPLINK_KEY: 'uplink hbh srtcp key',
            SRTCP_UPLINK_SALT: 'uplink hbh srtcp salt',
            SRTCP_DOWNLINK_KEY: 'downlink hbh srtcp key',
            SRTCP_DOWNLINK_SALT: 'downlink hbh srtcp salt',
            WARP_AUTH_KEY: 'warp auth key',
            E2E_SFRAME_KEY: 'e2e sframe key'
        })
    })

    test('callKdf is HKDF-SHA256 (RFC 5869 test vectors)', () => {
        // TC1
        expect(callKdf(
            Buffer.alloc(22, 0x0b),
            Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
            42,
            Buffer.from('000102030405060708090a0b0c', 'hex')
        ).toString('hex')).toBe(
            '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
            '34007208d5b887185865'
        )
        // TC3 (empty salt and info)
        expect(callKdf(Buffer.alloc(22, 0x0b), Buffer.alloc(0), 42, null).toString('hex')).toBe(
            '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d' +
            '9d201395faa4b61a96c8'
        )
    })

    test('SRTP session-key derivation matches RFC 3711 §B.3', () => {
        const mk = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex')
        const ms = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex')
        expect(srtpDeriveSessionKey(mk, ms, 0x00, 16).toString('hex').toUpperCase())
            .toBe('C61E7A93744F39EE10734AFE3FF7A087')
        expect(srtpDeriveSessionKey(mk, ms, 0x01, 20).toString('hex').toUpperCase())
            .toBe('CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4')
        expect(srtpDeriveSessionKey(mk, ms, 0x02, 14).toString('hex').toUpperCase())
            .toBe('30CBBC08863D8C85D49DB34A9AE1')
    })

    test('session derives distinct SRTP / SRTCP material of the right sizes', () => {
        const s = new WACallMediaSession({
            callId: CALL_ID, callKey: REAL_KEY, candidates: [], logger: silentLogger
        })
        expect(s.srtpKey).toHaveLength(16)
        expect(s.srtpSalt).toHaveLength(14)
        expect(s.srtcpTxKey).toHaveLength(16)
        expect(s.srtcpRxKey).toHaveLength(16)
        // uplink and downlink must not collide
        expect(s.srtcpTxKey.equals(s.srtcpRxKey)).toBe(false)
        expect(s.srtpKey.equals(s.srtcpTxKey)).toBe(false)
        s.close()
    })

    test('the packet index rolls over into the ROC on sequence wrap', () => {
        const s = new WACallMediaSession({
            callId: CALL_ID, callKey: REAL_KEY, candidates: [], logger: silentLogger
        })
        s.seq = 0xfffe
        s._packetize(Buffer.alloc(4), 'audio', 960) // 0xfffe
        s._packetize(Buffer.alloc(4), 'audio', 960) // 0xffff
        expect(s._srtpState(false).roc).toBe(0)
        s._packetize(Buffer.alloc(4), 'audio', 960) // wraps to 0x0000
        expect(s._srtpState(false).roc).toBe(1)
        s.close()
    })

    test('IV construction folds in SSRC and packet index (RFC 3711 §4.1.1)', () => {
        const salt = Buffer.alloc(14, 0)
        const a = srtpIv(salt, 0x12345678, 0)
        expect(a.subarray(4, 8).toString('hex')).toBe('12345678')
        // same ssrc, different index -> different IV
        expect(srtpIv(salt, 0x12345678, 1).equals(a)).toBe(false)
        // last two bytes are the AES-CM block counter, always zero
        expect(a.subarray(14).toString('hex')).toBe('0000')
    })
})

describe('OggOpusDemuxer', () => {
    function page(serial, seq, packets, headerType = 0) {
        const table = []
        for (const p of packets) {
            let n = p.length
            while (n >= 255) { table.push(255); n -= 255 }
            table.push(n)
        }
        const head = Buffer.alloc(27)
        head.write('OggS', 0)
        head[5] = headerType
        head.writeUInt32LE(serial, 14)
        head.writeUInt32LE(seq, 18)
        head[26] = table.length
        return Buffer.concat([head, Buffer.from(table), Buffer.concat(packets)])
    }

    test('yields whole Opus frames and drops OpusHead/OpusTags', () => {
        const f1 = Buffer.alloc(80, 1)
        const f2 = Buffer.alloc(120, 2)
        const f3 = Buffer.alloc(300, 3) // spans multiple 255-byte segments
        const stream = Buffer.concat([
            page(7, 0, [Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])], 2),
            page(7, 1, [Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(20)])]),
            page(7, 2, [f1, f2]),
            page(7, 3, [f3])
        ])

        // feed in awkward chunk sizes to prove streaming reassembly
        const d = new OggOpusDemuxer()
        const out = []
        for (let i = 0; i < stream.length; i += 17) {
            out.push(...d.push(stream.subarray(i, i + 17)))
        }

        expect(out.length).toBe(3)
        expect(out[0].equals(f1)).toBe(true)
        expect(out[1].equals(f2)).toBe(true)
        expect(out[2].equals(f3)).toBe(true)
    })
})
