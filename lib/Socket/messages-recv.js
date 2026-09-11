"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const { default: NodeCache } = require("@cacheable/node-cache")
const { Boom } = require("@hapi/boom")
const { randomBytes } = require("crypto")
const { proto } = require("../../WAProto")
const {
    KEY_BUNDLE_TYPE,
    MIN_PREKEY_COUNT,
    DEFAULT_CACHE_TTLS
} = require("../Defaults/constants")
const {
    XWAPaths,
    XWAPathsMexUpdates,
    MexOperations,
    MexUpdatesOperations,
    WAMessageStubType,
    WAMessageStatus
} = require("../Types")
const {
    aesDecryptCTR,
    aesEncryptGCM,
    cleanMessage,
    Curve,
    decodeMediaRetryNode,
    decodeMessageNode,
    decryptMessageNode,
    delay,
    derivePairingCodeKey,
    encodeBigEndian,
    encodeSignedDeviceIdentity,
    extractAddressingContext,
    getCallStatusFromNode,
    WACallMediaSession,
    extractCandidates,
    extractRelayToken,
    getHistoryMsg,
    getNextPreKeys,
    getStatusFromReceiptType,
    hkdf,
    NO_MESSAGE_FOUND_ERROR_TEXT,
    MISSING_KEYS_ERROR_TEXT,
    NACK_REASONS,
    unixTimestampSeconds,
    unpadRandomMax16,
    xmppPreKey,
    xmppSignedPreKey,
    generateMessageID
} = require("../Utils")
const {
    areJidsSameUser,
    binaryNodeToString,
    getAllBinaryNodeChildren,
    getBinaryNodeChild,
    getBinaryNodeChildBuffer,
    getBinaryNodeChildren,
    getBinaryNodeChildString,
    isJidGroup,
    isJidNewsletter,
    isJidStatusBroadcast,
    isHostedLidUser,
    isHostedPnUser,
    isLidUser,
    isPnUser,
    jidDecode,
    jidEncode,
    jidNormalizedUser,
    S_WHATSAPP_NET
} = require("../WABinary")
const { extractGroupMetadata } = require("./groups")
const { makeMutex } = require("../Utils/make-mutex")
const { makeMessagesSocket } = require("./messages-send")

