#!/usr/bin/env python3
"""
Re-apply "pass 2" type fixes: every correction found by diffing the
declarations against ACTUAL runtime behaviour of this repo's lib/.
Idempotent - safe to run repeatedly.
"""
import re, sys

P = '/home/user/baileys-mod/types.d.ts'
src = open(P).read()
applied, skipped = [], []

def rep(old, new, label):
    global src
    if new in src:
        skipped.append(label); return
    if old not in src:
        skipped.append(label + '  (ANCHOR MISSING)'); return
    src = src.replace(old, new, 1); applied.append(label)

# ---------------------------------------------------------------- 1. constants
rep("""export const NACK_REASONS: {
    SenderReachoutTimelocked: number;
    ParsingError: number;""",
    """export const NACK_REASONS: {
    ParsingError: number;""",
    "NACK_REASONS: drop SenderReachoutTimelocked")

rep("""export const WA_CERT_DETAILS: {
    SERIAL: number;
    ISSUER: string;
    PUBLIC_KEY: Buffer;
};""",
    """export const WA_CERT_DETAILS: {
    SERIAL: number;
};""",
    "WA_CERT_DETAILS: only SERIAL exists")

rep("""    sticker: string;
    video: string;
    'thumbnail-document': string;""",
    """    sticker: string;
    video: string;
    'sticker-pack': string;
    'thumbnail-document': string;""",
    "MEDIA_HKDF_KEY_MAPPING: add 'sticker-pack'")

# ---------------------------------------------------------------- 2. MessageRetryManager
m = re.search(r'^export class MessageRetryManager \{', src, re.M)
if m and 'parseRetryErrorCode' in src:
    i = src.index('{', m.start()); d = 0; j = i
    while True:
        if src[j] == '{': d += 1
        elif src[j] == '}':
            d -= 1
            if d == 0: break
        j += 1
    new_cls = '''export class MessageRetryManager {
    private logger
    private recentMessagesMap
    private messageKeyIndex
    private sessionRecreateHistory
    private retryCounters
    private pendingPhoneRequests
    private readonly maxMsgRetryCount
    private statistics
    constructor(logger: ILogger, maxMsgRetryCount: number)
    /** Add a recent message to the cache for retry handling */
    addRecentMessage(to: string, id: string, message: WAMessageContent): void
    /** Get a recent message from the cache */
    getRecentMessage(to: string, id: string): RecentMessage | undefined
    /** Decide whether the Signal session with `jid` should be recreated */
    shouldRecreateSession(
        jid: string,
        retryCount: number,
        hasSession: boolean
    ): { reason: string; recreate: boolean }
    incrementRetryCount(messageId: string): number
    getRetryCount(messageId: string): number
    hasExceededMaxRetries(messageId: string): boolean
    markRetrySuccess(messageId: string): void
    markRetryFailed(messageId: string): void
    schedulePhoneRequest(messageId: string, callback: () => void): void
    cancelPendingPhoneRequest(messageId: string): void
    private keyToString
    private removeRecentMessage
}'''
    src = src[:m.start()] + new_cls + src[j+1:]
    applied.append("MessageRetryManager: drop 7 non-existent members, fix shouldRecreateSession")
else:
    skipped.append("MessageRetryManager")

# ---------------------------------------------------------------- 3. RetryReason enum -> type
m = re.search(r'^export enum RetryReason \{', src, re.M)
if m:
    i = src.index('{', m.start()); d = 0; j = i
    while True:
        if src[j] == '{': d += 1
        elif src[j] == '}':
            d -= 1
            if d == 0: break
        j += 1
    src = src[:m.start()] + '''/**
 * Retry reason codes sent by WhatsApp in retry receipts.
 * NOTE: this build does NOT export a `RetryReason` value at runtime,
 * so this is a type-only union (use the numeric literals directly).
 */
export type RetryReason =
    | 0  /* UnknownError */
    | 1  /* SignalErrorNoSession */
    | 2  /* SignalErrorInvalidKey */
    | 3  /* SignalErrorInvalidKeyId */
    | 4  /* SignalErrorInvalidMessage - MAC verification failed */
    | 5  /* SignalErrorInvalidSignature */
    | 6  /* SignalErrorFutureMessage */
    | 7  /* SignalErrorBadMac */
    | 8  /* SignalErrorInvalidSession */
    | 9  /* SignalErrorInvalidMsgKey */
    | 10 /* BadBroadcastEphemeralSetting */
    | 11 /* UnknownCompanionNoPrekey */
    | 12 /* AdvFailure */
    | 13 /* StatusRevokeDelay */''' + src[j+1:]
    applied.append("RetryReason: enum(value) -> type-only union (ghost at runtime)")
