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

    const offerCall = async (toJid, isVideo = false) => {
        const callId = randomBytes(16).toString('hex').toUpperCase().substring(0, 64)
        const offerContent = []
        offerContent.push({ tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined })
        offerContent.push({ tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined })

        if (isVideo) {
            offerContent.push({
                tag: 'video',
                attrs: { enc: 'vp8', dec: 'vp8', orientation: '0', 'screen_width': '1920', 'screen_height': '1080', 'device_orientation': '0' },
                content: undefined
            })
        }
        offerContent.push({ tag: 'net', attrs: { medium: '3' }, content: undefined })
        offerContent.push({ tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 4, 255, 131, 207, 4]) })
        offerContent.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })

        const encKey = randomBytes(32)
        // NOTE: keep each device's own server (`lid` vs `s.whatsapp.net`).
        // Forcing 's.whatsapp.net' here breaks the signal session lookup for
        // LID-addressed accounts and the callee never receives the media key.
        const devices = (await getUSyncDevices([toJid], true, false))
            .map(({ user, device, server, jid }) => jid || jidEncode(user, server || 's.whatsapp.net', device))
        await assertSessions(devices, true)

        const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(devices, {
            call: {
                callKey: new Uint8Array(encKey)
            }
        }, { count: '0' })
        offerContent.push({ tag: 'destination', attrs: {}, content: destinations })

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
                to: toJid,
            },
            content: [{
                tag: 'offer',
                attrs: {
                    'call-id': callId,
                    'call-creator': authState.creds.me.id,
                },
                content: offerContent,
            }],
        })

        await query(stanza)

        // [MOD] keep the caller-side media key: WE minted it for this offer, so
        // there is no <enc> to decrypt later. connectCall()/getCallInfo() used
        // to fail with "No cached offer"/"Missing media callKey" on outgoing
        // calls because this key was simply thrown away.
        await callOfferCache.set(callId, {
            id: callId,
            from: toJid,
            to: toJid,
            isVideo,
            outgoing: true,
            callKey: encKey,
            callKeyHex: encKey.toString('hex'),
            date: new Date(),
        })

        return {
            id: callId,
            to: toJid,
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
    const decryptCallKey = (offerNode, callFrom) => {
        const callId = offerNode?.attrs?.['call-id']
        if (!callId) return decryptCallKeyOnce(offerNode, callFrom)

        const memo = decryptedCallKeys.get(callId)
        if (memo) {
            logger.trace({ callId }, '[MOD] decryptCallKey: reusing memoized result')
            return memo
        }

        const promise = decryptCallKeyOnce(offerNode, callFrom)
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
    // [MOD] terminateCall - hang up / end a call (was missing in this fork)
    // Mirrors rejectCall but sends a <terminate> node. Use after accept, or
    // to cancel an outgoing offerCall.
    // ---------------------------------------------------------------------
    const terminateCall = async (callId, callFrom, reason) => {
        const attrs = {
            'call-id': callId,
            'call-creator': callFrom,
            count: '0',
        }
        if (reason) {
            attrs.reason = reason
        }
        const stanza = ({
            tag: 'call',
            attrs: {
                from: selfJidFor(callFrom),
                to: callFrom,
            },
            content: [{
                tag: 'terminate',
                attrs,
                content: undefined,
            }],
        })
        await query(stanza)

        // tear down any media transport bound to this call
        try { callMediaSessions.get(callId)?.close() } catch { /* best effort */ }
        await callOfferCache.del(callId)
        forgetCallKeyMaterial(callId)
    }

    // ---------------------------------------------------------------------
    // [MOD] acceptCall - signaling-level accept of an incoming call. Sends an
    // <accept> node and re-distributes a media callKey to the caller's devices
    // over Signal sessions (same mechanism offerCall uses).
    //
    // After accepting, call connectCall(callId, callFrom, audioInput) to open
    // the UDP/ICE media transport and stream audio (see connectCall below and
    // Utils/call-media.js for the transport implementation).
    // ---------------------------------------------------------------------
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

    /** Build the media-description children shared by preaccept / accept. */
    const buildCallMediaContent = (isVideo) => {
        const content = [
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
            { tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined }
        ]
        if (isVideo) {
            content.push({
                tag: 'video',
                attrs: {
                    enc: 'vp8',
                    dec: 'vp8',
                    orientation: '0',
                    screen_width: '1920',
                    screen_height: '1080',
                    device_orientation: '0'
                },
                content: undefined
            })
        }
        content.push({ tag: 'net', attrs: { medium: '3' }, content: undefined })
        content.push({ tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 4, 255, 131, 207, 4]) })
        content.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
        return content
    }

    // ---------------------------------------------------------------------
    // [MOD] preacceptCall - real clients send <preaccept> as soon as the user
    // sees the incoming call, *before* <accept>. It tells the caller "I got the
    // offer and I'm ringing", and it is what makes the caller start sending
    // media candidates. Skipping it is a common reason a scripted accept looks
    // like it succeeds but no audio ever flows.
    // ---------------------------------------------------------------------
    const preacceptCall = async (callId, callFrom, isVideo = false) => {
        const stanza = {
            tag: 'call',
            attrs: {
                from: selfJidFor(callFrom),
                to: callFrom,
                id: generateMessageTag()
            },
            content: [{
                tag: 'preaccept',
                attrs: {
                    'call-id': callId,
                    'call-creator': jidNormalizedUser(callFrom),
                    count: '0'
                },
                content: buildCallMediaContent(isVideo)
            }]
        }
        await sendNode(stanza)
        return { id: callId }
    }

    /**
     * [MOD] acceptCall(callId, callFrom, opts?) - answer an incoming call.
     *
     * IMPORTANT (this is the bug that made `callKey`/`mediakey` come back
     * undefined): a WhatsApp call has exactly ONE media key, and it is minted
     * by the CALLER and shipped to us inside the offer's <enc> node. The callee
     * must NOT generate a key. The previous implementation created a random
     * 32-byte buffer, sent it to the caller's devices and returned it as
     * `callKey` — so the value callers logged was a key nobody uses, and the
     * media layer had no way to decrypt anything.
     *
     * We now return the real, decrypted offer key.
     *
     * opts:
     *   isVideo   - answer as a video call (defaults to the offer's own type)
     *   preaccept - send <preaccept> first (default true, matches real clients)
     */
    const acceptCall = async (callId, callFrom, opts = {}) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated', { statusCode: 401 })
        }
        if (!callId || !callFrom) {
            throw new Boom('acceptCall requires (callId, callFrom)', { statusCode: 400 })
        }

        const cached = await callOfferCache.get(callId)
        const isVideo = typeof opts.isVideo === 'boolean' ? opts.isVideo : !!cached?.isVideo

        // Resolve the real media key: cached from the offer, or decrypt now.
        let callKey = cached?.callKey || null
        if (!callKey && cached?.offerNode) {
            try {
                callKey = await decryptCallKey(cached.offerNode, cached.from || callFrom)
            } catch (e) {
                logger.debug({ err: e?.message }, '[MOD] acceptCall: late callKey decrypt failed')
            }
        }
        if (!callKey) {
            logger.warn(
                { callId },
                '[MOD] acceptCall: no media callKey available (offer not seen or its <enc> could not be decrypted). ' +
                'Signaling accept anyway; media cannot be decrypted without it.'
            )
        }

        if (opts.preaccept !== false) {
            try {
                await preacceptCall(callId, callFrom, isVideo)
            } catch (e) {
                logger.debug({ err: e?.message }, '[MOD] acceptCall: preaccept failed (continuing to accept)')
            }
        }

        const acceptContent = buildCallMediaContent(isVideo)

        const stanza = {
            tag: 'call',
            attrs: {
                from: selfJidFor(callFrom),
                to: callFrom,
                id: generateMessageTag()
            },
            content: [{
                tag: 'accept',
                attrs: {
                    'call-id': callId,
                    'call-creator': jidNormalizedUser(callFrom),
                    count: '0'
                },
                content: acceptContent
            }]
        }

        await sendNode(stanza)

        // keep the offer (and its key) alive for connectCall()
        if (cached) {
            await callOfferCache.set(callId, {
                ...cached,
                callKey: callKey || cached.callKey,
                callKeyHex: callKey ? callKey.toString('hex') : cached.callKeyHex,
                accepted: true
            })
        }

        return {
            id: callId,
            callKey,
            callKeyHex: callKey ? callKey.toString('hex') : null,
            isVideo
        }
    }

    // ---------------------------------------------------------------------
    // [MOD] Call media sessions: connect the UDP/ICE transport and stream
    // audio. WhatsApp negotiates transport candidates in the call offer; when
    // both peers are reachable, media flows directly device-to-device over UDP
    // (host/srflx ICE candidates), else via WA relay candidates.
    //
    //   await sock.acceptCall(callId, callFrom)            // pick up
    //   await sock.connectCall(callId, callFrom, 'in.mp3') // ICE + stream audio
    //
    // The transport (UDP sockets, ICE binding checks, RTP framing, SRTP keyed
    // off the decrypted callKey, FFmpeg->Opus pump) is implemented in
    // Utils/call-media.js. The crypto KDF labels there are the integration
    // point to match WhatsApp's exact media-key derivation.
    // ---------------------------------------------------------------------
    const callMediaSessions = new Map()

    // [MOD] active group voice chats discovered from offers, keyed by group JID.
    const activeGroupCalls = new Map()

    // ---------------------------------------------------------------------
    // [MOD] getCallInfo(groupJid) - pytgcalls/ntgcalls style "get_group_call".
    //
    // Returns metadata about an ongoing group voice chat (callId, creator,
    // media callKey, transport candidates) WITHOUT us having to be the invitee.
    //
    // Discovery works two ways:
    //   1. Passive: any group-call offer we observe is indexed here. If the bot
    //      is in the group, WhatsApp pushes a call <offer_notice>/<offer> when a
    //      voice chat starts, which we cache.
    //   2. Active query: we ask WA's @call endpoint for the current state of the
    //      group call. (Node shape may vary by WA version; the result node is
    //      returned raw under `.raw` for inspection.)
    //
    // Then feed callId + callCreator into joinGroupCall()/connectCall().
    // ---------------------------------------------------------------------
    const getCallInfo = async (groupJid, opts = {}) => {
        // 1) passive cache hit
        const cached = activeGroupCalls.get(groupJid)
        if (cached && !opts.forceQuery) {
            return { ...cached, source: 'cache' }
        }

        // 2) active query to the call server for this group's call state
        try {
            const result = await query({
                tag: 'call',
                attrs: {
                    to: '@call',
                },
                content: [{
                    tag: 'query',
                    attrs: { group_jid: groupJid },
                    content: [{
                        tag: 'group_call',
                        attrs: { jid: groupJid },
                        content: undefined,
                    }],
                }],
            }, opts.timeoutMs)

            // try to pull a call-id / creator out of whatever WA returns
            const findAttr = (node, key) => {
                let found
                const visit = (n) => {
                    if (!n || typeof n !== 'object' || found) return
                    if (n.attrs && n.attrs[key]) { found = n.attrs[key]; return }
                    if (Array.isArray(n.content)) for (const c of n.content) visit(c)
                }
                visit(node)
                return found
            }
            const callId = findAttr(result, 'call-id') || findAttr(result, 'id')
            const callCreator = findAttr(result, 'call-creator') || findAttr(result, 'creator')
            const info = {
                groupJid,
                callId,
                callCreator,
                source: 'query',
                raw: result,
            }
            if (callId) {
                activeGroupCalls.set(groupJid, { ...(cached || {}), ...info, discoveredAt: Date.now() })
            }
            return info
        } catch (e) {
            logger.warn({ err: e?.message, groupJid }, '[MOD] getCallInfo query failed')
            return cached ? { ...cached, source: 'cache-fallback' } : null
        }
    }

    const getActiveGroupCalls = () => Array.from(activeGroupCalls.values())

    // ---------------------------------------------------------------------
    // [MOD] joinGroupCall(groupJid, audioInput?, opts?) - one-shot helper:
    // discover the ongoing group call, accept/join it, and open the media
    // transport to stream audio. This is the pytgcalls `join_group_call`
    // equivalent for building music/stream bots.
    // ---------------------------------------------------------------------
    const joinGroupCall = async (groupJid, audioInput, opts = {}) => {
        const info = await getCallInfo(groupJid, opts)
        if (!info || !info.callId) {
            throw new Boom('No active group call found for ' + groupJid +
                ' (start/observe a voice chat first, or pass an explicit callId)')
        }
        const callFrom = info.callCreator || info.chatId || groupJid

        // make sure we have the offer cached for connectCall to derive keys
        if (!(await callOfferCache.get(info.callId)) && info.offerNode) {
            await callOfferCache.set(info.callId, {
                id: info.callId,
                from: callFrom,
                isGroup: true,
                groupJid,
                offerNode: info.offerNode,
                callKey: info.callKey,
                callKeyHex: info.callKeyHex,
            })
        }

        // signal join (accept), then connect the UDP/ICE media transport
        try { await acceptCall(info.callId, callFrom) } catch (e) {
            logger.debug({ err: e?.message }, '[MOD] joinGroupCall: accept signaling failed (continuing)')
        }
        return connectCall(info.callId, callFrom, audioInput, opts)
    }

    const connectCall = async (callId, callFrom, audioInput, opts = {}) => {
        const cached = await callOfferCache.get(callId)
        if (!cached) {
            throw new Boom('No cached offer for callId; connect during an active offer')
        }
        const offerNode = cached.offerNode
        const callKey = cached.callKey || (offerNode ? await decryptCallKey(offerNode, callFrom) : null)
        if (!callKey) {
            throw new Boom('Missing media callKey; cannot derive media keys')
        }
        const candidates = extractCandidates(offerNode)
        if (!candidates.length) {
            logger.warn('[MOD] connectCall: no transport candidates in offer node')
        }
        const relayToken = extractRelayToken(offerNode)

        // reuse a live session instead of leaking a second UDP socket
        const existing = callMediaSessions.get(callId)
        if (existing && !existing.closed) {
            logger.debug({ callId }, '[MOD] connectCall: reusing live media session')
            return existing
        }

        const session = new WACallMediaSession({ callId, callKey, candidates, relayToken, logger })
        callMediaSessions.set(callId, session)

        let pair
        try {
            pair = await session.connect(opts.iceTimeoutMs || 8000)
        } catch (e) {
            // don't leave a half-open socket behind on ICE failure
            callMediaSessions.delete(callId)
            try { session.close() } catch { /* best effort */ }
            throw e
        }
        // [MOD] audio and/or video streaming with custom qualities.
        //   opts.audioQuality / opts.videoQuality override codec/bitrate/etc.
        //   opts.videoInput streams video (or pass an object input to play both)
        if (audioInput && typeof audioInput === 'object' && (audioInput.video || audioInput.audio)) {
            // input given as { audio, video, audioQuality, videoQuality }
            if (audioInput.audio) session.streamAudio(audioInput.audio, audioInput.audioQuality || opts.audioQuality || {})
            if (audioInput.video) session.streamVideo(audioInput.video, audioInput.videoQuality || opts.videoQuality || {})
        } else if (audioInput) {
            session.streamAudio(audioInput, opts.audioQuality || {})
            if (opts.videoInput) session.streamVideo(opts.videoInput, opts.videoQuality || {})
        }
        ev.emit('call.media', { callId, status: 'connected', pair })
        session.on('closed', () => {
            callMediaSessions.delete(callId)
            ev.emit('call.media', { callId, status: 'closed' })
        })
        return session
    }

    const getCallMediaSession = (callId) => callMediaSessions.get(callId)

    const stopCallMedia = (callId) => {
        const s = callMediaSessions.get(callId)
        if (s) s.close()
    }

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

    const handleCall = async (node) => {
        try {
            const { attrs } = node
            const [infoChild] = getAllBinaryNodeChildren(node)

            // NOTE: this check has to come BEFORE getCallStatusFromNode(), which
            // destructures its argument and would throw on a missing child.
            if (!infoChild) {
                throw new Boom('Missing call info in call node')
            }

            const status = getCallStatusFromNode(infoChild)

            const callId = infoChild.attrs['call-id']
            // Real WA calls: <offer call-creator="..."> is the authoritative caller JID.
            // Outer <call from="..."> is also the caller but may be bare PN or LID.
            // We prefer call-creator (full device JID), then infoChild.from, then outer from.
            const from = infoChild.attrs['call-creator'] || infoChild.attrs.from || attrs.from
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

            if (status === 'offer') {
                call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
                call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
                call.groupJid = infoChild.attrs['group-jid']

                // [MOD] WhatsApp retransmits offer stanzas. This local get/set
                // pair is atomic (no await in between), so exactly ONE copy of
                // the offer is treated as fresh — the rest only refresh the
                // cached offer and get acked, without a second 'call' event.
                const isRetransmission = !!offerHandledCache.get(call.id)
                if (!isRetransmission) offerHandledCache.set(call.id, true)

                // [MOD] RESEARCH: expose the raw offer node so callers can inspect
                // the media (audio/video enc, rate), <capability>, <encopt keygen>
                // and the encrypted <destination>/callKey params. This is where any
                // attempt at building a real audio path must start.
                call.offerNode = infoChild
                try {
                    logger.info(
                        { callId: call.id, from: call.from, offerNode: JSON.stringify(infoChild, (_, v) => (v && v.type === 'Buffer') ? `<Buffer ${v.data.length}b>` : v) },
                        '[MOD] raw call offer node captured'
                    )
                } catch { /* logging best-effort */ }

                // [MOD] recover the media callKey. A retransmitted offer carries
                // the SAME <enc> ciphertext, and the Signal ratchet can consume
                // it exactly once — a second decrypt throws MessageCounterError,
                // and the keyless duplicate used to overwrite the cached key
                // (the bug behind "acceptCall: no media callKey available" and
                // "ICE failed (Missing media callKey)"). So: reuse the key we
                // already recovered for this call-id, decrypt only when we have
                // none, and merge — never clobber — when persisting.
                const existingOffer = await callOfferCache.get(call.id)
                let callKey = existingOffer?.callKey || null
                if (!callKey) {
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

                // merge with any previous entry so a duplicate offer that lacks
                // a field (or the key) can never erase what we already have.
                const mergedCall = { ...(existingOffer || {}) }
                for (const [k, v] of Object.entries(call)) {
                    if (v !== undefined) mergedCall[k] = v
                }
                mergedCall.callKey = call.callKey || existingOffer?.callKey
                mergedCall.callKeyHex = call.callKeyHex || existingOffer?.callKeyHex
                mergedCall.offerNode = call.offerNode || existingOffer?.offerNode
                await callOfferCache.set(call.id, mergedCall)

                if (isRetransmission) {
                    logger.debug(
                        { callId: call.id },
                        '[MOD] duplicate call offer retransmission — cache refreshed, not re-emitting event'
                    )
                    return // the finally-block still acks the stanza, stopping further retransmits
                }

                // [MOD] index active group calls by group JID so getCallInfo(groupJid)
                // can find an ongoing voice chat without us being the invitee.
                if (call.isGroup && call.groupJid) {
                    activeGroupCalls.set(call.groupJid, {
                        callId: call.id,
                        groupJid: call.groupJid,
                        callCreator: call.from,
                        chatId: call.chatId,
                        isVideo: call.isVideo,
                        callKey: call.callKey,
                        callKeyHex: call.callKeyHex,
                        offerNode: call.offerNode,
                        discoveredAt: Date.now(),
                    })
                }
            }

            const existingCall = await callOfferCache.get(call.id)

            // use existing call info to populate this event
            if (existingCall) {
                call.isVideo = call.isVideo ?? existingCall.isVideo
                call.isGroup = call.isGroup ?? existingCall.isGroup
                call.groupJid = call.groupJid || existingCall.groupJid
                call.callerPn = call.callerPn || existingCall.callerPn
                // [MOD] carry the media key onto follow-up events (ringing/accept/
                // preaccept/transport). Without this, only the very first 'offer'
                // event carried callKey and every later event reported undefined.
                call.offerNode = call.offerNode || existingCall.offerNode
                call.callKey = call.callKey || existingCall.callKey
                call.callKeyHex = call.callKeyHex || existingCall.callKeyHex
            }

            // delete data once call has ended.
            // NOTE: 'accept' is NOT terminal here — it is the peer telling us the
            // call is now live, and connectCall() still needs the cached offer (and
            // its media key). Dropping it on accept is why connectCall() used to
            // fail with "No cached offer for callId" right after a call connected.
            if (status === 'reject' || status === 'timeout' || status === 'terminate') {
                await callOfferCache.del(call.id)
                forgetCallKeyMaterial(call.id) // [MOD] drop memoized media key + offer marker
                // [MOD] tear down any live media transport for this call
                const s = callMediaSessions.get(call.id)
                if (s) s.close()
                // [MOD] forget the active group call when it ends
                for (const [gjid, info] of activeGroupCalls) {
                    if (info.callId === call.id) activeGroupCalls.delete(gjid)
                }
            }

            ev.emit('call', [call])
        }
        catch (error) {
            // A throw here used to kill the handler *before* the ack, leaving the
            // server retransmitting the call stanza forever.
            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call')
        }
        finally {
            await sendMessageAck(node).catch(
                ackErr => logger.error({ ackErr }, 'failed to ack call node')
            )
        }
    }

    const handleBadAck = async ({ attrs }) => {
        const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id }

        // WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
        // // current hypothesis is that if pash is sent in the ack
        // // it means -- the message hasn't reached all devices yet
        // // we'll retry sending the message here
        // if(attrs.phash) {
        // 	logger.info({ attrs }, 'received phash in ack, resending message...')
        // 	const msg = await getMessage(key)
        // 	if(msg) {
        // 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
        // 	} else {
        // 		logger.warn({ attrs }, 'could not send message again, as it was not found')
        // 	}
        // }
        // error in acknowledgement,
        // device could not display the message
        if (attrs.error) {
            logger.warn({ attrs }, 'received error in ack')
            ev.emit('messages.update', [
                {
                    key,
                    update: {
                        status: WAMessageStatus.ERROR,
                        messageStubParameters: [attrs.error]
                    }
                }
            ])

            // resend the message with device_fanout=false, use at your own risk
            // if (attrs.error === '475') {
            // 	const msg = await getMessage(key)
            // 	if (msg) {
            // 		await relayMessage(key.remoteJid!, msg, {
            // 			messageId: key.id!,
            // 			useUserDevicesCache: false,
            // 			additionalAttributes: {
            // 				device_fanout: 'false'
            // 			}
            // 		})
            // 	}
            // }
        }
    }

    /// processes a node with the given function
    /// and adds the task to the existing buffer if we're buffering events
    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer()
        await execTask()
        ev.flush()

        function execTask() {
            return exec(node, false).catch(err => onUnexpectedError(err, identifier))
        }
    }

    /** Yields control to the event loop to prevent blocking */
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
        handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'))
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