/** Emulation 3: utilities whose types were verified by EXECUTING them. */
import {
    md5, hkdf, callKdf, getMediaRetryKey, parseStun, extractCandidates,
    resolveVideoPreset, toUnicodeEscape, fromUnicodeEscape, asciiEncode,
    asciiDecode, buildBinding, mutationKeys, waChatKey, waMessageID,
    WAJIDDomains, MEDIA_RETRY_STATUS_MAP, MexUpdatesOperations,
    XWAPathsMexUpdates, NACK_REASONS, WA_CERT_DETAILS, MEDIA_HKDF_KEY_MAPPING,
    getDevice, jidDecode, getContentType, initAuthCreds, BufferJSON, Curve,
    processHistoryMessage, chatModificationToAppPatch, makeEventBuffer,
    encodeBinaryNode, aggregateMessageKeysNotFromMe,
    type BinaryNode, type CallCandidate, type Chat, type WAMessage,
    type MessageReceiptType, type RetryReason, type AuthenticationCreds,
    type FullJid, type ILogger, type WAPatchCreate, type BaileysEventMap
} from '@alexainc/baileys-mod'

async function run(node: BinaryNode, chat: Chat, msg: WAMessage, logger: ILogger) {
    const digest: Buffer = md5(Buffer.from('x'))
    const derived: Buffer = await hkdf(Buffer.alloc(32), 32, { info: 'Report Token' })
    const ck: Buffer = callKdf(Buffer.alloc(32), 'l')
    const ck2: Buffer = callKdf(Buffer.alloc(32), 'l', 16)
    const mrk: Buffer = await getMediaRetryKey(Buffer.alloc(32))
    console.log(digest.length, derived.length, ck.length, ck2.length, mrk.length)

    const isStun: boolean = parseStun(Buffer.alloc(20)).isStun
    const cands: CallCandidate[] = extractCandidates(node)
    const { width, height } = resolveVideoPreset('720p')
    console.log(isStun, cands.length, width, height)

    const esc: string = toUnicodeEscape('ab')
    const back: string = fromUnicodeEscape(esc)
    const codes: number[] = asciiEncode('ab')
    const decoded: string = asciiDecode(...codes)          // variadic
    console.log(esc, back, codes, decoded)

    const b1 = buildBinding()
    const b2 = buildBinding({ username: 'u', integrityKey: Buffer.alloc(8) })
    const pkt: Buffer = b1.packet
    const txId: Buffer = b2.txId                            // {packet,txId}
    console.log(pkt.length, txId.length)

    const mk = await mutationKeys(Buffer.alloc(32))
    console.log(mk.indexKey.length, mk.snapshotMacKey.length, mk.patchMacKey.length)

    const wck = waChatKey(true)
    console.log(wck.key(chat), wck.compare('a', 'b'), waMessageID(msg))

    const lid: 1 = WAJIDDomains.LID
    const hosted: 128 = WAJIDDomains.HOSTED
    console.log(lid, hosted, MEDIA_RETRY_STATUS_MAP[0], MexUpdatesOperations.OWNER_COMMUNITY,
        XWAPathsMexUpdates.GROUP_SHARING_CHANGE, NACK_REASONS.ParsingError,
        WA_CERT_DETAILS.SERIAL, MEDIA_HKDF_KEY_MAPPING['sticker-pack'])

    // getDevice fallback is 'baileys' (verified at runtime)
    const dev: 'ios' | 'web' | 'android' | 'desktop' | 'baileys' = getDevice('zz')
    const fj: FullJid | undefined = jidDecode('1:3@s.whatsapp.net')
    console.log(dev, fj?.user, fj?.device, fj?.domainType)
    console.log(getContentType(undefined), getContentType({ conversation: 'x' }))

    const creds: AuthenticationCreds = initAuthCreds()
    console.log(creds.noiseKey.public.length, creds.advSecretKey, creds.nextPreKeyId,
        creds.accountSettings.unarchiveChats, creds.registered, creds.signedPreKey.keyId)
    const rt = JSON.parse(JSON.stringify(creds, BufferJSON.replacer), BufferJSON.reviver)
    console.log(!!rt.signedIdentityKey, Curve.generateKeyPair().public.length)

    const hist = processHistoryMessage({} as any)
    console.log(hist.chats.length, hist.contacts.length, hist.messages.length)

    const patch: WAPatchCreate = chatModificationToAppPatch({ archive: true, lastMessages: [msg] }, '1@s.whatsapp.net')
    console.log(patch.type, patch.index, patch.operation)

    const buf = makeEventBuffer(logger)
    buf.buffer()
    buf.process((evts: Partial<BaileysEventMap>) => console.log(Object.keys(evts)))
    console.log(buf.flush(), buf.isBuffering())

    console.log(encodeBinaryNode(node).length, aggregateMessageKeysNotFromMe([msg.key]))
}

const rcpt: MessageReceiptType = 'read'
const reason: RetryReason = 7          // type-only union, not an enum value
export { run, rcpt, reason }