else:
    skipped.append("RetryReason")

# ---------------------------------------------------------------- 4. socket method signatures
for old, new, label in [
 ("    logout(): Promise<void>", "    logout(msg?: string): Promise<void>", "logout(msg)"),
 ("    end(): void", "    end(error?: Error | undefined): void", "end(error)"),
 ("    requestPairingCode(phoneNumber: string): Promise<string>",
  "    requestPairingCode(phoneNumber: string, code?: string): Promise<string>", "requestPairingCode(phone,code)"),
 ("""    waitForConnectionUpdate(
        predicate: (update: Partial<ConnectionState>) => boolean | undefined
    ): Promise<Partial<ConnectionState>>""",
  """    waitForConnectionUpdate: (
        check: (update: Partial<ConnectionState>) => boolean | undefined,
        timeoutMs?: number
    ) => Promise<void>""", "waitForConnectionUpdate(check,timeoutMs)"),
 ("    sendWAMBuffer(): void", "    sendWAMBuffer(wamBuffer: Buffer): Promise<BinaryNode>", "sendWAMBuffer(buf)"),
 ("    addOrEditContact(contact: Partial<WAContact> & { id: string }): Promise<void>",
  "    addOrEditContact(jid: string, contact: Partial<WAContact>): Promise<void>", "addOrEditContact(jid,contact)"),
 ("    createCallLink(): Promise<string>",
  "    createCallLink(\n        type: 'audio' | 'video',\n        event?: { startTime?: number; [k: string]: any },\n        timeoutMs?: number\n    ): Promise<string>", "createCallLink(type,event,timeoutMs)"),
 ("    presenceSubscribe(jid: string): Promise<void>",
  "    presenceSubscribe(toJid: string, tcToken?: Buffer): Promise<void>", "presenceSubscribe(jid,tcToken)"),
 ("    cleanDirtyBits(): Promise<void>",
  "    cleanDirtyBits(type: 'account_sync' | 'groups', fromTimestamp?: number | string): Promise<void>", "cleanDirtyBits(type,ts)"),
 ("    addLabel(label: any): Promise<void>",
  "    addLabel(jid: string, labels: LabelActionBody): Promise<void>", "addLabel(jid,labels)"),
 ("    sendReceipts(receipts: any[]): Promise<void>",
  "    sendReceipts(keys: WAMessageKey[], type: MessageReceiptType): Promise<void>", "sendReceipts(keys,type)"),
 ("""    createParticipantNodes(
        jids: string[],
        message: WAProto['Message'],
        extraAttrs: BinaryNodeAttributes
    ): Promise<{ nodes: BinaryNode[]; shouldIncludeDeviceIdentity: boolean }>""",
  """    createParticipantNodes(
        recipientJids: string[],
        message: WAMessageContent,
        extraAttrs?: BinaryNodeAttributes,
        dsmMessage?: WAMessageContent
    ): Promise<{ nodes: BinaryNode[]; shouldIncludeDeviceIdentity: boolean }>""", "createParticipantNodes(+dsmMessage)"),
]:
    rep(old, new, label)

# ---------------------------------------------------------------- 5. MessageReceiptType
if 'export type MessageReceiptType' not in src:
    marker = "/* --- precise supporting types (shape-matched to whiskeysockets/baileys) --- */\n"
    if marker in src:
        src = src.replace(marker, marker + """
export type MessageReceiptType =
    | 'read'
    | 'read-self'
    | 'hist_sync'
    | 'peer_msg'
    | 'sender'
    | 'inactive'
    | 'played'
    | undefined
""" + "\n", 1)
        applied.append("add MessageReceiptType")
    else:
        skipped.append("MessageReceiptType (no marker)")
else:
    skipped.append("MessageReceiptType")