const makeMessagesRecvSocket = (config) => {
    const {
        logger,
        retryRequestDelayMs,
        maxMsgRetryCount,
        getMessage,
        shouldIgnoreJid,
        enableAutoSessionRecreation
    } = config

    const suki = makeMessagesSocket(config)

    const {
        ev,
        authState,
        ws,
        messageMutex,
        notificationMutex,
        receiptMutex,
        signalRepository,
        query,
        upsertMessage,
        resyncAppState,
        onUnexpectedError,
        assertSessions,
        sendNode,
        relayMessage,
        sendReceipt,
        uploadPreKeys,
        generateMessageTag,
        groupMetadata,
        getUSyncDevices,
        createParticipantNodes,
        messageRetryManager,
        sendPeerDataOperationMessage
    } = suki

    /** this mutex ensures that each retryRequest will wait for the previous one to finish */
    const retryMutex = makeMutex()

    const msgRetryCache = config.msgRetryCounterCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })

    const callOfferCache = config.callOfferCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER,
        useClones: false
    })
    // [MOD] debug: trace every offer-cache deletion + expiry (a group join
    // died with "offer cache entry disappeared mid-connect" and no visible
    // deleter — make the culprit identify itself)
    {
        const origDel = callOfferCache.del?.bind(callOfferCache)
        if (origDel) {
            callOfferCache.del = (k, ...rest) => {
                logger.warn(
                    { key: String(k), where: new Error('trace').stack?.split('\n').slice(2, 5).map((s) => s.trim()).join(' <- ') },
                    '[MOD] callOfferCache.del called'
                )
                return origDel(k, ...rest)
            }
        }
        try {
            callOfferCache.on?.('expired', (k) => {
                logger.warn({ key: String(k) }, '[MOD] callOfferCache entry EXPIRED')
            })
        } catch { /* events unsupported */ }
    }

    // [MOD] WhatsApp retransmits the call <offer> stanza (duplicate delivery,
    // offline + live copies, server redeliveries until ack...). The <enc>
    // inside an offer can be consumed by the Signal ratchet exactly ONCE, so:
    //
    //   - offerHandledCache marks call-ids whose offer we already processed
    //     and emitted. Retransmissions still refresh the cached offer (relay
    //     tokens may change) and are acked, but are NOT re-emitted — this is
    //     what stops double auto-answer / double preaccept+accept. It is a
    //     plain local NodeCache so the get/set pair is atomic even when the
    //     user injects a custom async callOfferCache via config.
    //
    //   - decryptedCallKeys memoizes the media callKey per call-id (in-flight
    //     promise included), so duplicates and late acceptCall()/connectCall()
    //     lookups never trigger a second decrypt of the same consumed
    //     ciphertext (Signal throws MessageCounterError: "Key used already or
    //     never filled" — and the keyless duplicate used to overwrite the
    //     cached key, leaving acceptCall() / ICE with callKey = null).
    const offerHandledCache = new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER,
        useClones: false
    })
    const decryptedCallKeys = new Map()

    // Drop all per-call key material once a call is over.
    const forgetCallKeyMaterial = (callId) => {
        if (!callId) return
        decryptedCallKeys.delete(callId)
        offerHandledCache.del(callId)
    }

    const placeholderResendCache = config.placeholderResendCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })

    // Debounce identity-change session refreshes per JID to avoid bursts
    const identityAssertDebounce = new NodeCache({
        stdTTL: 5,
        useClones: false
    })

    let sendActiveReceipts = false

    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated')
        }

        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        }

        return sendPeerDataOperationMessage(pdoMessage)
    }

    const requestPlaceholderResend = async (messageKey) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated')
        }

        if (await placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'already requested resend')
            return
        }

        else {
            await placeholderResendCache.set(messageKey?.id, true)
        }

        await delay(5000)

        if (!(await placeholderResendCache.get(messageKey?.id))) {
            logger.debug({ messageKey }, 'message received while resend requested')
            return 'RESOLVED'
        }

        const pdoMessage = {
            placeholderMessageResendRequest: [
                {
                    messageKey
                }
            ],
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        }

        setTimeout(async () => {
            if (await placeholderResendCache.get(messageKey?.id)) {
                logger.debug({ messageKey }, 'PDO message without response after 15 seconds. Phone possibly offline')
                await placeholderResendCache.del(messageKey?.id)
            }
        }, 15000)

        return sendPeerDataOperationMessage(pdoMessage)
    }

    const sendMessageAck = async ({ tag, attrs, content }, errorCode) => {
        const stanza = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.from,
                class: tag
            }
        }

        if (!!errorCode) {
            stanza.attrs.error = errorCode.toString()
        }

        if (!!attrs.participant) {
            stanza.attrs.participant = attrs.participant
        }

        if (!!attrs.recipient) {
            stanza.attrs.recipient = attrs.recipient
        }

        if (!!attrs.type && (tag !== 'message' || getBinaryNodeChild({ tag, attrs, content }, 'unavailable') || errorCode !== 0)) {
            stanza.attrs.type = attrs.type
        }

        if (tag === 'message' && getBinaryNodeChild({ tag, attrs, content }, 'unavailable')) {
            stanza.attrs.from = authState.creds.me.id
        }

        logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
        await sendNode(stanza)
    }

    // [MOD v2] offerCall — place an outgoing 1:1 call, per the wacrg SIG-01
    // offer spec (child order is load-bearing: the server returns 439 when
    // wrong; the old implementation's order was wrong and the offer never
    // reached the callee).
    //
    //   privacy → audio(8000) → audio(16000) → [video] → net(medium=3)
    //           → capability(7-byte blob) → destination|enc → encopt(keygen=2)
    //           → device-identity
    //
    // The relay allocation for OUR leg arrives afterwards in an
    // <ack class="call"> node (hooked below) — the old code used query() and
    // threw the result away.
    const offerCall = async (toJid, isVideo = false) => {
        const callId = randomBytes(16).toString('hex').toUpperCase()

        // 1. resolve the peer's LID (calls are placed over LID routing)
        let peerLid = toJid
        try {
            if (isPnUser(toJid) && signalRepository.lidMapping?.getLIDForPN) {
                const lid = await signalRepository.lidMapping.getLIDForPN(jidNormalizedUser(toJid))
                if (lid) peerLid = lid
            }
        } catch (e) {
            logger.debug({ err: e?.message }, '[MOD] offerCall: LID resolve failed, using JID as-is')
        }

        const encKey = randomBytes(32)
        // keep each device's own server (lid vs s.whatsapp.net)
        const devices = (await getUSyncDevices([peerLid], true, false))
            .map(({ user, device, server, jid }) => jid || jidEncode(user, server || 's.whatsapp.net', device))
            .filter((d) => jidDecode(d)?.user !== jidDecode(authState.creds.me.id)?.user
                || jidDecode(d)?.device !== jidDecode(authState.creds.me.id)?.device)
        if (!devices.length) {
            throw new Boom('peer has no reachable devices (not on WhatsApp?)', { statusCode: 404 })
        }
        await assertSessions(devices, true)

        const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(devices, {
            call: {
                callKey: new Uint8Array(encKey)
            }
        }, { count: '0' })

        const offerContent = [
            { tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined },
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        ]
        if (isVideo) {
            offerContent.push({ tag: 'video', attrs: {}, content: undefined })
        }
        offerContent.push({ tag: 'net', attrs: { medium: '3' }, content: undefined })
        // [MOD] CAPABILITY_MLOW_OFFER — byte 5 = 0xbb announces MLow
        // (feature index 31) ON. Real clients now run MLow (their offers say
        // 0xbb); our standard SILK frames are misparsed by their MLow decoder
        // as proprietary smpl frames = constant distortion. We now offer MLow
        // and send escaped CELT multiframes when the peer announces it too.
        offerContent.push({
            tag: 'capability', attrs: { ver: '1' },
            content: new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x13]),
        })
        if (destinations.length === 1) {
            // single device: a bare <enc> directly in the offer (wacrg SIG-01)
            offerContent.push(destinations[0].content[0])
        } else {
            offerContent.push({ tag: 'destination', attrs: {}, content: destinations })
        }
        offerContent.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
        if (shouldIncludeDeviceIdentity) {
            offerContent.push({
                tag: 'device-identity',
                attrs: {},
                content: encodeSignedDeviceIdentity(authState.creds.account, true)
            })
        }

        const stanza = ({
            tag: 'call',
            attrs: {
                id: generateMessageID(),
                to: peerLid,
            },
            content: [{
                tag: 'offer',
                attrs: {
                    'call-id': callId,
                    'call-creator': authState.creds.me.lid || authState.creds.me.id,
                },
                content: offerContent,
            }],
        })

        await sendNode(stanza)

        // cache the caller-side state: WE minted the media key; the relay
        // block arrives later via <ack class="call">.
        await callOfferCache.set(callId, {
            id: callId,
            from: peerLid,
            to: peerLid,
            peerLid,
            selfLid: authState.creds.me.lid || authState.creds.me.id,
            isVideo,
            outgoing: true,
            callKey: encKey,
            callKeyHex: encKey.toString('hex'),
            date: new Date(),
        })

        return {
            id: callId,
            to: peerLid,
            callKey: encKey,
            callKeyHex: encKey.toString('hex'),
        }
    }

    // ---------------------------------------------------------------------
    // [MOD] decryptCallKey - REAL, achievable reverse-engineering step.
    //
    // When WhatsApp sends us a call <offer>, our device's media callKey is
    // delivered as an <enc> node (signal pkmsg/msg ciphertext) carrying a
    // proto.Message whose `call.callKey` field is the 32-byte media-session key.
    // We decrypt it exactly the way regular messages are decrypted.
    //
    // This is the genuine foundation: it gives you the raw media key in the
    // clear. It does NOT (and cannot here) build the audio transport — WA's
    // SRTP KDF + transport framing on top of this key are undocumented.
    // ---------------------------------------------------------------------
    /**
     * Find the <enc> node(s) in a call offer that are addressed to OUR device.
     *
     * Real WA offers wrap the per-device ciphertext like:
     *   <offer>
     *     <destination>
     *       <to jid="our-device@s.whatsapp.net"><enc type="pkmsg">...</enc></to>
     *       <to jid="other-device@s.whatsapp.net"><enc ...>...</enc></to>
     *     </destination>
     *   </offer>
     *
     * We must only try to decrypt the enc whose <to jid=> matches US.
     * Falling back to all enc nodes keeps backward-compat with forks that
     * put a bare <enc> directly in the offer.
     */
    const findEncNodes = (node, myJid, out = []) => {
        if (!node || typeof node !== 'object') return out

        // Priority: look inside <destination><to jid=ours> first
        if (Array.isArray(node.content)) {
            // If this is a <destination> node, scan its <to> children
            if (node.tag === 'destination') {
                const me = myJid ? jidNormalizedUser(myJid) : null
                for (const toNode of node.content) {
                    if (!toNode || toNode.tag !== 'to') continue
                    const toJid = toNode.attrs?.jid
                    // if we can identify our jid, only pick our slot
                    if (me && toJid && jidNormalizedUser(toJid) !== me) continue
                    // collect enc nodes inside this <to>
                    if (Array.isArray(toNode.content)) {
                        for (const c of toNode.content) {
                            if (c && c.tag === 'enc' &&
                                (c.attrs?.type === 'pkmsg' || c.attrs?.type === 'msg')) {
                                out.push(c)
                            }
                        }
                    }
                }
                // if we found targeted enc nodes, return — no need to fall through
                if (out.length) return out
            }

            for (const c of node.content) findEncNodes(c, myJid, out)
        }

        // bare <enc> directly on the node (old-style / test forks)
        if (node.tag === 'enc' &&
            (node.attrs?.type === 'pkmsg' || node.attrs?.type === 'msg')) {
            if (!out.includes(node)) out.push(node)
        }

        return out
    }

    // The <enc> in a call offer is addressed to *our specific device*, and is
    // encrypted from the caller's *specific device*. The signal address that
    // decrypts it therefore has to carry the sender's device id. WhatsApp
    // routes calls over LID now, so `from`/`call-creator` may be either a LID
    // or a PN; both spellings must be tried. Order matters: the exact JID on
    // the offer node first, then device-qualified variants, then the bare user.
    const callKeyDecryptCandidates = async (offerNode, callFrom) => {
        const out = []
        const push = jid => {
            const j = typeof jid === 'string' ? jid.trim() : ''
            if (j && !out.includes(j)) out.push(j)
        }

        // 1. the addressing WhatsApp itself put on the stanza
        push(offerNode?.attrs?.from)
        push(offerNode?.attrs?.['call-creator'])
        push(callFrom)

        // 2. device-qualified + bare variants of each of the above
        for (const jid of [...out]) {
            const dec = jidDecode(jid)
            if (!dec?.user) continue
            const server = dec.server === 'lid' ? 'lid' : (dec.server || 's.whatsapp.net')
            if (typeof dec.device === 'number' && dec.device > 0) {
                // bare (device 0 / primary) form as a fallback
                push(jidEncode(dec.user, server))
            } else {
                // no device on the JID -> primary device
                push(jidEncode(dec.user, server, 0))
            }

            // 3. cross-map PN <-> LID, since the session may be stored under either
            try {
                if (isPnUser(jid)) {
                    const lid = await signalRepository.lidMapping?.getLIDForPN?.(jidNormalizedUser(jid))
                    if (lid) {
                        const ld = jidDecode(lid)
                        if (ld?.user) {
                            push(jidEncode(ld.user, 'lid', dec.device))
                            push(jidEncode(ld.user, 'lid'))
                        }
                    }
                } else if (isLidUser(jid)) {
                    const pn = await signalRepository.lidMapping?.getPNForLID?.(jidNormalizedUser(jid))
                    if (pn) {
                        const pd = jidDecode(pn)
                        if (pd?.user) {
                            push(jidEncode(pd.user, 's.whatsapp.net', dec.device))
                            push(jidEncode(pd.user, 's.whatsapp.net'))
                        }
                    }
                }
            } catch { /* mapping lookups are best-effort */ }
        }
        return out
    }

    const decryptCallKeyOnce = async (offerNode, callFrom) => {
        const myJid = authState.creds.me?.id
        const encNodes = findEncNodes(offerNode, myJid)
        if (!encNodes.length) {
            logger.warn({ myJid }, '[MOD] decryptCallKey: no enc node found in offer addressed to us')
            return null
        }

        const candidates = await callKeyDecryptCandidates(offerNode, callFrom)
        logger.debug({ candidates }, '[MOD] decryptCallKey: trying signal addresses')

        let lastErr
        for (const enc of encNodes) {
            const e2eType = enc.attrs.type // 'pkmsg' | 'msg'
            const ciphertext = enc.content
            if (!ciphertext?.length) continue

            for (const jid of candidates) {
                try {
                    const plaintext = await signalRepository.decryptMessage({
                        jid,
                        type: e2eType,
                        ciphertext
                    })

                    // Call keys are wrapped in a padded proto.Message exactly like
                    // normal e2e messages, so the random pkcs7-ish pad must be
                    // stripped before decoding. Falling back to the raw buffer
                    // keeps us compatible with unpadded senders.
                    let msg
                    try {
                        msg = proto.Message.decode(unpadRandomMax16(plaintext))
                    } catch {
                        msg = proto.Message.decode(plaintext)
                    }

                    const callKey = msg?.call?.callKey
                    if (callKey?.length) {
                        const key = Buffer.from(callKey)
                        logger.info(
                            { callFrom, jid, callKeyHex: key.toString('hex'), len: key.length },
                            '[MOD] decrypted media callKey'
                        )
                        return key
                    }
                    logger.debug({ jid }, '[MOD] decryptCallKey: decrypted but no call.callKey present')
                } catch (e) {
                    lastErr = e
                    logger.trace({ jid, err: e?.message }, '[MOD] decryptCallKey: address failed, trying next')
                }
            }
        }

        logger.warn(
            { callFrom, tried: candidates, err: lastErr?.message },
            '[MOD] decryptCallKey: could not extract callKey from any enc node'
        )
        return null
    }

    // Memoizing wrapper: exactly one Signal-ratchet consume per call-id,
    // shared by offer handling, acceptCall() late-decrypt and connectCall().
    // Concurrent duplicates share the in-flight promise. A null result is NOT
    // memoized, so a retry can still succeed after session/ratchet recovery.
    const decryptCallKey = (offerNodeOrCallId, callFrom) => {
        const callId = typeof offerNodeOrCallId === 'string'
            ? offerNodeOrCallId
            : offerNodeOrCallId?.attrs?.['call-id']
        if (!callId) return decryptCallKeyOnce(offerNodeOrCallId, callFrom)

        const memo = decryptedCallKeys.get(callId)
        if (memo) {
            logger.trace({ callId }, '[MOD] decryptCallKey: reusing memoized result')
            return memo
        }

        const promise = decryptCallKeyOnce(offerNodeOrCallId, callFrom)
            .then(key => {
                if (key) decryptedCallKeys.set(callId, Promise.resolve(key))
                else decryptedCallKeys.delete(callId)
                return key
            }, err => {
                decryptedCallKeys.delete(callId)
                logger.debug({ callId, err: err?.message }, '[MOD] decryptCallKey failed')
                return null
            })
        decryptedCallKeys.set(callId, promise)
        return promise
    }

    // ---------------------------------------------------------------------
    // [MOD v2] Relay block parsing (wacrg REL-01 / meowcaller parseRelayData).
    // A <relay> node carries the relay <key> (base64 ASCII = the STUN
    // MESSAGE-INTEGRITY key), indexed <token> table, <te2> endpoints and a
    // <participant pid=> map. It arrives inside <offer>, <transport>,
    // <relaylatency> and <ack class="call"> nodes.
    // ---------------------------------------------------------------------
    const findRelayNode = (n) => {
        if (!n || typeof n !== 'object') return null
        if (n.tag === 'relay') return n
        if (Array.isArray(n.content)) {
            for (const c of n.content) {
                const r = findRelayNode(c)
                if (r) return r
            }
        }
        return null
    }

    const parseIndexedTokens = (relayNode, tag) => {
        const tokens = []
        if (!Array.isArray(relayNode.content)) return tokens
        for (const c of relayNode.content) {
            if (!c || c.tag !== tag) continue
            const b = Buffer.isBuffer(c.content) || c.content instanceof Uint8Array ? Buffer.from(c.content) : null
            if (!b) continue
            let id = tokens.length
            if (c.attrs?.id !== undefined && !Number.isNaN(parseInt(c.attrs.id, 10))) {
                id = parseInt(c.attrs.id, 10)
            }
            if (id >= 64) continue
            while (tokens.length <= id) tokens.push(null)
            tokens[id] = b
        }
        return tokens
    }

    const parseRelayBlock = (relayNode) => {
        if (!relayNode) return null
        const out = {
            key: null,        // ASCII bytes of <key> (STUN MI key)
            tokens: [],       // indexed <token> table
            authTokens: [],   // indexed <auth_token> table (separate!)
            endpoints: [],    // te2 endpoints
            peerJid: null,    // from <participant pid=peer_pid>
            selfPid: null,
            peerPid: null,
        }
        if (Buffer.isBuffer(relayNode.content) || relayNode.content instanceof Uint8Array || typeof relayNode.content === 'string') {
            // bare <relay> with no children — nothing to parse
            return out
        }
        if (!Array.isArray(relayNode.content)) return out

        for (const c of relayNode.content) {
            if (!c || typeof c !== 'object') continue
            if (c.tag === 'key' && (Buffer.isBuffer(c.content) || c.content instanceof Uint8Array || typeof c.content === 'string')) {
                out.key = Buffer.isBuffer(c.content) ? c.content
                    : c.content instanceof Uint8Array ? Buffer.from(c.content)
                        : Buffer.from(c.content, 'utf8')
                continue
            }
            if (c.tag === 'participant') continue // handled after the loop
            if (c.tag === 'hbh_key' && (Buffer.isBuffer(c.content) || c.content instanceof Uint8Array)) {
                out.hbhKey = Buffer.from(c.content)
                continue
            }
        }
        out.tokens = parseIndexedTokens(relayNode, 'token')
        out.authTokens = parseIndexedTokens(relayNode, 'auth_token')

        const peerPid = relayNode.attrs?.peer_pid
        out.selfPid = relayNode.attrs?.self_pid ? +relayNode.attrs.self_pid : null
        out.peerPid = peerPid ? +peerPid : null

        // edgeray DTLS active mode (relay acts as DTLS client): any attr named
        // like *edge*/*active* set to a truthy value on the relay node or a
        // child (exact binary attr name unknown — heuristic, verified via
        // rawShape dump in logs).
        const attrLooksActive = (k, v) =>
            /edge|active|dtls/i.test(k) && v !== undefined && v !== '0' && v !== 'false' && v !== ''
        if (Object.entries(relayNode.attrs || {}).some(([k, v]) => attrLooksActive(k, v))) {
            out.dtlsActiveMode = true
        }
        for (const c of relayNode.content) {
            if (!c || typeof c !== 'object' || !c.attrs) continue
            if (Object.entries(c.attrs).some(([k, v]) => attrLooksActive(k, v))) {
                out.dtlsActiveMode = true
            }
        }

        for (const c of relayNode.content) {
            if (!c || typeof c !== 'object') continue
            if (c.tag === 'participant' && peerPid && c.attrs?.pid === peerPid && c.attrs?.jid) {
                out.peerJid = c.attrs.jid
                continue
            }
            if (c.tag !== 'te2') continue
            const ab = Buffer.isBuffer(c.content) || c.content instanceof Uint8Array ? Buffer.from(c.content) : null
            if (!ab || ab.length !== 6) continue // IPv4:port only (IPv6 skipped)
            out.endpoints.push({
                relayId: +(c.attrs?.relay_id || 0),
                relayName: c.attrs?.relay_name || '',
                tokenId: +(c.attrs?.token_id || 0),
                authTokenId: +(c.attrs?.auth_token_id || 0),
                isFna: c.attrs?.is_fna === '1',
                ip: `${ab[0]}.${ab[1]}.${ab[2]}.${ab[3]}`,
                port: ab.readUInt16BE(4),
                raw6: ab,
            })
        }
        return out
    }

    /** Merge + cache relay data for a call; returns the merged relay block.
     *
     * source: which kind of node carried the relay block — 'offer' (the
     * call <offer>), the ack, or a live update (group_update / transport /
     * relaylatency).
     *
     * GROUP calls have TWO distinct relay blocks and must not be merged:
     *   • the OFFER's "announcement" block (its own relay, e.g. mrs2c02, an
     *     auth_token + token + key that all fit the 256-char ICE ufrag limit)
     *     is the WEB client's ICE credential set — verified live: a binding
     *     request with username=<announcement token>:<localfrag> and
     *     MESSAGE-INTEGRITY keyed with the announcement <key> gets a BINDING
     *     SUCCESS from the announcement relay on :3480.
     *   • the per-leg <group_update> relay block (c01-family relays, 193-byte
     *     te2 tokens = 260 base64 chars — TOO LONG for a libwebrtc ufrag, and
     *     its <key> is NOT a valid ICE MI key) is the ANDROID allocate-path
     *     credential set (meowcaller ApplyWithSubscriptions: token +
     *     relayUpdate.Key in the WASM allocate).
     * So for groups: the offer's block is cached as `relay` (ICE layer) and
     * every later block as `groupRelay` (allocate layer). 1:1 keeps the old
     * merge-into-relay semantics (proven in run 11).
     */
    const ingestRelayData = async (callId, relayNode, source = '') => {
        const parsed = parseRelayBlock(relayNode)
        if (!parsed) return null
        try {
            // Full raw shape of the relay node: attrs + every child's tag/attrs
            // (content logged separately above). Reveals fields we don't parse
            // yet (e.g. edgeray/dtls-active-mode flags).
            const rawShape = {
                attrs: relayNode.attrs || {},
                children: Array.isArray(relayNode.content)
                    ? relayNode.content.filter((c) => c && typeof c === 'object').map((c) => ({
                        tag: c.tag,
                        attrs: c.attrs || {},
                        contentType: Buffer.isBuffer(c.content) || c.content instanceof Uint8Array ? 'binary' : typeof c.content,
                        contentLen: c.content?.length ?? 0,
                    }))
                    : typeof relayNode.content,
            }
            logger.info(
                {
                    callId,
                    keyAscii: parsed.key?.toString('utf8'),
                    keyHex: parsed.key?.toString('hex'),
                    tokens: parsed.tokens.map((t) => t ? { hex: t.toString('hex'), b64: t.toString('base64') } : null),
                    authTokens: parsed.authTokens.map((t) => t ? { hex: t.toString('hex'), b64: t.toString('base64') } : null),
                    hbhKey: parsed.hbhKey ? parsed.hbhKey.toString('hex') : null,
                    endpoints: parsed.endpoints.map((e) => ({ ...e, raw6: undefined })),
                    rawShape,
                },
                '[MOD] relay block parsed'
            )
        } catch { /* logging best-effort */ }
        const cached = await callOfferCache.get(callId)
        if (!cached) return null

        // group split: later blocks (group_update / transport / ack) belong to
        // the per-leg allocate credential set, NOT the ICE layer
        const isGroupCall = !!cached.isGroup
        if (isGroupCall && source !== 'offer' && cached.relay?.key?.length) {
            await callOfferCache.set(callId, { ...cached, groupRelay: parsed })
            const live = callMediaSessions.get(callId)
            if (live && !live.closed) {
                try { live.setGroupRelay?.(parsed) } catch { /* best effort */ }
            }
            logger.info(
                {
                    callId, source: source || 'unknown',
                    endpoints: parsed.endpoints.map((e) => `${e.ip}:${e.port}(${e.relayName || e.relayId})`),
                    keyAscii: parsed.key?.toString('utf8'),
                    tokenLens: parsed.tokens.map((t) => t?.length || 0),
                    hbhKeyLen: parsed.hbhKey?.length || 0,
                },
                '[MOD] group per-leg relay block cached (announcement preserved for ICE)'
            )
            return parsed
        }

        const prev = cached.relay || {}
        // merge (patch semantics): keep previous fields the patch lacks
        const merged = {
            key: parsed.key?.length ? parsed.key : prev.key,
            tokens: parsed.tokens?.some(Boolean) ? parsed.tokens : prev.tokens,
            authTokens: parsed.authTokens?.some(Boolean) ? parsed.authTokens : (prev.authTokens || []),
            endpoints: parsed.endpoints?.length ? parsed.endpoints : prev.endpoints,
            peerJid: parsed.peerJid || prev.peerJid,
            selfPid: parsed.selfPid ?? prev.selfPid,
            peerPid: parsed.peerPid ?? prev.peerPid,
            hbhKey: parsed.hbhKey?.length ? parsed.hbhKey : prev.hbhKey,
            dtlsActiveMode: parsed.dtlsActiveMode === true || prev.dtlsActiveMode === true,
        }
        await callOfferCache.set(callId, { ...cached, relay: merged })
        return merged
    }

    // ---------------------------------------------------------------------
    // [MOD] shared call state
    // ---------------------------------------------------------------------
    /** live WACallMediaSession per call-id */
    const callMediaSessions = new Map()

    // [MOD] live accept-shape config (bisecting why the server drops our
    // <accept>: relay child? capability byte? metadata echo? send timing?).
    // Mutated at runtime via testbot's POST /acceptcfg.
    const acceptConfig = {
        delayMs: 0,          // delay before sending the accept
        useRelay: false,     // bare relay child gets the accept DROPPED by the server (proven)
        capHex: '0105f709e0bb13', // capability blob in the accept (MLow ON: byte5=0xbb)
        metadata: 'auto',    // 'auto' (echo offer's) | true | false
    }

    // [MOD] MLow is negotiated MUTUALLY (rust registry.rs
    // peer_selected_audio_codec / mlow_after_peer_capability): it survives a
    // call only if WE asked for it (our capability's use_mlow_codec_v1 bit,
    // byte5 = 0xbb) AND the peer announced it. Every capability shape we send
    // (offer, preaccept, accept) announces it CLEARED (byte5 = 0x3b —
    // standard Opus), so the peer's announcement alone must NEVER switch our
    // outbound frames into the MLow escape: a 0xDD-escaped packet is config-27
    // code-1 garbage for a peer running the standard-Opus profile our own
    // offer selected — it decodes as continuous glitching. Flip this to true
    // ONLY together with switching our offer capability to 0xbb.
    const WE_ASK_MLOW = true
    /** deferred accepts (waiting for the caller's first <mute_v2>) */
    const pendingAccepts = new Map()
    const pendingAcceptTimers = new Map()
    /** group calls discovered from offers, keyed by GROUP jid */
    const activeGroupCalls = new Map()
    /**
     * Last known ANNOUNCEMENT relay per group (keyed by group jid). Survives
     * terminate: flapped group calls get re-offered WITHOUT a <relay> block,
     * and the re-offer's joiner still needs the original announcement (web
     * ICE credentials) — the real web client keeps its call state across the
     * flap, our offer cache does not.
     */
    const groupAnnouncementCache = new Map()
    /** group rosters from <group_info> (participants + pids), per call-id */
    const groupRosters = new Map()
    /** group media epochs: { callId: { rawKey, tx } } (from enc_rekey) */
    const groupEpochs = new Map()
    /** relaylatency echo rate-limit windows per call */
    const relayLatencyEchoState = new Map()
    /** cached deferred-accept audio inputs per call-id */

    /**
     * Pick the local identity (`from`) that matches how the peer addressed us.
     * A call that arrives over LID must be answered from our LID, otherwise the
     * server drops the stanza and the call silently never connects.
     */
    const selfJidFor = (peerJid) => {
        const meLid = authState.creds.me?.lid
        if (meLid && (isLidUser(peerJid) || isHostedLidUser(peerJid))) {
            return meLid
        }
        return authState.creds.me.id
    }

    /** Media-description children shared by preaccept / accept (single-rate). */
    const buildCallMediaContent = (isVideo) => {
        const content = [
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        ]
        if (isVideo) {
            content.push({ tag: 'video', attrs: {}, content: undefined })
        }
        return content
    }

    // ---------------------------------------------------------------------
    // [MOD v2] preacceptCall — wacrg SIG-04 shape:
    //   <call to id><preaccept call-id call-creator>
    //     audio(16000) → [video] → encopt(keygen=2) → capability(...3b 07)
    //   </preaccept></call>
    // ---------------------------------------------------------------------
    const preacceptCall = async (callId, callFrom, isVideo = false) => {
        const content = buildCallMediaContent(isVideo)
        content.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
        content.push({
            tag: 'capability', attrs: { ver: '1' },
            // CAPABILITY_MLOW_PREACCEPT — capability 31 (use_mlow_codec_v1) ON
            // (byte 5 = 0xbb): mutual negotiation with the real MLow clients.
            content: new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07]),
        })
        const stanza = {
            tag: 'call',
            attrs: {
                to: callFrom,
                id: generateMessageID(),
            },
            content: [{
                tag: 'preaccept',
                attrs: {
                    'call-id': callId,
                    'call-creator': jidNormalizedUser(callFrom),
                },
                content,
            }],
        }
        await sendNode(stanza)
        return { id: callId }
    }

    // ---------------------------------------------------------------------
    // [MOD v2] terminateCall - hang up / end a call (wacrg SIG-14 shape:
    // no builder id, no count attr; optional reason + destination).
    // ---------------------------------------------------------------------
    const terminateCall = async (callId, callFrom, reason) => {
        const attrs = {
            'call-id': callId,
            'call-creator': jidNormalizedUser(callFrom),
        }
        if (reason) {
            attrs.reason = reason
        }
        const stanza = ({
            tag: 'call',
            attrs: {
                to: callFrom,
                id: generateMessageID(),
            },
            content: [{
                tag: 'terminate',
                attrs,
                content: undefined,
            }],
        })
        await sendNode(stanza)

        // tear down any media transport bound to this call
        try { callMediaSessions.get(callId)?.close() } catch { /* best effort */ }
        await callOfferCache.del(callId)
        forgetCallKeyMaterial(callId)
    }

    /** The call-creator to echo back on accept/preaccept (full JID, from the offer). */
    const callCreatorOf = (cached, callFrom) => cached?.from || cached?.callCreator || jidNormalizedUser(callFrom)

    // ---------------------------------------------------------------------
    // [MOD v2] acceptCall — wacrg SIG-05/SIG-06 shape (mirrors meowcaller
    // BuildAccept):
    //   <call to=from id=request-id><accept call-id call-creator count=0>
    //     audio(16000) → [video] → encopt(keygen=2) → capability(...bb 13)
    //     → enc (rekeyed media key) [destination]
    //   </accept></call>
    //
    // deferToMuteV2=true (default): waits for the caller's first <mute_v2>
    // before sending the accept — that is when real clients release it, and
    // sending it too early gets the call torn down.
    // ---------------------------------------------------------------------
    const acceptCall = async (callId, callFrom, opts = {}) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated', { statusCode: 401 })
        }
        if (!callId || !callFrom) {
            throw new Boom('acceptCall requires (callId, callFrom)', { statusCode: 400 })
        }

        const {
            isVideo,
            deferToMuteV2 = true,
            requestJid = undefined,
            audioInput = undefined,
            connectMedia = true,
            relayTimeoutMs = 30000,
            muteTimeoutMs = 60000,
        } = opts

        const cached = await callOfferCache.get(callId)
        const useVideo = typeof isVideo === 'boolean' ? isVideo : !!cached?.isVideo

        // Resolve the offer's media key (cached from handleCall/decryptCallKey).
        let offerKey = cached?.callKey || null
        if (!offerKey && cached?.offerNode) {
            try {
                offerKey = await decryptCallKey(callId, callFrom)
            } catch (e) {
                logger.debug({ err: e?.message }, '[MOD] acceptCall: late callKey decrypt failed')
            }
        }
        if (!offerKey) {
            logger.warn(
                { callId },
                '[MOD] acceptCall: no media callKey (offer not seen or <enc> undecryptable); accepting anyway'
            )
        }

        const targetJid = requestJid || callFrom

        // The real callee <accept> — mirrors the WhatsApp Web client's captured
        // accept (2026-09-10 13:03 call): relay(participant) → audio → net →
        // encopt → capability → metadata. NOT the rust build_accept shape: the
        // voip_settings child we shipped at 12:50 made the server DROP the
        // whole stanza (the caller never received the accept — calls went
        // silent from that moment). The web client sends no voip_settings.
        // The <relay><participant jid> announces OUR ANSWERING DEVICE: the
        // caller rekeys its recv path to that participant id (rust rekey_recv),
        // and we now encrypt under it (answerer role = real device jid).
        const sendAccept = async () => {
            const cfg = acceptConfig
            if (cfg.delayMs > 0) await new Promise((r) => setTimeout(r, cfg.delayMs))
            const content = []
            const selfDeviceLid = authState.creds.me?.lid || authState.creds.me?.id || ''
            // echo the offer's A/B metadata like the web client does
            let offerMeta = {}
            try {
                const on = typeof cached?.offerNode === 'string' ? JSON.parse(cached.offerNode) : cached?.offerNode
                const meta = (on?.content || []).find?.((c) => c?.tag === 'metadata')
                offerMeta = meta?.attrs || {}
            } catch { /* best effort */ }
            if (cfg.useRelay === 'echo') {
                // [MOD] echo the OFFER's relay block verbatim (it is
                // server-validated content — an invented/minimal relay child
                // makes the server drop the whole accept stanza), swapping
                // only the participant to OUR answering device. The caller's
                // client rekeys its recv path from that participant jid
                // (rust rekey_recv).
                try {
                    const on = typeof cached?.offerNode === 'string' ? JSON.parse(cached.offerNode) : cached?.offerNode
                    const relayNode = (on?.content || []).find?.((c) => c?.tag === 'relay')
                    const hasRealBuffers = relayNode && (relayNode.content || []).some?.((c) => c?.content && Buffer.isBuffer(c.content))
                    if (relayNode && hasRealBuffers) {
                        const cloneNode = (n) => ({
                            tag: n.tag,
                            attrs: { ...(n.attrs || {}) },
                            content: Array.isArray(n.content) ? n.content.map(cloneNode)
                                : (Buffer.isBuffer(n.content) || n.content instanceof Uint8Array ? Buffer.from(n.content) : n.content),
                        })
                        const clone = cloneNode(relayNode)
                        clone.attrs = { ...(clone.attrs || {}), peer_pid: '1', self_pid: '2' }
                        let kids = clone.content || []
                        const pIdx = kids.findIndex((c) => c?.tag === 'participant')
                        const ourPart = { tag: 'participant', attrs: { pid: '2', jid: selfDeviceLid }, content: undefined }
                        if (pIdx >= 0) kids[pIdx] = ourPart; else kids = [ourPart, ...kids]
                        clone.content = kids
                        content.push(clone)
                        logger.info({ callId, participant: selfDeviceLid }, '[MOD] accept relay block = echoed offer relay')
                    } else {
                        logger.warn({ callId }, '[MOD] accept relay echo: offer relay unavailable (no real buffers)')
                    }
                } catch (e) {
                    logger.warn({ err: String(e) }, '[MOD] accept relay echo failed')
                }
            } else if (cfg.useRelay === true) {
                content.push({
                    tag: 'relay',
                    attrs: { peer_pid: '1', self_pid: '2' },
                    content: [{ tag: 'participant', attrs: { pid: '2', jid: selfDeviceLid }, content: undefined }],
                })
            }
            const audioContent = [{ tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined }]
            if (useVideo) audioContent.push({ tag: 'video', attrs: {}, content: undefined })
            for (const c of audioContent) content.push(c)
            content.push({ tag: 'net', attrs: { medium: '2' }, content: undefined })
            content.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
            // MLow negotiation stays in the ACCEPT capability (bit cleared,
            // byte 5 = 0x3b): the caller in the A/B holdout must see the
            // cleared bit or it decodes our standard Opus as silence.
            content.push({
                tag: 'capability', attrs: { ver: '1' },
                content: Buffer.from(cfg.capHex, 'hex'),
            })
            const wantMeta = cfg.metadata === true || (cfg.metadata === 'auto' && offerMeta.peer_abtest_bucket)
            if (wantMeta) {
                content.push({
                    tag: 'metadata',
                    attrs: {
                        peer_abtest_bucket: offerMeta.peer_abtest_bucket,
                        ...(offerMeta.peer_abtest_bucket_id_list ? { peer_abtest_bucket_id_list: offerMeta.peer_abtest_bucket_id_list } : {}),
                    },
                    content: undefined,
                })
            }
            const stanza = {
                tag: 'call',
                attrs: {
                    to: callFrom,
                    id: generateMessageID(),
                },
                content: [{
                    tag: 'accept',
                    attrs: {
                        'call-id': callId,
                        'call-creator': callCreatorOf(cached, callFrom),
                    },
                    content,
                }],
            }
            await sendNode(stanza)
            return null
        }

        if (deferToMuteV2) {
            // wait for the caller's first <mute_v2> (handled in handleCall),
            // with a safety-net timeout for callers that never send it
            pendingAccepts.set(callId, {
                sendAccept, audioInput, connectMedia, relayTimeoutMs,
                callFrom, isVideo: useVideo,
            })
            if (cached) {
                await callOfferCache.set(callId, { ...cached, acceptPending: true, callKey: offerKey || cached.callKey })
            }
            const timer = setTimeout(() => {
                const p = pendingAccepts.get(callId)
                if (!p) return
                logger.info({ callId }, '[MOD] no mute_v2 from caller — sending accept anyway (timeout)')
                flushPendingAccept(callId).catch((e) => logger.warn({ err: e?.message }, '[MOD] fallback accept failed'))
            }, muteTimeoutMs)
            pendingAcceptTimers.set(callId, timer)
            return { id: callId, deferred: true, callKey: offerKey }
        }

        await sendAccept()
        if (cached) {
            await callOfferCache.set(callId, { ...cached, accepted: true })
        }

        if (connectMedia && audioInput !== undefined) {
            return connectCall(callId, callFrom, audioInput, { relayTimeoutMs })
        }
        return { id: callId, callKey: offerKey, callKeyHex: offerKey?.toString('hex') }
    }

    /** Fire a pending deferred accept (called when the caller's mute_v2 lands). */
    const flushPendingAccept = async (callId) => {
        const timer = pendingAcceptTimers.get(callId)
        if (timer) {
            clearTimeout(timer)
            pendingAcceptTimers.delete(callId)
        }
        const p = pendingAccepts.get(callId)
        if (!p) return false
        pendingAccepts.delete(callId)
        try {
            await p.sendAccept()
        } catch (e) {
            logger.warn({ err: e?.message }, '[MOD] deferred accept send failed')
            return false
        }
        const updated = await callOfferCache.get(callId)
        if (updated) {
            await callOfferCache.set(callId, {
                ...updated,
                acceptPending: false,
                accepted: true,
            })
        }
        if (p.connectMedia && p.audioInput !== undefined) {
            try {
                await connectCall(callId, p.callFrom, p.audioInput, { relayTimeoutMs: p.relayTimeoutMs })
            } catch (e) {
                logger.warn({ err: e?.message }, '[MOD] media connect after accept failed')
            }
        }
        return true
    }

    // ---------------------------------------------------------------------
    // [MOD] getCallInfo(groupJid) - pytgcalls/ntgcalls style "get_group_call".
    //
    // Discovery: any group-call offer/offer_notice we observe (via handleCall)
    // is indexed here, keyed by the GROUP jid. WhatsApp pushes an
    // <offer_notice type="group"> when a voice chat starts in a group the bot
    // is in; the real <offer> with <group_info> (roster + relay) follows.
    // ---------------------------------------------------------------------
    const getCallInfo = async (groupJid, opts = {}) => {
        const cached = activeGroupCalls.get(jidNormalizedUser(groupJid))
        if (cached && !opts.forceQuery) {
            return { ...cached, source: 'cache' }
        }
        // Ask the call service for the current state of this group's call.
        // (Node shape varies by WA version; the raw result is returned for
        // inspection. Real discovery still happens via offers.)
        try {
            const result = await query({
                tag: 'call',
                attrs: { to: jidNormalizedUser(groupJid) },
                content: [{
                    tag: 'call_info',
                    attrs: { call_id: opts.callId || '0', direction: '0' },
                }],
            })
            const findAttr = (n, name, out) => {
                if (!n || typeof n !== 'object') return out
                if (n.attrs && n.attrs[name] !== undefined) out.push(n.attrs[name])
                if (Array.isArray(n.content)) for (const c of n.content) findAttr(c, name, out)
                return out
            }
            const callId = findAttr(result, 'call-id', [])[0] || findAttr(result, 'call_id', [])[0]
            const callCreator = findAttr(result, 'call-creator', [])[0] || findAttr(result, 'creator', [])[0]
            const info = { groupJid, callId, callCreator, source: 'query', raw: result }
            if (callId) {
                activeGroupCalls.set(jidNormalizedUser(groupJid), { ...(cached || {}), ...info, discoveredAt: Date.now() })
            }
            return info
        } catch (e) {
            logger.warn({ err: e?.message, groupJid }, '[MOD] getCallInfo query failed')
            return cached ? { ...cached, source: 'cache-fallback' } : null
        }
    }

    const getActiveGroupCalls = () => Array.from(activeGroupCalls.values())

    // ---------------------------------------------------------------------
    // [MOD v2] joinGroupCall(groupJid, audioInput?, opts?) — join an ACTIVE
    // group voice chat and stream audio. Mirrors meowcaller's group join:
    //   preaccept → {callId}@call … accept (via request-id) → wait for
    //   enc_rekey epoch (group media key) → connect relay with group
    //   subscriptions (roster PIDs).
    // opts: { callId } to skip discovery.
    // ---------------------------------------------------------------------
    const joinGroupCall = async (groupJid, audioInput, opts = {}) => {
        const group = jidNormalizedUser(groupJid)
        let callId = opts.callId
        let info = null
        if (!callId) {
            info = await getCallInfo(group, opts)
            callId = info?.callId
        }
        if (!callId) {
            throw new Boom('No active group call found for ' + group +
                ' (start/observe a voice chat first, or pass an explicit callId)')
        }

        const callFrom = `${callId}@call`
        const cached = await callOfferCache.get(callId)
        if (!cached) {
            await callOfferCache.set(callId, {
                id: callId,
                from: callFrom,
                to: callFrom,
                isGroup: true,
                groupJid: group,
                date: new Date(),
            })
        } else {
            await callOfferCache.set(callId, { ...cached, isGroup: true, groupJid: group })
        }

        // [MOD] flapped-call re-join: a terminate between offers deletes the
        // announcement relay and the re-offer doesn't carry one — restore it
        // from the active-call index / announcement cache (same callId only)
        // so connectCall gets the web ICE credentials.
        {
            const activeForRestore = activeGroupCalls.get(group)
            const annForRestore = groupAnnouncementCache.get(group)
            const src = (activeForRestore?.callId === callId && activeForRestore.relay?.key?.length)
                ? activeForRestore
                : (annForRestore?.callId === callId && annForRestore.relay?.key?.length ? annForRestore : null)
            if (src) {
                const cur = await callOfferCache.get(callId)
                if (cur && !cur.relay?.key?.length) {
                    await callOfferCache.set(callId, {
                        ...cur,
                        relay: src.relay,
                        groupRelay: cur.groupRelay || src.groupRelay,
                    })
                    logger.info({ callId }, '[MOD] joinGroupCall: announcement relay restored from active-call index')
                }
            }
        }

        // group preaccept + accept are addressed to {callId}@call with the
        // offer's call-creator; sent immediately (no mute_v2 deferral for groups)
        const creator = cached?.from || cached?.callCreator || info?.callCreator || `${callId}@call`
        try {
            await preacceptGroupCall(callId, creator)
        } catch (e) {
            logger.debug({ err: e?.message }, '[MOD] joinGroupCall: preaccept failed (continuing)')
        }
        try {
            await acceptGroupCall(callId, creator)
        } catch (e) {
            logger.debug({ err: e?.message }, '[MOD] joinGroupCall: accept failed (continuing)')
        }

        // connect media (waits for the relay block + group epoch + roster)
        try {
            return await connectCall(callId, callFrom, audioInput, { ...opts, group: true, groupJid: group, relayTimeoutMs: opts.relayTimeoutMs || 60000 })
        } catch (e) {
            // the voice chat may have been restarted mid-join — retry once
            // against the currently active call
            const msg = String(e?.message || e)
            if (/disappeared mid-connect|timed out/.test(msg)) {
                const latest = activeGroupCalls.get(group)
                if (latest && latest.callId && latest.callId !== callId) {
                    logger.info({ stale: callId, current: latest.callId }, '[MOD] joinGroupCall: group call changed mid-join — retrying')
                    return joinGroupCall(group, audioInput, { ...opts, callId: latest.callId })
                }
            }
            throw e
        }
    }

    /**
     * Group preaccept: <call to={callId}@call id=fresh><preaccept call-id
     * call-creator=creator> audio(16000) → encopt(keygen=2) → capability(07).
     * (meowcaller BuildActiveGroupPreaccept)
     */
    const preacceptGroupCall = async (callId, creator) => {
        const content = [
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        ]
        content.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
        content.push({
            tag: 'capability', attrs: { ver: '1' },
            content: new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07]),
        })
        await sendNode({
            tag: 'call',
            attrs: { to: `${callId}@call`, id: generateMessageID() },
            content: [{
                tag: 'preaccept',
                attrs: { 'call-id': callId, 'call-creator': creator },
                content,
            }],
        })
    }

    /**
     * Group accept: <call to={callId}@call id=fresh><accept call-id
     * call-creator=creator> audio(16000) only.
     * (meowcaller BuildActiveGroupAccept — no metadata, no net, no capability)
     */
    const acceptGroupCall = async (callId, creator) => {
        const content = [
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        ]
        await sendNode({
            tag: 'call',
            attrs: { to: `${callId}@call`, id: generateMessageID() },
            content: [{
                tag: 'accept',
                attrs: { 'call-id': callId, 'call-creator': creator },
                content,
            }],
        })
    }

    // ---------------------------------------------------------------------
    // [MOD v2] connectCall — open the real media transport for a call and
    // (optionally) start streaming audio.
    //
    //   await sock.connectCall(callId, callFrom, 'song.mp3')
    //
    // What changed vs the old implementation: the transport is now the actual
    // WhatsApp relay path — RTCPeerConnection + DataChannel over DTLS/SCTP to
    // the relay endpoint from the <relay> block (te2), a WASM STUN allocate +
    // consent ping, and E2E-SRTP-protected RTP. See Utils/call-media.js.
    //
    // For a 1:1 call the relay may not be known yet (outgoing: it arrives in
    // <ack class="call">; incoming: in the offer / a follow-up <transport>);
    // connectCall polls the offer cache until relay+key are present.
    //
    // For group calls (opts.group) this also waits for the roster (group_info)
    // and the media epoch (enc_rekey) before connecting.
    // ---------------------------------------------------------------------
    const connectCall = async (callId, callFrom, audioInput, opts = {}) => {
        const relayTimeoutMs = opts.relayTimeoutMs || 30000
        const pollMs = 250
        const deadline = Date.now() + relayTimeoutMs
        const isGroup = !!(opts.group || (await callOfferCache.get(callId))?.isGroup)

        let cached = await callOfferCache.get(callId)
        if (!cached) {
            throw new Boom('No cached offer for callId; connect during an active offer')
        }

        // wait for: callKey + relay (1:1), plus epoch (group). Group PIDs are
        // optional — roster devices only get pid attrs once connected.
        for (;;) {
            cached = await callOfferCache.get(callId)
            if (!cached) {
                // self-heal: if this is the still-active group call, rebuild a
                // minimal entry instead of dying (some path deletes offer
                // entries mid-join; the group call itself remains valid)
                const active = Array.from(activeGroupCalls.values()).find((a) => a.callId === callId)
                if (isGroup && active) {
                    cached = {
                        id: callId,
                        isGroup: true,
                        groupJid: active.groupJid,
                        from: active.callCreator,
                        peerLid: active.callCreator,
                        relay: active.relay,
                        groupRelay: active.groupRelay,
                        date: new Date(),
                    }
                    await callOfferCache.set(callId, cached)
                    logger.warn({ callId }, '[MOD] connectCall: offer cache entry vanished — rebuilt from active group call')
                } else {
                    throw new Boom('offer cache entry disappeared mid-connect')
                }
            }
            const epoch = groupEpochs.get(callId) || cached.groupEpoch
            const callKey = cached.callKey
                || (isGroup && epoch?.rawKey?.length ? epoch.rawKey : null)
                || (cached.offerNode ? await decryptCallKey(callId, callFrom) : null)
            const relayReady = !!(cached.relay?.key?.length && cached.relay?.endpoints?.length)
            const groupReady = !isGroup || !!epoch
            if (callKey && relayReady && groupReady) break

            if (Date.now() > deadline) {
                throw new Boom(
                    `connectCall: timed out after ${relayTimeoutMs}ms waiting for ` +
                    `${!callKey ? 'media callKey ' : ''}${!relayReady ? 'relay block ' : ''}` +
                    `${isGroup && !groupReady ? 'group roster/epoch ' : ''}(call ${callId})`,
                    { statusCode: 408 }
                )
            }
            await delay(pollMs)
        }

        cached = await callOfferCache.get(callId)
        const epoch0 = groupEpochs.get(callId) || cached.groupEpoch
        const callKey = cached.callKey
            || (isGroup && epoch0?.rawKey?.length ? epoch0.rawKey : null)
            || await decryptCallKey(callId, callFrom)
        if (!callKey) {
            throw new Boom('Missing media callKey; cannot derive media keys')
        }

        // reuse a live session instead of leaking a second one
        const existing = callMediaSessions.get(callId)
        if (existing && !existing.closed) {
            logger.debug({ callId }, '[MOD] connectCall: reusing live media session')
            if (audioInput) existing.streamAudio?.(audioInput, opts.audioQuality || {})
            return existing
        }

        const selfLid = cached.selfLid || authState.creds.me?.lid || authState.creds.me?.id
        // E2E SRTP participant ids: send = OUR LID, recv = PEER LID. The relay
        // block's <participant pid=peer_pid> is authoritative when present
        // (it is the device actually on the call).
        const peerLid = cached.relay?.peerJid || cached.peerLid || cached.from || callFrom

        const session = new WACallMediaSession({
            callId,
            callKey,
            relay: cached.relay,
            selfLid,
            peerLid,
            logger,
            inbound: !cached.outgoing,
            group: isGroup,
            peerMlow: cached.mlowPeer === true,
        })
        if (isGroup) {
            const roster = groupRosters.get(callId)
            const pids = roster?.pids?.length ? roster.pids : (cached.groupPids || [])
            session.setGroupPids(pids)
            if (cached.groupRelay) session.setGroupRelay(cached.groupRelay)
            const epoch = groupEpochs.get(callId) || cached.groupEpoch
            if (epoch?.rawKey) session.installEpoch(epoch.rawKey)
        }
        callMediaSessions.set(callId, session)

        // surface inbound media as events
        session.on('rtp', ({ header, payload, participantId }) => {
            ev.emit('call.media', { callId, status: 'rtp', header, payload, participantId })
            ev.emit('call.rtp', [{ callId, header, payload, participantId }])
        })
        session.on('connected', (info) => {
            ev.emit('call.media', { callId, status: 'connected', ...info })
        })
        session.on('closed', () => {
            callMediaSessions.delete(callId)
            ev.emit('call.media', { callId, status: 'closed' })
        })

        try {
            await session.connect({ channelTimeoutMs: opts.channelTimeoutMs || 15000 })
        } catch (e) {
            callMediaSessions.delete(callId)
            try { session.close() } catch { /* best effort */ }
            throw e
        }

        if (audioInput && typeof audioInput === 'object' && !Array.isArray(audioInput) && (audioInput.video || audioInput.audio)) {
            // input given as { audio, audioQuality }
            if (audioInput.audio) session.streamAudio(audioInput.audio, audioInput.audioQuality || opts.audioQuality || {})
        } else if (audioInput) {
            session.streamAudio(audioInput, opts.audioQuality || {})
        }
        return session
    }

    const stopCallMedia = (callId) => {
        const session = callMediaSessions.get(callId)
        if (!session) return false
        session.close()
        callMediaSessions.delete(callId)
        return true
    }

    /** [MOD] access a live media session (for wiring 'rtp' events manually). */
    const getCallMediaSession = (callId) => callMediaSessions.get(callId) || null

    const rejectCall = async (callId, callFrom) => {
        const stanza = ({
            tag: 'call',
            attrs: {
                from: selfJidFor(callFrom),
                to: callFrom,
                id: generateMessageTag()
            },
            content: [{
                tag: 'reject',
                attrs: {
                    'call-id': callId,
                    'call-creator': jidNormalizedUser(callFrom),
                    count: '0',
                },
                content: undefined,
            }],
        })

        await sendNode(stanza)

        // [MOD] we rejected it ourselves — the terminal stanza may never come
        // back to us, so clear the cached offer/key material now instead of
        // waiting out the cache TTL.
        await callOfferCache.del(callId)
        forgetCallKeyMaterial(callId)
    }

    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        const { fullMessage } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '')
        const { key: msgKey } = fullMessage
        const msgId = msgKey.id

        if (messageRetryManager) {
            // Check if we've exceeded max retries using the new system
            if (messageRetryManager.hasExceededMaxRetries(msgId)) {
                logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
                messageRetryManager.markRetryFailed(msgId)
                return
            }

            // Increment retry count using new system
            const retryCount = messageRetryManager.incrementRetryCount(msgId)

            // Use the new retry count for the rest of the logic
            const key = `${msgId}:${msgKey?.participant}`
            await msgRetryCache.set(key, retryCount)
        }

        else {
            // Fallback to old system
            const key = `${msgId}:${msgKey?.participant}`

            let retryCount = (await msgRetryCache.get(key)) || 0

            if (retryCount >= maxMsgRetryCount) {
                logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')

                await msgRetryCache.del(key)

                return
            }

            retryCount += 1

            await msgRetryCache.set(key, retryCount)
        }

        const key = `${msgId}:${msgKey?.participant}`
        const retryCount = (await msgRetryCache.get(key)) || 1
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
        const fromJid = node.attrs.from

        // Check if we should recreate the session
        let shouldRecreateSession = false
        let recreateReason = ''

        if (enableAutoSessionRecreation && messageRetryManager) {
            try {
                // Check if we have a session with this JID
                const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
                const hasSession = await signalRepository.validateSession(fromJid)
                const result = messageRetryManager.shouldRecreateSession(fromJid, retryCount, hasSession.exists)

                shouldRecreateSession = result.recreate
                recreateReason = result.reason

                if (shouldRecreateSession) {
                    logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')

                    // Delete existing session to force recreation
                    await authState.keys.set({ session: { [sessionId]: null } })

                    forceIncludeKeys = true
                }
            }

            catch (error) {
                logger.warn({ error, fromJid }, 'failed to check session recreation')
            }
        }

        if (retryCount <= 2) {
            // Use new retry manager for phone requests if available
            if (messageRetryManager) {
                // Schedule phone request with delay (like whatsmeow)
                messageRetryManager.schedulePhoneRequest(msgId, async () => {
                    try {
                        const requestId = await requestPlaceholderResend(msgKey)

                        logger.debug(`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`)
                    }

                    catch (error) {
                        logger.warn({ error, msgId }, 'failed to send scheduled phone request')
                    }
                })
            }

            else {
                // Fallback to immediate request
                const msgId = await requestPlaceholderResend(msgKey)

                logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
            }
        }

        const deviceIdentity = encodeSignedDeviceIdentity(account, true)

        await authState.keys.transaction(async () => {
            const receipt = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1',
                            // ADD ERROR FIELD
                            error: '0'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            }

            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient
            }

            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant
            }

            if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
                const { update, preKeys } = await getNextPreKeys(authState, 1)
                const [keyId] = Object.keys(preKeys)
                const key = preKeys[+keyId]
                const content = receipt.content

                content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                })

                ev.emit('creds.update', update)
            }

            await sendNode(receipt)

            logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
        }, authState?.creds?.me?.id || 'sendRetryRequest')
    }

    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from

        if (from === S_WHATSAPP_NET) {
            const countChild = getBinaryNodeChild(node, 'count')
            const count = +countChild.attrs.value
            const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

            logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')

            if (shouldUploadMorePreKeys) {
                await uploadPreKeys()
            }
        }

        else {
            const identityNode = getBinaryNodeChild(node, 'identity')

            if (identityNode) {
                logger.info({ jid: from }, 'identity changed')

                if (identityAssertDebounce.get(from)) {
                    logger.debug({ jid: from }, 'skipping identity assert (debounced)')
                    return
                }

                identityAssertDebounce.set(from, true)

                try {
                    await assertSessions([from], true)
                }

                catch (error) {
                    logger.warn({ error, jid: from }, 'failed to assert sessions after identity change')
                }
            }

            else {
                logger.info({ node }, 'unknown encrypt notification')
            }
        }
    }

    const handleGroupNotification = (fullNode, child, msg) => {
        // TODO: Support PN/LID (Here is only LID now)
        const actingParticipantLid = fullNode.attrs.participant
        const actingParticipantPn = fullNode.attrs.participant_pn
        const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid
        const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn

        switch (child?.tag) {
            case 'create':
                const metadata = extractGroupMetadata(child)
                msg.messageStubType = WAMessageStubType.GROUP_CREATE
                msg.messageStubParameters = [metadata.subject]
                msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }

                ev.emit('chats.upsert', [
                    {
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation
                    }
                ])

                ev.emit('groups.upsert', [
                    {
                        ...metadata,
                        author: actingParticipantLid,
                        authorPn: actingParticipantPn
                    }
                ])
                break
            case 'ephemeral':
            case 'not_ephemeral':
                msg.message = {
                    protocolMessage: {
                        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                }
                break
            case 'modify':
                const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
                msg.messageStubParameters = oldNumber || []
                msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
                break
            case 'promote':
            case 'demote':
            case 'remove':
            case 'add':
            case 'leave':
                const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
                msg.messageStubType = WAMessageStubType[stubType]
                const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
                    // TODO: Store LID MAPPINGS
                    return {
                        id: attrs.jid,
                        phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                        lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
                        admin: (attrs.type || null)
                    }
                })

                if (participants.length === 1 &&
                    // if recv. "remove" message and sender removed themselves
                    // mark as left
                    (areJidsSameUser(participants[0].id, actingParticipantLid) ||
                        areJidsSameUser(participants[0].id, actingParticipantPn)) &&
                    child.tag === 'remove') {
                    msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
                }

                msg.messageStubParameters = participants.map(a => JSON.stringify(a))
                break
            case 'subject':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
                msg.messageStubParameters = [child.attrs.subject]
                break
            case 'description':
                const description = getBinaryNodeChild(child, 'body')?.content?.toString()
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
                msg.messageStubParameters = description ? [description] : undefined
                break
            case 'announcement':
            case 'not_announcement':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
                msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
                break
            case 'locked':
            case 'unlocked':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
                msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
                break
            case 'invite':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
                msg.messageStubParameters = [child.attrs.code]
                break
            case 'member_add_mode':
                const addMode = child.content;
                if (addMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
                    msg.messageStubParameters = [addMode.toString()]
                }
                break
            case 'membership_approval_mode':
                const approvalMode = getBinaryNodeChild(child, 'group_join')
                if (approvalMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
                    msg.messageStubParameters = [approvalMode.attrs.state]
                }
                break
            case 'created_membership_requests':
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    'created',
                    child.attrs.request_method
                ]
                break
            case 'revoked_membership_requests':
                const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid)
                // TODO: LIDMAPPING SUPPORT
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    isDenied ? 'revoked' : 'rejected'
                ]
                break
        }
    }

    const handleNewsletterNotification = (id, node) => {
        const messages = getBinaryNodeChild(node, 'messages')
        const message = getBinaryNodeChild(node, 'message')
        const serverId = node.attrs.server_id

        const reactionsList = getBinaryNodeChild(node, 'reactions')
        const viewsList = getBinaryNodeChild(node, 'views_count')

        if (reactionsList) {
            const reactions = getBinaryNodeChild(reactionsList, 'reaction')

            if (reactions.length === 0) {
                ev.emit('newsletter.reaction', {
                    id,
                    newsletter_server_id: serverId,
                    reaction: {
                        removed: true
                    }
                })
            }

            reactions.forEach(item => {
                ev.emit('newsletter.reaction', {
                    id,
                    newsletter_server_id: serverId,
                    reaction: {
                        code: item.attrs?.code,
                        count: +item.attrs.count
                    }
                })
            })
        }

        if (viewsList.length) {
            viewsList.forEach(item => {
                ev.emit('newsletter.view', {
                    id,
                    newsletter_server_id: serverId,
                    count: +item.attrs.count
                })
            })
        }
    }

    const handleMexNotification = (id, node) => {
        const operation = node?.attrs?.op_name
        const content = JSON.parse(node?.content)

        let contentPath
        let action

        if (operation === MexOperations.UPDATE) {
            contentPath = content.data[XWAPaths.METADATA_UPDATE]

            ev.emit('newsletter-settings.update', {
                id,
                update: contentPath.thread_metadata.settings
            })
        } else if (operation === MexUpdatesOperations.GROUP_MEMBER_LINK) {
            contentPath = content.data[XWAPathsMexUpdates.GROUP_SHARING_CHANGE]

            ev.emit('groups.update', [{
                id,
                author: contentPath.updated_by.id,
                member_link_mode: contentPath.properties.member_link_mode
            }])
        } else if (operation === MexUpdatesOperations.GROUP_LIMIT_SHARING) {
            contentPath = content.data[XWAPathsMexUpdates.GROUP_SHARING_CHANGE]

            ev.emit('limit-sharing.update', {
                id,
                author: contentPath.updated_by?.pn ? contentPath.updated_by.pn : contentPath.updated_by.id,
                action: `${contentPath.properties.limit_sharing.limit_sharing_enabled ? 'on' : 'off'}`,
                trigger: contentPath.properties.limit_sharing.limit_sharing_trigger,
                update_time: contentPath.update_time
            })
        } else if (operation === MexUpdatesOperations.OWNER_COMMUNITY) {
            contentPath = content.data[XWAPathsMexUpdates.COMMUNITY_OWNER_CHANGE]

            ev.emit('community-owner.update', {
                id,
                author: contentPath.updated_by?.pn ? contentPath.updated_by.pn : contentPath.updated_by.id,
                user: contentPath.role_updates[0].user?.pn ? contentPath.role_updates[0].user.pn : contentPath.role_updates[0].user.jid,
                new_role: contentPath.role_updates[0].new_role,
                update_time: contentPath.update_time
            })
        } else {

            if (operation === MexOperations.PROMOTE) {
                action = 'promote'
                contentPath = content.data[XWAPaths.PROMOTE]
            } else {
                action = 'demote'
                contentPath = content.data[XWAPaths.DEMOTE]
            }

            ev.emit('newsletter-participants.update', {
                id,
                author: contentPath.actor.pn,
                user: contentPath.user.pn,
                new_role: contentPath.user_new_role,
                action
            })
        }
    }

    const processNotification = async (node) => {
        const result = {}
        const [child] = getAllBinaryNodeChildren(node)
        const nodeType = node.attrs.type
        const from = jidNormalizedUser(node.attrs.from)

        switch (nodeType) {
            case 'w:gp2':
                // TODO: HANDLE PARTICIPANT_PN
                handleGroupNotification(node, child, result)
                break
            case 'newsletter':
                handleNewsletterNotification(node.attrs.from, child)
                break
            case 'mex':
                handleMexNotification(node.attrs.from, child, result)
                break
            case 'mediaretry':
                const event = decodeMediaRetryNode(node)
                ev.emit('messages.media-update', [event])
                break
            case 'encrypt':
                await handleEncryptNotification(node)
                break
            case 'devices':
                const devices = getBinaryNodeChildren(child, 'device')
                if (areJidsSameUser(child.attrs.jid, authState.creds.me.id) ||
                    areJidsSameUser(child.attrs.lid, authState.creds.me.lid)) {
                    const deviceData = devices.map(d => ({ id: d.attrs.jid, lid: d.attrs.lid }))
                    logger.info({ deviceData }, 'my own devices changed')
                }
                //TODO: drop a new event, add hashes
                break
            case 'server_sync':
                const update = getBinaryNodeChild(node, 'collection')
                if (update) {
                    const name = update.attrs.name
                    await resyncAppState([name], false)
                }
                break
            case 'picture':
                const setPicture = getBinaryNodeChild(node, 'set')
                const delPicture = getBinaryNodeChild(node, 'delete')

                ev.emit('contacts.update', [
                    {
                        id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
                        imgUrl: setPicture ? 'changed' : 'removed'
                    }
                ])

                if (isJidGroup(from)) {
                    const node = setPicture || delPicture

                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id]
                    }

                    result.participant = node?.attrs.author
                    result.key = {
                        ...(result.key || {}),
                        participant: setPicture?.attrs.author
                    }
                }
                break
            case 'account_sync':
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration
                    const timestamp = +child.attrs.t
                    logger.info({ newDuration }, 'updated account disappearing mode')
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    })
                }

                else if (child.tag === 'blocklist') {
                    const blocklists = getBinaryNodeChildren(child, 'item')
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid]
                        const type = attrs.action === 'block' ? 'add' : 'remove'
                        ev.emit('blocklist.update', { blocklist, type })
                    }
                }
                break
            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'))
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'))
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
                const companionSharedKey = Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey)
                const random = randomBytes(32)
                const linkCodeSalt = randomBytes(32)
                const linkCodePairingExpanded = await hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                })
                const encryptPayload = Buffer.concat([
                    Buffer.from(authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ])
                const encryptIv = randomBytes(12)
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
                const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])

                authState.creds.advSecretKey = (await hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')

                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: suki.generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                })

                authState.creds.registered = true
                ev.emit('creds.update', authState.creds)
                break
            case 'privacy_token':
                await handlePrivacyTokenNotification(node)
                break
        }

        if (Object.keys(result).length) {
            return result
        }
    }

    const handlePrivacyTokenNotification = async (node) => {
        const tokensNode = getBinaryNodeChild(node, 'tokens')
        const from = jidNormalizedUser(node.attrs.from)

        if (!tokensNode) return

        const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')

        for (const tokenNode of tokenNodes) {
            const { attrs, content } = tokenNode
            const type = attrs.type
            const timestamp = attrs.t

            if (type === 'trusted_contact' && content instanceof Buffer) {
                logger.debug({
                    from,
                    timestamp,
                    tcToken: content
                }, 'received trusted contact token')

                await authState.keys.set({
                    tctoken: { [from]: { token: content, timestamp } }
                })
            }
        }
    }

    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data)
        const salt = buffer.slice(0, 32)
        const secretKey = await derivePairingCodeKey(authState.creds.pairingCode, salt)
        const iv = buffer.slice(32, 48)
        const payload = buffer.slice(48, 80)
        return aesDecryptCTR(payload, secretKey, iv)
    }

    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Boom('Invalid buffer', { statusCode: 400 })
        }
        return data instanceof Buffer ? data : Buffer.from(data)
    }

    const willSendMessageAgain = async (id, participant) => {
        const key = `${id}:${participant}`
        const retryCount = (await msgRetryCache.get(key)) || 0
        return retryCount < maxMsgRetryCount
    }

    const updateSendMessageAgainCount = async (id, participant) => {
        const key = `${id}:${participant}`
        const newValue = ((await msgRetryCache.get(key)) || 0) + 1
        await msgRetryCache.set(key, newValue)
    }

    const sendMessagesAgain = async (key, ids, retryNode) => {
        const remoteJid = key.remoteJid
        const participant = key.participant || remoteJid
        const retryCount = +retryNode.attrs.count || 1

        // Try to get messages from cache first, then fallback to getMessage
        const msgs = []

        for (const id of ids) {
            let msg

            // Try to get from retry cache first if enabled
            if (messageRetryManager) {
                const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)

                if (cachedMsg) {
                    msg = cachedMsg.message
                    logger.debug({ jid: remoteJid, id }, 'found message in retry cache')

                    // Mark retry as successful since we found the message
                    messageRetryManager.markRetrySuccess(id)
                }
            }

            // Fallback to getMessage if not found in cache
            if (!msg) {
                msg = await getMessage({ ...key, id })

                if (msg) {
                    logger.debug({ jid: remoteJid, id }, 'found message via getMessage')

                    // Also mark as successful if found via getMessage
                    if (messageRetryManager) {
                        messageRetryManager.markRetrySuccess(id)
                    }
                }
            }

            msgs.push(msg)
        }

        // if it's the primary jid sending the request
        // just re-send the message to everyone
        // prevents the first message decryption failure
        const sendToAll = !jidDecode(participant)?.device

        // Check if we should recreate session for this retry
        let shouldRecreateSession = false
        let recreateReason = ''

        if (enableAutoSessionRecreation && messageRetryManager) {
            try {
                const sessionId = signalRepository.jidToSignalProtocolAddress(participant)
                const hasSession = await signalRepository.validateSession(participant)
                const result = messageRetryManager.shouldRecreateSession(participant, retryCount, hasSession.exists)

                shouldRecreateSession = result.recreate
                recreateReason = result.reason

                if (shouldRecreateSession) {
                    logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry')
                    await authState.keys.set({ session: { [sessionId]: null } })
                }
            }

            catch (error) {
                logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
            }
        }

        await assertSessions([participant], true)

        if (isJidGroup(remoteJid)) {
            await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
        }

        logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason }, 'forced new session for retry recp')

        for (const [i, msg] of msgs.entries()) {
            if (!ids[i]) continue

            if (msg && (await willSendMessageAgain(ids[i], participant))) {
                await updateSendMessageAgainCount(ids[i], participant)
                const msgRelayOpts = { messageId: ids[i] }

                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false
                }

                else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: +retryNode.attrs.count
                    }
                }

                await relayMessage(key.remoteJid, msg, msgRelayOpts)
            }

            else {
                logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
            }
        }
    }

    const handleReceipt = async (node) => {
        const { attrs, content } = node
        const isLid = attrs.from.includes('lid')
        const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id)
        const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
        const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant
        }

        if (shouldIgnoreJid(remoteJid) && remoteJid !== S_WHATSAPP_NET) {
            logger.debug({ remoteJid }, 'ignoring receipt from jid')
            await sendMessageAck(node)
            return
        }

        const ids = [attrs.id]

        if (Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], 'item')
            ids.push(...items.map(i => i.attrs.id))
        }

        try {
            await Promise.all([
                receiptMutex.mutex(async () => {
                    const status = getStatusFromReceiptType(attrs.type)

                    if (typeof status !== 'undefined' &&
                        // basically, we only want to know when a message from us has been delivered to/read by the other person
                        // or another device of ours has read some messages
                        (status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)) {
                        if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'

                                ev.emit('message-receipt.update', ids.map(id => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })))
                            }
                        }

                        else {
                            ev.emit('messages.update', ids.map(id => ({
                                key: { ...key, id },
                                update: { status }
                            })))
                        }
                    }

                    if (attrs.type === 'retry') {
                        // correctly set who is asking for the retry
                        key.participant = key.participant || attrs.from

                        const retryNode = getBinaryNodeChild(node, 'retry')

                        if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
                            if (key.fromMe) {
                                try {
                                    await updateSendMessageAgainCount(ids[0], key.participant)

                                    logger.debug({ attrs, key }, 'recv retry request')

                                    await sendMessagesAgain(key, ids, retryNode)
                                }

                                catch (error) {
                                    logger.error({ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' }, 'error in sending message again')
                                }
                            }

                            else {
                                logger.info({ attrs, key }, 'recv retry for not fromMe message')
                            }
                        }

                        else {
                            logger.info({ attrs, key }, 'will not send message again, as sent too many times')
                        }
                    }
                })
            ])
        }

        finally {
            await sendMessageAck(node)
        }
    }

    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from
        if (shouldIgnoreJid(remoteJid) && remoteJid !== S_WHATSAPP_NET) {
            logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification')
            await sendMessageAck(node)
            return
        }

        try {
            await Promise.all([
                notificationMutex.mutex(async () => {
                    const msg = await processNotification(node)

                    if (msg) {
                        const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me.id)
                        const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node)

                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            participantAlt,
                            addressingMode,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        }

                        msg.participant ?? (msg.participant = node.attrs.participant)
                        msg.messageTimestamp = +node.attrs.t

                        const fullMsg = proto.WebMessageInfo.fromObject(msg)

                        await upsertMessage(fullMsg, 'append')
                    }
                })
            ])
        }

        finally {
            await sendMessageAck(node)
        }
    }

    const handleMessage = async (node) => {
        if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== S_WHATSAPP_NET) {
            logger.debug({ key: node.attrs.key }, 'ignored message')
            await sendMessageAck(node, NACK_REASONS.UnhandledError)
            return
        }

        const encNode = getBinaryNodeChild(node, 'enc')

        // TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
        if (encNode && encNode.attrs.type === 'msmsg') {
            logger.debug({ key: node.attrs.key }, 'ignored msmsg')
            await sendMessageAck(node, NACK_REASONS.MissingMessageSecret)
            return
        }

        const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger);
        const alt = msg.key.participantAlt || msg.key.remoteJidAlt;
        // store new mappings we didn't have before
        if (!!alt) {
            const altServer = jidDecode(alt)?.server
            const primaryJid = msg.key.participant || msg.key.remoteJid

            if (altServer === 'lid') {
                if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
                    await signalRepository.migrateSession(primaryJid, alt)
                }
            }

            else {
                await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
                await signalRepository.migrateSession(alt, primaryJid)
            }
        }

        if (msg.key?.remoteJid && msg.key?.id && messageRetryManager) {
            messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message)
            logger.debug({
                jid: msg.key.remoteJid,
                id: msg.key.id
            }, 'Added message to recent cache for retry receipts')
        }

        try {
            await messageMutex.mutex(async () => {
                await decrypt()

                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT ||
                        msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
                        return sendMessageAck(node)
                    }

                    const errorMessage = msg?.messageStubParameters?.[0] || ''
                    const isPreKeyError = errorMessage.includes('PreKey')

                    logger.debug(`[handleMessage] Attempting retry request for failed decryption`)

                    // Handle both pre-key and normal retries in single mutex
                    await retryMutex.mutex(async () => {
                        try {
                            if (!ws.isOpen) {
                                logger.debug({ node }, 'Connection closed, skipping retry')
                                return
                            }

                            // Handle pre-key errors with upload and delay
                            if (isPreKeyError) {
                                logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')

                                try {
                                    logger.debug('Uploading pre-keys for error recovery')
                                    await uploadPreKeys(5)
                                    logger.debug('Waiting for server to process new pre-keys')
                                    await delay(1000)
                                }

                                catch (uploadErr) {
                                    logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
                                }
                            }

                            const encNode = getBinaryNodeChild(node, 'enc')

                            await sendRetryRequest(node, !encNode)

                            if (retryRequestDelayMs) {
                                await delay(retryRequestDelayMs)
                            }
                        }

                        catch (err) {
                            logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')

                            // Still attempt retry even if pre-key upload failed
                            try {
                                const encNode = getBinaryNodeChild(node, 'enc')

                                await sendRetryRequest(node, !encNode)
                            }

                            catch (retryErr) {
                                logger.error({ retryErr }, 'Failed to send retry after error handling')
                            }
                        }

                        await sendMessageAck(node, NACK_REASONS.UnhandledError)
                    })
                }

                else {
                    if (messageRetryManager && msg.key.id) {
                        messageRetryManager.cancelPendingPhoneRequest(msg.key.id)
                    }

                    const isNewsletter = isJidNewsletter(msg.key.remoteJid)

                    if (!isNewsletter) {
                        // no type in the receipt => message delivered
                        let type = undefined
                        let participant = msg.key.participant

                        if (category === 'peer') {
                            // special peer message
                            type = 'peer_msg'
                        }

                        else if (msg.key.fromMe) {
                            // message was sent by us from a different device
                            type = 'sender'

                            // need to specially handle this case
                            if (isLidUser(msg.key.remoteJid) || isLidUser(msg.key.remoteJidAlt)) {
                                participant = author // TODO: investigate sending receipts to LIDs and not PNs
                            }
                        }

                        else if (!sendActiveReceipts) {
                            type = 'inactive'
                        }

                        await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type)

                        // send ack for history message
                        const isAnyHistoryMsg = getHistoryMsg(msg.message)

                        if (isAnyHistoryMsg) {
                            const jid = jidNormalizedUser(msg.key.remoteJid)
                            await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync') // TODO: investigate
                        }
                    }

                    else {
                        await sendMessageAck(node)
                        logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
                    }
                }

                cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid)

                await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
            })
        }

        catch (error) {
            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message')
        }
    }

    // ---------------------------------------------------------------------
    // [MOD v2] handleCall — every <call> node flows through here. Implements
    // the full callee/caller control path that was missing:
    //   • <relay> block parsing on offer/transport/relaylatency
    //   • offer receipts (<receipt><offer/></receipt>) for inbound offers
    //   • eager <preaccept> on inbound 1:1 offers (real clients send it while
    //     ringing; without it the caller never starts relaylatency probes)
    //   • <relaylatency> probe echo (the callee's half of relay election)
    //   • <mute_v2> → releases the deferred <accept>
    //   • group offers (<group_info> roster + relay) → activeGroupCalls
    //   • <enc_rekey> → group media epoch (DecryptDM → Message.call.callKey)
    //   • <group_update> roster refresh (PIDs for relay subscriptions)
    // ---------------------------------------------------------------------
    const handleCall = async (node) => {
        // [MOD] typed call-control ack target — hoisted so the finally block
        // can always reference it (see CALL_CONTROL_ACTIONS below)
        let ackTyped = null
        try {
            const { attrs } = node
            const [infoChild] = getAllBinaryNodeChildren(node)

            if (!infoChild) {
                throw new Boom('Missing call info in call node')
            }

            const actionTag = infoChild.tag
            const status = getCallStatusFromNode(infoChild) || actionTag

            // [MOD] typed call-control ack (see the finally block): control
            // actions require <ack class="call" type={action}/> — a typeless
            // ack does not satisfy the group creator (meowcaller
            // BuildCallControlAck), which then never sends our enc_rekey.
            const CALL_CONTROL_ACTIONS = new Set([
                'group_update', 'enc_rekey', 'waiting_room_update', 'user_action', 'screen_share',
            ])
            if (CALL_CONTROL_ACTIONS.has(actionTag) && attrs.id && attrs.from) {
                ackTyped = {
                    tag: 'ack',
                    attrs: {
                        class: 'call',
                        id: attrs.id,
                        to: attrs.from,
                        type: actionTag,
                        ...(attrs.participant ? { participant: attrs.participant } : {}),
                        ...(attrs.recipient ? { recipient: attrs.recipient } : {}),
                    },
                }
            }

            const callId = infoChild.attrs['call-id']
            const creator = infoChild.attrs['call-creator'] || infoChild.attrs.from || attrs.from
            const sender = attrs.from || creator
            // 'from' = the OTHER party: on our outgoing calls the call-creator
            // is US, so use the stanza sender (the callee) instead.
            const meBare = (j) => (j ? String(j).split('/')[0] : '')
            const meIds = [meBare(authState.creds.me?.id), meBare(authState.creds.me?.lid)]
            const from = meIds.includes(meBare(creator)) && !meIds.includes(meBare(sender))
                ? sender
                : creator
            const call = {
                chatId: attrs.from,
                from,
                callerPn: infoChild.attrs['caller_pn'] || infoChild.attrs.caller_pn,
                callerLid: infoChild.attrs['caller_lid'] || infoChild.attrs.caller_lid,
                id: callId,
                date: new Date(+attrs.t * 1000),
                offline: !!attrs.offline,
                status
            }

            // -----------------------------------------------------------------
            // relay block: any call node may carry one (offer / transport /
            // relaylatency / ack). Merge it into the offer cache.
            // -----------------------------------------------------------------
            const relayNode = findRelayNode(node)
            if (relayNode && callId) {
                const merged = await ingestRelayData(callId, relayNode, actionTag === 'offer' ? 'offer' : `update:${actionTag}`)
                if (merged?.endpoints?.length) {
                    logger.info(
                        { callId, endpoints: merged.endpoints.map((e) => `${e.ip}:${e.port}(${e.relayName || e.relayId}${e.isFna ? ',fna' : ''})`), peerJid: merged.peerJid },
                        '[MOD] relay block cached'
                    )
                }
            } else if (actionTag === 'transport' && callId) {
                // raw dump of the transport node — understand what the callee
                // negotiates here (relay data? ICE? codecs?)
                try {
                    logger.info({ callId, node: JSON.stringify(node, (k, v) => {
                        if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
                            const b = Buffer.from(v)
                            return 'hex[' + b.length + ']: ' + b.toString('hex').slice(0, 120)
                        }
                        return v
                    }, 0)?.slice(0, 2500) }, '[MOD] raw transport node')
                } catch { /* best effort */ }
            }

            // -----------------------------------------------------------------
            // relaylatency: the CALLEE echoes the caller's probes back (its half
            // of relay election). Guard hard against loops:
            //   • only for calls where WE received the offer (incoming)
            //   • never echo a node whose sender is ourselves (self-echo loop!)
            //   • rate-limited per call
            // (meowcaller: direction == CallDirectionIncoming only)
            // -----------------------------------------------------------------
            if (actionTag === 'relaylatency' && callId) {
                const meIds = [authState.creds.me?.id, authState.creds.me?.lid]
                    .map((j) => j && String(j).split('/')[0]).filter(Boolean)
                const fromIsSelf = meIds.some((me) => me === String(from || '').split('/')[0])
                const cachedForEcho = await callOfferCache.get(callId)
                const isCallee = !!cachedForEcho?.incoming && !cachedForEcho?.outgoing
                const now = Date.now()
                const rl = relayLatencyEchoState.get(callId) || { count: 0, windowStart: now }
                if (now - rl.windowStart > 5000) { rl.count = 0; rl.windowStart = now }
                relayLatencyEchoState.set(callId, rl)
                const teChildren = getAllBinaryNodeChildren(infoChild).filter((c) => c?.tag === 'te')
                if (isCallee && !fromIsSelf && rl.count < 10 && teChildren.length) {
                    rl.count += teChildren.length
                    for (const te of teChildren) {
                        const encLatency = te.attrs?.latency
                        const relayName = te.attrs?.relay_name
                        const addr = Buffer.isBuffer(te.content) || te.content instanceof Uint8Array ? Buffer.from(te.content) : Buffer.alloc(0)
                        if (!encLatency || !relayName) continue
                        try {
                            await sendNode({
                                tag: 'call',
                                attrs: { to: from, id: generateMessageID() },
                                content: [{
                                    tag: 'relaylatency',
                                    attrs: { 'call-id': callId, 'call-creator': from },
                                    content: [{
                                        tag: 'te',
                                        attrs: { latency: encLatency, relay_name: relayName },
                                        content: addr,
                                    }],
                                }],
                            })
                            logger.debug({ callId, relayName, latency: encLatency }, '[MOD] relaylatency probe answered')
                        } catch (e) {
                            logger.warn({ err: e?.message }, '[MOD] relaylatency echo failed')
                        }
                    }
                } else if (teChildren.length) {
                    logger.debug(
                        { callId, from, fromIsSelf, isCallee, echoCount: rl.count },
                        '[MOD] relaylatency NOT echoed (guard)'
                    )
                }
            }

            // -----------------------------------------------------------------
            // mute_v2: the caller's first mute-state update is what real
            // clients wait for before sending <accept> (whatsmeow never
            // surfaces it — intercepting the raw node is the only way).
            // -----------------------------------------------------------------
            if (actionTag === 'mute_v2' && callId && pendingAccepts.has(callId)) {
                logger.info({ callId, from, state: infoChild.attrs?.['mute-state'] }, '[MOD] caller mute_v2 — releasing deferred accept')
                await flushPendingAccept(callId)
            }

            // -----------------------------------------------------------------
            // enc_rekey: group media epoch. DecryptDM → Message.call.callKey.
            // -----------------------------------------------------------------
            if (actionTag === 'enc_rekey' && callId) {
                try {
                    const tx = +(infoChild.attrs['transaction-id'] || 0)
                    const encNode = getBinaryNodeChild(infoChild, 'enc')
                    if (encNode?.content?.length) {
                        const e2eType = encNode.attrs.type // 'pkmsg' | 'msg'
                        const candidates = await callKeyDecryptCandidates(node, from)
                        let epoch = null
                        for (const jid of candidates) {
                            try {
                                const plaintext = await signalRepository.decryptMessage({
                                    jid, type: e2eType, ciphertext: encNode.content
                                })
                                let msg
                                try { msg = proto.Message.decode(unpadRandomMax16(plaintext)) }
                                catch { msg = proto.Message.decode(plaintext) }
                                const ck = msg?.call?.callKey
                                if (ck?.length) { epoch = Buffer.from(ck); break }
                            } catch (e) {
                                logger.trace({ jid, err: e?.message }, '[MOD] enc_rekey decrypt attempt failed')
                            }
                        }
                        if (epoch?.length === 32) {
                            const prev = groupEpochs.get(callId)
                            if (!prev || tx >= prev.tx) {
                                groupEpochs.set(callId, { rawKey: epoch, tx })
                                const live = callMediaSessions.get(callId)
                                if (live && !live.closed) live.installEpoch(epoch)
                                logger.info({ callId, tx }, '[MOD] group media epoch installed (32B)')
                            } else {
                                logger.debug({ callId, tx, have: prev.tx }, '[MOD] stale enc_rekey ignored')
                            }
                        } else {
                            logger.warn({ callId, len: epoch?.length }, '[MOD] enc_rekey: no 32B callKey after decrypt')
                        }
                    }
                } catch (e) {
                    logger.warn({ err: e?.message }, '[MOD] enc_rekey handling failed')
                }
            }

            // -----------------------------------------------------------------
            // group_update: refresh the roster PIDs (relay subscriptions).
            // -----------------------------------------------------------------
            if (actionTag === 'group_update' && callId) {
                try {
                    const roster = parseGroupRoster(infoChild)
                    if (roster) {
                        groupRosters.set(callId, roster)
                        const live = callMediaSessions.get(callId)
                        if (live && !live.closed && roster.pids.length) live.setGroupPids(roster.pids)
                        logger.info({ callId, participants: roster.participants.length, pids: roster.pids.length, rekey: roster.rekey, tx: roster.transactionId }, '[MOD] group roster updated')

                        // -----------------------------------------------------
                        // [MOD] rekey fan-out: a group_update carrying
                        // rekey="1" designates US to mint the next media
                        // epoch — generate a fresh 32-byte raw key, install
                        // it locally, and deliver it enc_rekey to every
                        // connected remote device (meowcaller
                        // distributeRequestedGroupEpoch). Without this the
                        // joiner never gets a key and media never comes up.
                        // -----------------------------------------------------
                        if (roster.rekey && roster.transactionId) {
                            const prev = groupEpochs.get(callId)
                            if (prev && prev.tx >= roster.transactionId) {
                                logger.debug({ callId, have: prev.tx }, '[MOD] rekey request stale — ignoring')
                            } else {
                                const rawKey = randomBytes(32)
                                const meUserLid = jidDecode(authState.creds.me?.lid || authState.creds.me?.id)?.user
                                const meUserPn = jidDecode(authState.creds.me?.id)?.user
                                const recipients = []
                                for (const p of roster.participants) {
                                    if (p.state !== 'connected') continue
                                    for (const d of p.devices) {
                                        if (d.pid === undefined || !d.jid) continue
                                        const du = jidDecode(d.jid)?.user
                                        if (du === meUserLid || du === meUserPn) continue
                                        if (!recipients.includes(d.jid)) recipients.push(d.jid)
                                    }
                                }
                                const creatorJid = roster.creator || creator
                                let sent = 0
                                let mintedNodes = []
                                let mintDi = false
                                if (recipients.length) {
                                    try {
                                        await assertSessions(recipients, true)
                                        const { nodes, shouldIncludeDeviceIdentity } = await createParticipantNodes(recipients, {
                                            call: { callKey: new Uint8Array(rawKey) },
                                        }, { count: '0' })
                                        mintedNodes = nodes || []
                                        mintDi = !!shouldIncludeDeviceIdentity
                                        const encTypes = mintedNodes.map((n) => n?.content?.find?.((c) => c?.tag === 'enc')?.attrs?.type).filter(Boolean)
                                        logger.info({ callId, recipients, encTypes, deviceIdentity: mintDi }, '[MOD] enc_rekey ciphertext types')
                                        for (const dest of nodes) {
                                            const toJid = dest.attrs?.jid
                                            const encNode = dest.content?.find?.((c) => c?.tag === 'enc')
                                            if (!toJid || !encNode) continue
                                            const rekeyChildren = [
                                                { tag: 'encopt', attrs: { keygen: '2' }, content: undefined },
                                                { tag: 'enc', attrs: { v: '2', type: encNode.attrs?.type, count: '0' }, content: encNode.content },
                                            ]
                                            // [MOD] rust: "pre-key group epoch requires device
                                            // identity" — a pkmsg enc_rekey without our signed
                                            // device identity is rejected by real clients, so
                                            // mirror messages-send.js and attach it whenever
                                            // createParticipantNodes says the ciphertext is a
                                            // prekey message.
                                            if (mintDi) {
                                                rekeyChildren.push({
                                                    tag: 'device-identity',
                                                    attrs: {},
                                                    content: encodeSignedDeviceIdentity(authState.creds.account, true),
                                                })
                                            }
                                            await sendNode({
                                                tag: 'call',
                                                attrs: { to: toJid, id: generateMessageID() },
                                                content: [{
                                                    tag: 'enc_rekey',
                                                    attrs: {
                                                        'call-id': callId,
                                                        'call-creator': creatorJid,
                                                        'transaction-id': String(roster.transactionId),
                                                    },
                                                    content: rekeyChildren,
                                                }],
                                            })
                                            sent++
                                        }
                                    } catch (e) {
                                        logger.warn({ err: e?.message }, '[MOD] rekey fan-out send failed')
                                    }
                                }
                                groupEpochs.set(callId, { rawKey, tx: roster.transactionId })
                                logger.info({ callId, tx: roster.transactionId, recipients: recipients.length, sent }, '[MOD] group epoch minted + fan-out done')

                                // -------------------------------------------------
                                // [MOD] enc_rekey re-send: a healthy creator answers
                                // our mint with its own rekey within ~4-5s. When
                                // none arrives (flapping creator client), the first
                                // enc_rekey may have been lost while their device
                                // was reconnecting — re-send the SAME epoch a few
                                // times so their client gets a chance to install
                                // it. Idempotent: same tx, same key.
                                // -------------------------------------------------
                                const resendNodes = mintedNodes
                                let attempts = 0
                                const resendTimer = setInterval(async () => {
                                    attempts++
                                    const cur = groupEpochs.get(callId)
                                    if (!cur || cur.tx !== roster.transactionId || attempts > 3) {
                                        clearInterval(resendTimer)
                                        return
                                    }
                                    // stop once a remote rekey superseded ours
                                    if (cur.rawKey.equals(rawKey)) {
                                        let resent = 0
                                        for (const dest of resendNodes) {
                                            const toJid = dest.attrs?.jid
                                            const encNode2 = dest.content?.find?.((c) => c?.tag === 'enc')
                                            if (!toJid || !encNode2) continue
                                            const rekeyChildren2 = [
                                                { tag: 'encopt', attrs: { keygen: '2' }, content: undefined },
                                                { tag: 'enc', attrs: { v: '2', type: encNode2.attrs?.type, count: '0' }, content: encNode2.content },
                                            ]
                                            if (mintDi) {
                                                rekeyChildren2.push({
                                                    tag: 'device-identity',
                                                    attrs: {},
                                                    content: encodeSignedDeviceIdentity(authState.creds.account, true),
                                                })
                                            }
                                            try {
                                                await sendNode({
                                                    tag: 'call',
                                                    attrs: { to: toJid, id: generateMessageID() },
                                                    content: [{
                                                        tag: 'enc_rekey',
                                                        attrs: {
                                                            'call-id': callId,
                                                            'call-creator': creatorJid,
                                                            'transaction-id': String(roster.transactionId),
                                                        },
                                                        content: rekeyChildren2,
                                                    }],
                                                })
                                                resent++
                                            } catch { /* best effort */ }
                                        }
                                        logger.info({ callId, tx: roster.transactionId, attempt: attempts, resent }, '[MOD] enc_rekey re-sent (no creator rekey seen)')
                                    }
                                }, 10000)
                            }
                        }
                    }
                } catch (e) {
                    logger.debug({ err: e?.message }, '[MOD] group_update parse failed')
                }
            }

            if (status === 'offer') {
                call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
                call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid'] || !!getBinaryNodeChild(infoChild, 'group_info')
                call.groupJid = infoChild.attrs['group-jid'] || attrs['group-jid']

                // [MOD] WhatsApp retransmits offer stanzas. This local get/set
                // pair is atomic (no await in between), so exactly ONE copy of
                // the offer is treated as fresh.
                const isRetransmission = !!offerHandledCache.get(call.id)
                if (!isRetransmission) offerHandledCache.set(call.id, true)

                call.offerNode = infoChild
                try {
                    logger.info(
                        { callId: call.id, from: call.from, group: call.isGroup, offerNode: JSON.stringify(infoChild, (_, v) => (v && v.type === 'Buffer') ? `<Buffer ${v.data.length}b>` : v) },
                        '[MOD] raw call offer node captured'
                    )
                } catch { /* logging best-effort */ }

                // recover the media callKey (1:1 only — group keys arrive via
                // enc_rekey). Reuse on retransmission (the Signal ratchet
                // would throw MessageCounterError on a second decrypt).
                const existingOffer = await callOfferCache.get(call.id)
                let callKey = existingOffer?.callKey || null
                if (!callKey && !call.isGroup) {
                    try {
                        callKey = await decryptCallKey(infoChild, call.from)
                    } catch (e) {
                        logger.debug({ err: e?.message }, '[MOD] callKey auto-decrypt failed')
                    }
                }
                if (callKey) {
                    call.callKey = callKey
                    call.callKeyHex = callKey.toString('hex')
                } else if (existingOffer?.callKeyHex) {
                    call.callKeyHex = existingOffer.callKeyHex
                }

                // merge with any previous entry so a duplicate offer can never
                // erase what we already have.
                const mergedCall = { ...(existingOffer || {}) }
                for (const [k, v] of Object.entries(call)) {
                    if (v !== undefined) mergedCall[k] = v
                }
                mergedCall.callKey = call.callKey || existingOffer?.callKey
                mergedCall.callKeyHex = call.callKeyHex || existingOffer?.callKeyHex
                mergedCall.offerNode = call.offerNode || existingOffer?.offerNode
                mergedCall.requestId = attrs.id || existingOffer?.requestId
                mergedCall.incoming = true
                mergedCall.outgoing = false
                // [MOD] peer MLOW profile: the offer's capability blob bit for
                // use_mlow_codec_v1 (index 31) lives in byte 5 (0xbb = on,
                // 0x3b = off — the high bit differs).
                try {
                    const capNode = (infoChild?.content || []).find?.((ch) => ch?.tag === 'capability')
                    const capBuf = capNode?.content
                    if (capBuf && capBuf.length >= 6) {
                        mergedCall.mlowPeer = (capBuf[5] & 0x80) !== 0 && WE_ASK_MLOW
                        logger.info({ callId: call.id, mlowPeer: mergedCall.mlowPeer, capByte5: capBuf[5].toString(16), ourAsk: WE_ASK_MLOW }, '[MOD] offer capability: peer MLOW profile (mutual gate)')
                    }
                } catch { /* best effort */ }
                mergedCall.selfLid = authState.creds.me?.lid || authState.creds.me?.id
                mergedCall.peerLid = mergedCall.peerLid || call.from
                await callOfferCache.set(call.id, mergedCall)

                // -----------------------------------------------------------------
                // group offer: index by group JID + parse the roster
                // (runs BEFORE the relay re-ingest below — every set here must
                // spread the CURRENT cache entry, not the stale mergedCall
                // local, or it wipes fields concurrent handlers stored)
                // -----------------------------------------------------------------
                if (call.isGroup) {
                    const roster = parseGroupRoster(infoChild) || parseGroupRoster(node)
                    if (roster) {
                        groupRosters.set(call.id, roster)
                        const cur = await callOfferCache.get(call.id) || mergedCall
                        await callOfferCache.set(call.id, { ...cur, groupPids: roster.pids })
                    }
                    const gjid = call.groupJid || roster?.groupJid
                    if (gjid) {
                        const cur = await callOfferCache.get(call.id) || mergedCall
                        // [MOD] flapped call: a terminate deletes the offer
                        // entry and the RE-offer carries no <relay> — if this
                        // is the same callId we indexed before, restore its
                        // announcement relay (the web ICE credentials stay
                        // valid for the call).
                        const prevActive = activeGroupCalls.get(gjid)
                        const prevAnn = groupAnnouncementCache.get(gjid)
                        const sameCall = (prevActive && prevActive.callId === call.id) || (prevAnn && prevAnn.callId === call.id)
                        const announceRelay = cur.relay?.key?.length ? cur.relay
                            : (sameCall ? (prevActive?.callId === call.id ? prevActive.relay : prevAnn.relay) : undefined)
                        const savedGroupRelay = cur.groupRelay
                            || (sameCall ? (prevActive?.callId === call.id ? prevActive.groupRelay : undefined) || prevAnn?.groupRelay : undefined)
                        if (!cur.relay?.key?.length && announceRelay) {
                            await callOfferCache.set(call.id, { ...cur, relay: announceRelay, groupRelay: savedGroupRelay })
                            logger.info({ callId: call.id }, '[MOD] re-offer: announcement relay restored from active-call index')
                        }
                        activeGroupCalls.set(gjid, {
                            callId: call.id,
                            groupJid: gjid,
                            callCreator: call.from,
                            chatId: call.chatId,
                            isVideo: call.isVideo,
                            callKey: call.callKey,
                            callKeyHex: call.callKeyHex,
                            offerNode: call.offerNode,
                            relay: announceRelay,
                            groupRelay: savedGroupRelay,
                            requestId: mergedCall.requestId,
                            discoveredAt: Date.now(),
                        })
                        logger.info({ callId: call.id, groupJid: gjid, joinable: infoChild.attrs.joinable }, '[MOD] active group call indexed')
                    }
                }

                // [MOD] the generic relay ingest (earlier in handleCall)
                // DROPS the offer's relay block when no cache entry exists
                // yet — which is always the case for the FIRST offer. For
                // group calls that block is the "announcement" relay (the
                // web client's ICE credential set), so re-ingest it LAST —
                // after every other set in offer processing — so nothing can
                // clobber it with a stale spread. 1:1 calls benefit too
                // (offer-carried relay was previously lost until a
                // retransmission).
                try {
                    const offerRelayNode = findRelayNode(infoChild) || findRelayNode(node)
                    if (offerRelayNode) {
                        const mergedRelay = await ingestRelayData(call.id, offerRelayNode, 'offer')
                        if (mergedRelay?.endpoints?.length) {
                            logger.info(
                                { callId: call.id, endpoints: mergedRelay.endpoints.map((e) => `${e.ip}:${e.port}(${e.relayName || e.relayId})`) },
                                '[MOD] offer relay block (re)ingested after cache entry created'
                            )
                            // the group index above ran BEFORE this re-ingest
                            // and stored relay:undefined — patch every indexed
                            // entry for this call so a later re-offer (which
                            // carries no <relay>) can restore the announcement
                            for (const [gjid, a] of activeGroupCalls) {
                                if (a && a.callId === call.id) {
                                    activeGroupCalls.set(gjid, { ...a, relay: mergedRelay, groupRelay: a.groupRelay })
                                    groupAnnouncementCache.set(gjid, { callId: call.id, relay: mergedRelay })
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.debug({ err: e?.message }, '[MOD] offer relay re-ingest failed')
                }

                // -----------------------------------------------------------------
                // inbound 1:1 offer: send the offer receipt + eager preaccept
                // (real clients send preaccept while ringing; it is what makes
                // the caller start relaylatency probes and let media flow)
                // -----------------------------------------------------------------
                if (!isRetransmission && !call.isGroup) {
                    try {
                        await sendNode({
                            tag: 'receipt',
                            attrs: { to: from, id: attrs.id },
                            content: [{
                                tag: 'offer',
                                attrs: { 'call-id': call.id, 'call-creator': from },
                                content: undefined,
                            }],
                        })
                    } catch (e) {
                        logger.debug({ err: e?.message }, '[MOD] offer receipt failed')
                    }
                    try {
                        await preacceptCall(call.id, from, call.isVideo)
                        logger.info({ callId: call.id }, '[MOD] preaccept sent (ringing)')
                    } catch (e) {
                        logger.debug({ err: e?.message }, '[MOD] eager preaccept failed')
                    }
                }

                if (isRetransmission) {
                    logger.debug(
                        { callId: call.id },
                        '[MOD] duplicate call offer retransmission — cache refreshed, not re-emitting event'
                    )
                    return // the finally-block still acks the stanza
                }
            }

            const existingCall = await callOfferCache.get(call.id)

            // [MOD] outgoing call: sniff the callee's <preaccept> capability
            // for the MLOW bit (index 31) so our outbound frames use the
            // MLOW escape from the very first packet.
            if (status === 'preaccept' && existingCall?.outgoing && call.id) {
                try {
                    const s = callMediaSessions.get(call.id)
                    const capNode = (infoChild?.content || []).find?.((ch) => ch?.tag === 'capability')
                    const capBuf = capNode?.content
                    if (s?.notePeerMlow && capBuf && capBuf.length >= 6) {
                        s.notePeerMlow((capBuf[5] & 0x80) !== 0 && WE_ASK_MLOW)
                        logger.info({ callId: call.id, mlow: (capBuf[5] & 0x80) !== 0 && WE_ASK_MLOW, capByte5: capBuf[5].toString(16), ourAsk: WE_ASK_MLOW }, '[MOD] preaccept: peer MLOW profile (mutual gate)')
                    }
                } catch { /* best effort */ }
            }

            // use existing call info to populate this event
            if (existingCall) {
                call.isVideo = call.isVideo ?? existingCall.isVideo
                call.isGroup = call.isGroup ?? existingCall.isGroup
                call.groupJid = call.groupJid || existingCall.groupJid
                call.callerPn = call.callerPn || existingCall.callerPn
                call.offerNode = call.offerNode || existingCall.offerNode
                call.callKey = call.callKey || existingCall.callKey
                call.callKeyHex = call.callKeyHex || existingCall.callKeyHex
            }

            // -----------------------------------------------------------------
            // [MOD] caller-side post-accept <transport> exchange (wacrg
            // call-transport): after the callee accepts, the caller conveys
            // its relay candidate — <te priority="1"> carrying the 6-byte
            // ip:port endpoint it allocated on — with net medium=2 protocol=0.
            // Without this the callee never learns our relay and the media
            // bridge never forms (call dies ~30s after accept).
            // -----------------------------------------------------------------
            if ((status === 'accept' || actionTag === 'transport') && call.id) {
                try {
                    logger.info(
                        { callId: call.id, action: actionTag, node: binaryNodeToString(node).slice(0, 4000) },
                        '[MOD] raw accept/transport node'
                    )
                } catch { /* best effort */ }
            }
            if (status === 'accept' && existingCall?.outgoing) {
                // parse the accept's <te priority="2">: the callee's chosen
                // relay endpoint (6-byte IPv4:port) — we must join that relay
                const session = callMediaSessions.get(call.id)
                // [MOD] the answering device announces itself as the accept
                // stanza's from-jid (and, when present, in <relay><participant
                // jid>) and encrypts under THAT participant id (rust
                // rekey_recv) — rekey our recv path to it or every inbound
                // frame fails SRTP verification.
                try {
                    const relayChild = getBinaryNodeChild(infoChild, 'relay')
                    const participant = relayChild && getBinaryNodeChild(relayChild, 'participant')
                    const answeringJid = participant?.attrs?.jid || attrs.from
                    if (answeringJid && session?.noteAnsweringParticipant) {
                        session.noteAnsweringParticipant(answeringJid)
                    } else {
                        logger.debug({ callId: call.id, answeringJid: answeringJid || null }, '[MOD] accept carried no answering participant')
                    }
                } catch (e) {
                    logger.warn({ err: String(e) }, '[MOD] answering-participant parse failed')
                }
                // [MOD] peer MLOW profile from the accept: an explicit
                // capability child wins; the A/B metadata bucket (the holdout
                // experiment) implies the peer SUPPORTS it — but the mutual
                // gate still applies: our offer asked standard Opus, so the
                // call runs standard Opus no matter what the peer supports.
                try {
                    const capNode = (infoChild?.content || []).find?.((ch) => ch?.tag === 'capability')
                    const capBuf = capNode?.content
                    const metaNode = (infoChild?.content || []).find?.((ch) => ch?.tag === 'metadata')
                    let mlow = null
                    if (capBuf && capBuf.length >= 6) mlow = (capBuf[5] & 0x80) !== 0 && WE_ASK_MLOW
                    else if (metaNode?.attrs?.peer_abtest_bucket) mlow = WE_ASK_MLOW
                    if (mlow !== null && session?.notePeerMlow) {
                        session.notePeerMlow(mlow)
                        logger.info({ callId: call.id, mlow, ourAsk: WE_ASK_MLOW }, '[MOD] accept: peer MLOW profile (mutual gate)')
                    }
                } catch { /* best effort */ }
                let calleeEp = null
                try {
                    const teChild = getBinaryNodeChild(infoChild, 'te')
                    const teBuf = teChild?.content
                    if (teBuf && (Buffer.isBuffer(teBuf) || teBuf instanceof Uint8Array) && teBuf.length === 6) {
                        calleeEp = {
                            ip: `${teBuf[0]}.${teBuf[1]}.${teBuf[2]}.${teBuf[3]}`,
                            port: Buffer.from(teBuf).readUInt16BE(4),
                        }
                        logger.info({ callId: call.id, calleeRelay: `${calleeEp.ip}:${calleeEp.port}` }, '[MOD] accept <te> — callee relay endpoint')
                    }
                } catch { /* best effort */ }

                let finalEp = null
                const isPrivateIp = (ip) =>
                    /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|f[cd])/i.test(String(ip || ''))
                if (calleeEp && !isPrivateIp(calleeEp.ip) && session?.joinCalleeEndpoint) {
                    try {
                        const r = await session.joinCalleeEndpoint(calleeEp.ip, calleeEp.port)
                        finalEp = r?.joined ? calleeEp : { ip: r?.ip, port: r?.port }
                    } catch (e) {
                        logger.warn({ err: String(e) }, '[MOD] joinCalleeEndpoint failed')
                    }
                } else if (calleeEp && isPrivateIp(calleeEp.ip)) {
                    // the accept's <te> is the callee's LAN candidate (P2P) —
                    // not a relay; stay on our relay and say so immediately
                    logger.info({ callId: call.id, lan: `${calleeEp.ip}:${calleeEp.port}` }, '[MOD] accept <te> is a LAN candidate — staying on our relay')
                }
                const ep = finalEp?.ip && finalEp.port ? finalEp
                    : (session?._allocWinner || session?.endpoint || existingCall.relay?.endpoints?.find((e) => e && !e.isFna))
                if (ep?.ip && ep.port) {
                    const ipParts = String(ep.ip).split('.').map((x) => parseInt(x, 10))
                    if (ipParts.length === 4 && ipParts.every((n) => n >= 0 && n <= 255)) {
                        const teBytes = Buffer.alloc(6)
                        teBytes[0] = ipParts[0]; teBytes[1] = ipParts[1]; teBytes[2] = ipParts[2]; teBytes[3] = ipParts[3]
                        teBytes.writeUInt16BE(ep.port & 0xffff, 4)
                        const creatorJid = existingCall.selfLid || authState.creds.me?.lid || authState.creds.me?.id
                        const to = meBare(attrs.from) || existingCall.peerLid
                        try {
                            await sendNode({
                                tag: 'call',
                                attrs: { to, id: generateMessageID() },
                                content: [{
                                    tag: 'transport',
                                    attrs: {
                                        'call-id': call.id,
                                        'call-creator': creatorJid,
                                        'transport-message-type': '1',
                                    },
                                    content: [
                                        { tag: 'te', attrs: { priority: '1' }, content: teBytes },
                                        { tag: 'net', attrs: { medium: '2', protocol: '0' }, content: undefined },
                                    ],
                                }],
                            })
                            logger.info(
                                { callId: call.id, to, te: `${ep.ip}:${ep.port}`, joinedCallee: !!finalEp },
                                '[MOD] caller transport sent (type 1, relay endpoint)'
                            )
                        } catch (e) {
                            logger.warn({ err: String(e) }, '[MOD] caller transport send failed')
                        }
                    }
                } else {
                    logger.warn({ callId: call.id }, '[MOD] accept received but no relay endpoint known for transport reply')
                }
            }
            // peer ICE candidate (type 3) → keepalive/reply (type 9, net without protocol)
            if (actionTag === 'transport' && infoChild.attrs?.['transport-message-type'] === '3' && call.id) {
                const cached = existingCall || await callOfferCache.get(call.id)
                if (cached) {
                    const creatorJid = cached.outgoing
                        ? (cached.selfLid || authState.creds.me?.lid || authState.creds.me?.id)
                        : (cached.callerPn || creator)
                    try {
                        await sendNode({
                            tag: 'call',
                            attrs: { to: meBare(attrs.from), id: generateMessageID() },
                            content: [{
                                tag: 'transport',
                                attrs: {
                                    'call-id': call.id,
                                    'call-creator': creatorJid,
                                    'transport-message-type': '9',
                                },
                                content: [
                                    { tag: 'net', attrs: { medium: '2' }, content: undefined },
                                ],
                            }],
                        })
                        logger.info({ callId: call.id }, '[MOD] replied to peer ICE candidate with transport type 9')
                    } catch (e) {
                        logger.warn({ err: String(e) }, '[MOD] transport type-9 reply failed')
                    }
                }
            }

            // delete data once call has ended.
            // NOTE: 'accept' is NOT terminal here — it is the peer telling us the
            // call is now live, and connectCall() still needs the cached offer.
            if (status === 'reject' || status === 'timeout' || status === 'terminate') {
                await callOfferCache.del(call.id)
                forgetCallKeyMaterial(call.id) // [MOD] drop memoized media key + offer marker
                // [MOD] tear down any live media transport for this call
                const s = callMediaSessions.get(call.id)
                if (s) s.close()
                pendingAccepts.delete(call.id)
                const t = pendingAcceptTimers.get(call.id)
                if (t) { clearTimeout(t); pendingAcceptTimers.delete(call.id) }
                // [MOD] forget the active group call when it ends
                for (const [gjid, info] of activeGroupCalls) {
                    if (info.callId === call.id) activeGroupCalls.delete(gjid)
                }
            }

        // -----------------------------------------------------------------
            ev.emit('call', [call])
        }
        catch (error) {
            // A throw here used to kill the handler *before* the ack, leaving the
            // server retransmitting the call stanza forever.
            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call')
        }
        finally {
            if (ackTyped) {
                await sendNode(ackTyped).catch(
                    ackErr => logger.error({ ackErr }, 'failed to send typed call-control ack')
                )
            } else {
                await sendMessageAck(node).catch(
                    ackErr => logger.error({ ackErr }, 'failed to ack call node')
                )
            }
        }
    }

    // ---------------------------------------------------------------------
    // [MOD v2] <ack class="call"> handler (registered via ws.on above).
    // ---------------------------------------------------------------------
    const handleCallAck = async (node) => {
        try {
            const attrs = node.attrs || {}
            // server-side rejection of our stanza (e.g. error 439 = bad offer)
            if (attrs.error) {
                const errNode = getBinaryNodeChild(node, 'error')
                const callId = errNode?.attrs?.['call-id'] || ''
                logger.warn({ callId, errorCode: attrs.error }, '[MOD] call stanza rejected by server')
                if (callId) {
                    const s = callMediaSessions.get(callId)
                    if (s) s.close()
                    ev.emit('call', [{
                        id: callId,
                        status: 'terminate',
                        reason: 'server:' + attrs.error,
                        chatId: callId,
                        from: callId,
                        date: new Date(),
                    }])
                }
                return
            }

            // initial group ack: the ack carries a group_update (roster)
            const updateNode = getBinaryNodeChild(node, 'group_update')
            if (updateNode) {
                const callId = updateNode.attrs?.['call-id']
                if (callId) {
                    const roster = parseGroupRoster(updateNode)
                    if (roster) {
                        groupRosters.set(callId, roster)
                        logger.info({ callId, participants: roster.participants.length }, '[MOD] initial group ack roster cached')
                    }
                    const gi = getBinaryNodeChild(updateNode, 'group_info')
                    const gjid = updateNode.attrs?.['group-jid'] || gi?.attrs?.['group-jid']
                    if (gjid) {
                        activeGroupCalls.set(gjid, {
                            callId,
                            groupJid: gjid,
                            callCreator: updateNode.attrs?.['call-creator'],
                            discoveredAt: Date.now(),
                        })
                    }
                }
                return
            }

            // relay allocation for OUR leg (outgoing 1:1 call)
            const relayNode = findRelayNode(node)
            if (!relayNode) return
            const callId = relayNode.attrs?.['call-id']
            if (!callId) return
            logger.info({ callId }, '[MOD] relay allocation arrived in call ack')

            const merged = await ingestRelayData(callId, relayNode, 'ack')
            if (merged?.endpoints?.length) {
                logger.info(
                    { callId, endpoints: merged.endpoints.map((e) => `${e.ip}:${e.port}(${e.relayName || e.relayId}${e.isFna ? ',fna' : ''})`) },
                    '[MOD] caller relay block cached from ack'
                )
            }
        } catch (e) {
            logger.warn({ err: e?.message }, '[MOD] handleCallAck failed')
        }
    }

    /**
     * Parse a <group_info> roster (participants, device pids) from a node.
     * Returns null when no group_info child is present.
     */
    const parseGroupRoster = (node) => {
        const gi = getBinaryNodeChild(node, 'group_info')
            || (node.tag === 'group_info' ? node : null)
        if (!gi) return null
        const roster = {
            groupJid: gi.attrs?.['group-jid'] || undefined,
            media: gi.attrs?.media,
            joinable: gi.attrs?.joinable === '1',
            rekey: gi.attrs?.rekey === '1',
            creator: gi.attrs?.['call-creator'],
            transactionId: +(gi.attrs?.['transaction-id'] || 0),
            participants: [],
            pids: [],
        }
        for (const user of getAllBinaryNodeChildren(gi)) {
            if (user.tag !== 'user') continue
            const participant = {
                jid: user.attrs?.jid,
                state: user.attrs?.state,
                devices: [],
            }
            for (const dev of getAllBinaryNodeChildren(user)) {
                if (dev.tag !== 'device') continue
                const device = {
                    jid: dev.attrs?.jid,
                    platform: dev.attrs?.platform,
                    pid: dev.attrs?.pid !== undefined ? +dev.attrs.pid : undefined,
                }
                participant.devices.push(device)
                if (device.pid !== undefined && !Number.isNaN(device.pid)) {
                    roster.pids.push(device.pid)
                }
            }
            roster.participants.push(participant)
        }
        return roster
    }

    const yieldToEventLoop = () => {
        return new Promise(resolve => setImmediate(resolve))
    }

    const makeOfflineNodeProcessor = () => {
        const nodeProcessorMap = new Map([
            ['message', handleMessage],
            ['call', handleCall],
            ['receipt', handleReceipt],
            ['notification', handleNotification]
        ])

        const nodes = []

        let isProcessing = false

        // Number of nodes to process before yielding to event loop
        const BATCH_SIZE = 10

        const enqueue = (type, node) => {
            nodes.push({ type, node })

            if (isProcessing) {
                return
            }

            isProcessing = true

            const promise = async () => {
                let processedInBatch = 0

                while (nodes.length && ws.isOpen) {
                    const { type, node } = nodes.shift()
                    const nodeProcessor = nodeProcessorMap.get(type)

                    if (!nodeProcessor) {
                        onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
                        continue
                    }

                    await nodeProcessor(node)

                    processedInBatch++

                    // Yield to event loop after processing a batch
                    // This prevents blocking the event loop for too long when there are many offline nodes
                    if (processedInBatch >= BATCH_SIZE) {
                        processedInBatch = 0
                        await yieldToEventLoop()
                    }
                }

                isProcessing = false
            }

            promise().catch(error => onUnexpectedError(error, 'processing offline nodes'))
        }

        return { enqueue }
    }

    const offlineNodeProcessor = makeOfflineNodeProcessor()

    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer()
        await execTask()
        ev.flush()

        function execTask() {
            return exec(node, false).catch(err => onUnexpectedError(err, identifier))
        }
    }
    const processNode = async (type, node, identifier, exec) => {
        const isOffline = !!node.attrs.offline

        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node)
        }

        else {
            await processNodeWithBuffer(node, identifier, exec)
        }
    }

    // recv a message
    ws.on('CB:message', async (node) => {
        await processNode('message', node, 'processing message', handleMessage)
    })

    ws.on('CB:call', async (node) => {
        await processNode('call', node, 'handling call', handleCall)
    })

    ws.on('CB:receipt', async (node) => {
        await processNode('receipt', node, 'handling receipt', handleReceipt)
    })

    ws.on('CB:notification', async (node) => {
        await processNode('notification', node, 'handling notification', handleNotification)
    })

    ws.on('CB:ack,class:message', (node) => {
        // [MOD] upstream references an undefined handleBadAck — guard so
        // incoming message acks don't throw unhandledRejection every time.
        const binaryNode = node
        try {
            const errAttr = binaryNode.attrs.error || ''
            logger.warn({ error: errAttr, id: binaryNode.attrs.id }, 'bad ack (message)')
        } catch { /* ignore */ }
    })

    // [MOD v2] <ack class="call"> — carries OUR relay allocation for outgoing
    // calls (te2 endpoints + key + tokens), the initial group_update for
    // outgoing group calls, or a server-side error (e.g. 439 bad offer).
    ws.on('CB:ack,class:call', (node) => {
        handleCallAck(node).catch(error => onUnexpectedError(error, 'handling call ack'))
    })

    ev.on('call', async ([call]) => {
        if (!call) {
            return;
        }

        // missed call + group call notification message generation
        if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
            const msg = {
                key: {
                    remoteJid: call.chatId,
                    id: call.id,
                    fromMe: false
                },
                messageTimestamp: unixTimestampSeconds(call.date)
            }

            if (call.status === 'timeout') {
                if (call.isGroup) {
                    msg.messageStubType = call.isVideo
                        ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
                        : WAMessageStubType.CALL_MISSED_GROUP_VOICE
                }

                else {
                    msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
                }
            }

            else {
                msg.message = { call: { callKey: Buffer.from(call.id) } };
            }

            const protoMsg = proto.WebMessageInfo.fromObject(msg)

            await upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
        }
    })

    ev.on('connection.update', ({ isOnline }) => {
        if (typeof isOnline !== 'undefined') {
            sendActiveReceipts = isOnline
            logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
        }
    })

    return {
        ...suki,
        sendMessageAck,
        sendRetryRequest,
        offerCall,
        acceptConfig,
        rejectCall,
        acceptCall, // [MOD] signaling-level accept (returns the REAL media key)
        preacceptCall, // [MOD] <preaccept> — sent before accept by real clients
        terminateCall, // [MOD] hang up / end / cancel a call
        decryptCallKey, // [MOD] decrypt the inbound media callKey
        connectCall, // [MOD] connect UDP/ICE transport + stream audio
        getCallMediaSession, // [MOD] access a live media session
        stopCallMedia, // [MOD] tear down a media session
        getCallInfo, // [MOD] get ongoing group call by JID (pytgcalls get_group_call)
        getActiveGroupCalls, // [MOD] list discovered active group calls
        joinGroupCall, // [MOD] join a group voice chat + stream (pytgcalls join_group_call)
        fetchMessageHistory,
        requestPlaceholderResend,
        messageRetryManager
    }
}

module.exports = {
    makeMessagesRecvSocket
}