# ---------------------------------------------------------------- 6. AuthenticationCreds
m = re.search(r'^export interface AuthenticationCreds \{', src, re.M)
if m and 'advSecretKey' not in src.split('export interface AuthenticationCreds {')[1][:1200]:
    i = src.index('{', m.start()); d = 0; j = i
    while True:
        if src[j] == '{': d += 1
        elif src[j] == '}':
            d -= 1
            if d == 0: break
        j += 1
    src = src[:m.start()] + '''export interface AuthenticationCreds {
    /* --- always present (set by initAuthCreds) --- */
    readonly noiseKey: KeyPair
    readonly pairingEphemeralKeyPair: KeyPair
    readonly signedIdentityKey: KeyPair
    readonly signedPreKey: SignedKeyPair
    readonly registrationId: number
    readonly advSecretKey: string
    processedHistoryMessages: MinimalMessage[]
    nextPreKeyId: number
    firstUnuploadedPreKeyId: number
    accountSyncCounter: number
    accountSettings: AccountSettings
    registered: boolean

    /* --- populated after pairing / during runtime --- */
    pairingCode?: string
    lastPropHash?: string
    routingInfo?: Buffer
    additionalData?: { [k: string]: any }
    me?: Contact
    account?: proto.IADVSignedDeviceIdentity
    signalIdentities?: SignalIdentity[]
    myAppStateKeyId?: string
    lastAccountSyncTimestamp?: number
    platform?: string
    deviceId?: string
    phoneId?: string
    identityId?: Buffer
    backupToken?: Buffer
    registration?: { [k: string]: any }

    [k: string]: any
}''' + src[j+1:]
    applied.append("AuthenticationCreds: real 12 fields, drop 9 ghosts")
else:
    skipped.append("AuthenticationCreds")

# ---------------------------------------------------------------- 7. ConnectionState / WAContact / WAChat
rep("""    qr?: string
    isNewLogin?: boolean
    isReconnecting?: boolean""",
    """    qr?: string
    isNewLogin?: boolean
    /** emitted from presence updates for your own account */
    isOnline?: boolean
    /** true once the server has flushed all offline notifications */
    receivedPendingNotifications?: boolean
    isReconnecting?: boolean""",
    "ConnectionState: +isOnline,+receivedPendingNotifications")

rep("""export type WAContact = {
    id: string
    name?: string
    notify?: string""",
    """export type WAContact = {
    id: string
    /** LID form of this contact's jid, when known */
    lid?: string
    /** phone-number form of this contact's jid, when known */
    phoneNumber?: string
    name?: string
    username?: string
    notify?: string""",
    "WAContact: +lid,+phoneNumber,+username")

rep("""    pinned?: boolean
    mute?: number | null
    archived?: boolean""",
    """    pinned?: number | boolean
    mute?: number | null
    /** epoch ms when a mute expires (emitted by app-state mute sync) */
    muteEndTime?: number | null
    archived?: boolean
    /** set by history sync: the most recent messages of this chat */
    messages?: { message: WAMessage }[]
    /** timestamp of the last received message */
    lastMessageRecvTimestamp?: number
    endOfHistoryTransfer?: boolean
    endOfHistoryTransferType?: number
    ephemeralExpiration?: number
    ephemeralSettingTimestamp?: number""",
    "WAChat: +muteEndTime,+messages,+lastMessageRecvTimestamp,...")

# ---------------------------------------------------------------- 8. event payloads
rep("""    'messaging-history.set': {
        chats: Chat[]
        contacts: Contact[]
        messages: WAMessage[]
        isLatest: boolean
        progress: number
        syncType?: any
    }""",
    """    'messaging-history.set': {
        chats: Chat[]
        contacts: Contact[]
        messages: WAMessage[]
        /** undefined for ON_DEMAND history syncs */
        isLatest?: boolean
        progress?: number | null
        syncType?: number
        peerDataRequestSessionId?: string | null
    }""",
    "messaging-history.set payload")

rep("    'groups.update': GroupMetadata[]", "    'groups.update': Partial<GroupMetadata>[]", "groups.update -> Partial")

# ---------------------------------------------------------------- 9. MOD utility signatures
for pat, new, label in [
 (r'^export function md5\(buffer: any\): any;?$',
  "export function md5(buffer: Buffer): Buffer", "md5"),
 (r'^export function hkdf\(buffer: any, expandedLength: any, info: any\): any;?$',
  "export function hkdf(\n    buffer: Uint8Array | Buffer,\n    expandedLength: number,\n    info: { salt?: Buffer; info?: string }\n): Promise<Buffer>", "hkdf"),
 (r'^export function callKdf\(callKey: any, label: any, len: any\): any;?$',
  "export function callKdf(callKey: Buffer, label: string, len?: number): Buffer", "callKdf"),
 (r'^export function getMediaRetryKey\(mediaKey: any\): any;?$',
  "export function getMediaRetryKey(mediaKey: Uint8Array | Buffer): Promise<Buffer>", "getMediaRetryKey"),
 (r'^export function parseStun\(buf: any\): any;?$',
  "export function parseStun(buf: Buffer): { isStun: boolean; [k: string]: any }", "parseStun"),
 (r'^export function extractCandidates\(offerNode: any\): any;?$',
  "export function extractCandidates(offerNode: BinaryNode): CallCandidate[]", "extractCandidates"),
 (r'^export function resolveVideoPreset\(name: any\): any;?$',
  "export function resolveVideoPreset(name: string): { width: number; height: number }", "resolveVideoPreset"),
 (r'^export function toUnicodeEscape\(text: any\): any;?$',
  "export function toUnicodeEscape(text: string): string", "toUnicodeEscape"),
 (r'^export function fromUnicodeEscape\(escapedText: any\): any;?$',
  "export function fromUnicodeEscape(escapedText: string): string", "fromUnicodeEscape"),
 (r'^export function asciiEncode\(text: any\): any;?$',
  "export function asciiEncode(text: string): number[]", "asciiEncode"),
 (r'^export function asciiDecode\(codes: any\): any;?$',
  "export function asciiDecode(...codes: number[]): string", "asciiDecode (VARIADIC)"),
 (r'^export function buildBinding\(username: any, integrityKey: any\): any;?$',
  "export function buildBinding(opts?: {\n    username?: string\n    integrityKey?: Uint8Array | Buffer\n}): { packet: Buffer; txId: Buffer }", "buildBinding (destructured, returns {packet,txId})"),
 (r'^export function mutationKeys\(keydata: any\): any;?$',
  "export function mutationKeys(keydata: Uint8Array | Buffer): Promise<{\n    indexKey: Buffer\n    valueEncryptionKey: Buffer\n    valueMacKey: Buffer\n    snapshotMacKey: Buffer\n    patchMacKey: Buffer\n}>", "mutationKeys"),
 (r'^export function waChatKey\(pin: any\): any;?$',
  "export function waChatKey(pin: boolean): {\n    key: (c: Chat) => string\n    compare: (k1: string, k2: string) => number\n}", "waChatKey"),
 (r'^export function waMessageID\(m: any\): any;?$',
  "export function waMessageID(m: WAMessage): string", "waMessageID"),
]:
    if re.search(pat, src, re.M):
        src = re.sub(pat, lambda _m: new, src, count=1, flags=re.M); applied.append(label)
    else:
        skipped.append(label)

rep("export const WAJIDDomains: { [key: string]: any }",
    "export const WAJIDDomains: {\n    WHATSAPP: 0\n    LID: 1\n    HOSTED: 128\n    HOSTED_LID: 129\n}", "WAJIDDomains")
rep("export const MEDIA_RETRY_STATUS_MAP: { [key: string]: any }",
    "export const MEDIA_RETRY_STATUS_MAP: { [status: number]: number }", "MEDIA_RETRY_STATUS_MAP")
rep("export const MexUpdatesOperations: { [key: string]: any }",
    "export const MexUpdatesOperations: {\n    OWNER_COMMUNITY: string\n    GROUP_MEMBER_LINK: string\n    GROUP_LIMIT_SHARING: string\n}", "MexUpdatesOperations")
rep("export const XWAPathsMexUpdates: { [key: string]: any }",
    "export const XWAPathsMexUpdates: {\n    GROUP_SHARING_CHANGE: string\n    COMMUNITY_OWNER_CHANGE: string\n}", "XWAPathsMexUpdates")

rep('export const getDevice: (id: string) => "web" | "unknown" | "android" | "ios" | "desktop";',
    "/** Infer the sending device from a message ID. Falls back to 'baileys'. */\nexport const getDevice: (id: string) => 'ios' | 'web' | 'android' | 'desktop' | 'baileys'",
    "getDevice union (fallback is 'baileys')")

# ---------------------------------------------------------------- 10. hygiene
src = src.replace('Uint8Array<ArrayBuffer>', 'Uint8Array').replace('Buffer<ArrayBuffer>', 'Buffer').replace('Buffer<ArrayBufferLike>', 'Buffer')

# duplicate index signature in WAProto
rep("""export interface WAProto {
    [key: string]: any
    WebMessageInfo: {""",
    """export interface WAProto {
    WebMessageInfo: {""",
    "WAProto duplicate index signature")

# duplicate messageRetryManager
if src.count("    messageRetryManager: any") > 1:
    first = src.index("    messageRetryManager: any")
    second = src.index("    messageRetryManager: any", first + 1)
    src = src[:second] + src[second:].replace("    messageRetryManager: any\n", "", 1)
    applied.append("remove duplicate messageRetryManager")
src = src.replace("    messageRetryManager: any", "    messageRetryManager?: MessageRetryManager", 1)

open(P, 'w').write(src)
print("APPLIED (%d):" % len(applied))
for a in applied: print("   + " + a)
print("\nSKIPPED/ALREADY-PRESENT (%d):" % len(skipped))
for s in skipped: print("   . " + s)
