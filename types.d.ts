/**
 * types.d.ts — Hand-written TypeScript declarations for @alexainc/baileys-mod.
 *
 * This package ships only compiled JavaScript (lib/*.js) with no generated
 * .d.ts files, so TypeScript falls back to `any` and type safety is lost.
 * This file reconstructs the public API by reading the source of THIS repo
 * (it does NOT depend on @whiskeysockets/baileys). It is referenced from
 * package.json via the "types" field.
 *
 * The [MOD] call-streaming API (joinGroupCall / connectCall / getCallInfo /
 * acceptCall / terminateCall / WACallMediaSession, ...) is fully typed here.
 */

/// <reference types="node" />

import type { EventEmitter } from 'events'
import type { Socket as DgramSocket } from 'dgram'
import type { Logger } from 'pino'
import type { WebSocket } from 'ws'

/* ------------------------------------------------------------------ */
/*  Low-level binary node / JID types (lib/WABinary)                   */
/* ------------------------------------------------------------------ */

export type BinaryNodeAttributes = { [key: string]: string }

export interface BinaryNode {
    tag: string
    attrs: BinaryNodeAttributes
    content?: BinaryNode[] | string | Uint8Array | Buffer | null
}

export type Jid = string

/* ------------------------------------------------------------------ */
/*  proto namespace (lib/WAProto)                                      */
/*  Loosely typed: field names are preserved so `proto.X.Y` keeps      */
/*  working, but message content is treated as `any` (the full proto   */
/*  is enormous and not declared here).                                */
/* ------------------------------------------------------------------ */

export interface WAProto {
    [key: string]: any
    WebMessageInfo: {
        Status: any
        StubType: any
        [key: string]: any
    }
    Message: any
    Contact: any
    Chat: any
    GroupChat: any
    SyncAction: any
    AppStateSyncKey: any
    AppStateSyncKeyData: any
    HistorySync: any
    Newsletter: any
    NewsletterMetadata: any
    [key: string]: any
}

export const proto: WAProto
export const WAProto: WAProto

/* ------------------------------------------------------------------ */
/*  Core message / chat / contact types                                */
/* ------------------------------------------------------------------ */

export interface WAMessageKey {
    remoteJid?: string
    fromMe?: boolean
    id?: string
    participant?: string
    /** LID based key */
    idLid?: string
}

/**
 * The content of a message. Key WhatsApp message subtypes are named so
 * common access (`.conversation`, `.extendedTextMessage`, `.imageMessage`,
 * ...) is typed; an index signature keeps everything else permissive.
 */
export interface WAMessageContent {
    conversation?: string
    text?: string
    extendedTextMessage?: { text: string; [k: string]: any }
    imageMessage?: any
    videoMessage?: any
    audioMessage?: any
    documentMessage?: any
    documentWithCaptionMessage?: any
    stickerMessage?: any
    locationMessage?: any
    liveLocationMessage?: any
    contactMessage?: any
    contactsArrayMessage?: any
    listMessage?: any
    buttonsMessage?: any
    reactionMessage?: any
    pollCreationMessage?: any
    pollCreationMessageV2?: any
    pollCreationMessageV3?: any
    protocolMessage?: any
    groupInviteMessage?: any
    interactiveResponseMessage?: any
    interactiveMessage?: any
    eventMessage?: any
    albumMessage?: any
    call?: any
    [k: string]: any
}

export interface WAMessage {
    key: WAMessageKey
    message?: WAMessageContent
    messageTimestamp?: number | Long
    pushName?: string
    status?: number
    broadcast?: boolean
    starred?: boolean
    /** participant for group messages */
    participant?: string
    messageStubType?: number
    messageStubParameters?: string[]
    labels?: string[]
    /** protocol message context (quoted etc.) */
    contextInfo?: any
    /** raw proto object for advanced use */
    proto?: WAProto['WebMessageInfo']
    [k: string]: any
}

export interface WAMessageUpdate {
    key: WAMessageKey
    update: Partial<WAMessage>
}

export interface WAReaction {
    text: string
    senderTimestampMs?: string
}

export type WAContact = {
    id: string
    name?: string
    notify?: string
    verifiedName?: string
    imgUrl?: string
    status?: string
    [k: string]: any
}

export interface WAChat {
    id: string
    conversationTimestamp?: number
    unreadCount?: number
    displayName?: string
    name?: string
    pictureUrl?: string
    pinned?: boolean
    mute?: number | null
    archived?: boolean
    disappearingMessagesInChat?: number | true | undefined
    disappearingMessagesInChatTimestamp?: number
    readOnly?: boolean
    markedAsUnread?: boolean
    [k: string]: any
}

export type Chat = WAChat
export type Contact = WAContact

export interface Participant {
    id: string
    lid?: string
    admin?: 'superadmin' | 'admin' | null
}

export interface GroupMetadata {
    id: string
    owner: string | undefined
    subject: string
    subjectOwner?: string
    subjectTime?: number
    creation?: number
    desc?: string
    descId?: string
    linkedParent?: string
    linkedSubject?: string
    size?: number
    participants: Participant[]
    ephemeralDuration?: number
    addressingMode?: string
    inviteCode?: string
    [k: string]: any
}

export interface CommunityMetadata extends GroupMetadata {
    linkedGroups?: GroupMetadata[]
    isCommunity?: boolean
}

export interface NewsletterMetadata {
    id: string
    owner?: string
    name?: string
    creation_time?: number
    description?: string
    invite?: string
    subscribers?: number
    verification?: any
    picture?: { id?: string; directPath?: string }
    mute_state?: any
    [k: string]: any
}

export type CachedGroupMetadata = (jid: string) => Participant[] | undefined

/* ------------------------------------------------------------------ */
/*  Auth / signal store types (lib/Utils/auth-utils, use-multi-file)   */
/* ------------------------------------------------------------------ */

export type SignalDataTypeMap = {
    'pre-key': { keyId: number; publicKey: Uint8Array; privateKey: Uint8Array }
    'signed-pre-key': {
        keyId: number
        publicKey: Uint8Array
        privateKey: Uint8Array
        signature: Uint8Array
    }
    session: { registrationId: number; [k: string]: any }
    'sender-key': { [k: string]: any }
    'app-state-sync-key': { [k: string]: any }
    'app-state-sync-version': { [k: string]: any }
    [k: string]: any
}

export interface SignalKeyStore {
    get<T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }>
    set(
        type: keyof SignalDataTypeMap,
        values: { [id: string]: SignalDataTypeMap[keyof SignalDataTypeMap] }
    ): Promise<void>
    remove(type: keyof SignalDataTypeMap, ids: string[]): Promise<void>
}

export interface SignalKeyStoreWithTransaction extends SignalKeyStore {
    isInTransaction: () => boolean
    tx(
        fn: (assertChangesCommitted: () => void) => Promise<void>
    ): Promise<void>
}

export interface AuthenticationCreds {
    registered: boolean
    me?: Contact & { id: string; name?: string }
    account?: any
    signalIdentities?: any[]
    signalRecipe?: any
    signedPreKey?: SignalDataTypeMap['signed-pre-key']
    registrationId?: number
    advB64?: string | null
    platform?: string
    lastRegisteredBundle?: any
    routingInfo?: Buffer | null
    lastUnknownDevice?: any
    firstSaveToDB?: boolean
    /** arbitrary extra fields */
    [k: string]: any
}

export interface AuthenticationState {
    creds: AuthenticationCreds
    keys: SignalKeyStore
}

export interface SignalAuthState {
    creds: AuthenticationCreds
    keys: SignalKeyStoreWithTransaction
}

export type CacheStore = {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T): void
    del(key: string): void
    getKeys?: () => string[]
    flushAll?: () => void
}

/* ------------------------------------------------------------------ */
/*  Connection / event types                                           */
/* ------------------------------------------------------------------ */

export interface ConnectionState {
    connection?: 'open' | 'close' | 'connecting'
    lastDisconnect?: {
        error: Error | undefined
        date: Date
        output?: { statusCode?: number }
    }
    qr?: string
    isNewLogin?: boolean
    isReconnecting?: boolean
    pairingCode?: string
    pairingPhoneUsed?: string
    ws?: WebSocket
}

export type WAPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused'

export type PresenceUpdateType =
    | 'available'
    | 'unavailable'
    | 'composing'
    | 'paused'
    | 'recording'
    | 'reading'
    | '长时间'
    | string

export interface BaileysEventMap {
    'connection.update': Partial<ConnectionState>
    'creds.update': void
    'messaging-history.set': {
        chats: Chat[]
        contacts: Contact[]
        messages: WAMessage[]
        isLatest: boolean
        progress: number
        syncType?: any
    }
    'chats.upsert': Chat[]
    'chats.update': Partial<Chat>[]
    'chats.delete': string[]
    'chats.lock': { id: string }
    'contacts.upsert': Contact[]
    'contacts.update': Partial<Contact>[]
    'messages.upsert': {
        messages: WAMessage[]
        type: 'append' | 'notify' | 'replace'
        requestId?: string
    }
    'messages.update': WAMessageUpdate[]
    'messages.delete':
        | { keys: WAMessageKey[] }
        | { jid: string; all: true }
        | { remoteJid: string; id: string; fromMe: boolean }[]
    'messages.reaction': {
        reactions: {
            id?: string
            ack?: number
            participant?: string
            reaction?: WAReaction
            key: WAMessageKey
        }[]
    }
    'messages.media-update': {
        origin?: string
        update: { key: WAMessageKey; update: { message: WAMessageContent } }
    }[]
    'message-receipt.update': {
        key: WAMessageKey
        receipt: { userJid?: string; status?: number; [k: string]: any }
    }[]
    'presence.update': {
        id: string
        presences: {
            [participant: string]: {
                lastKnownPresence: string
                lastSeen?: number
            }
        }
    }
    'groups.upsert': GroupMetadata[]
    'groups.update': GroupMetadata[]
    'group-participants.update': {
        id: string
        participants: string[]
        action: ParticipantAction
    }
    'group.join-request': {
        id: string
        participants: string[]
        action: 'request_join' | 'request_leave'
    }
    'group.member-tag.update': any
    'blocklist.update': { blocklist: string[] }
    'labels.edit': any
    'labels.association': any
    'call': any
    'call.media': {
        callId: string
        status: 'connected' | 'closed'
        pair?: { ip: string; port: number }
    }
    'newsletter-settings.update': any
    'newsletter-participants.update': any
    'newsletter.reaction': any
    'newsletter.view': any
    'settings.update': any
    'lid-mapping.update': any
    'limit-sharing.update': any
    'community-owner.update': any
    'event': { [k: string]: any }
}

export interface BaileysEventEmitter {
    on<T extends keyof BaileysEventMap>(
        event: T,
        listener: (arg: BaileysEventMap[T]) => void
    ): void
    off<T extends keyof BaileysEventMap>(
        event: T,
        listener: (arg: BaileysEventMap[T]) => void
    ): void
    removeAllListeners<T extends keyof BaileysEventMap>(event: T): void
    emit<T extends keyof BaileysEventMap>(
        event: T,
        arg: BaileysEventMap[T]
    ): boolean
    onAny(listener: (event: string, ...args: any[]) => void): void
    buffer(): void
    flush(): void
    createBufferedFunction<T extends (...args: any[]) => any>(fn: T): T
}

export type ParticipantAction =
    | 'add'
    | 'remove'
    | 'promote'
    | 'demote'
    | 'modify'

export type WAPatchName =
    | 'critical_block'
    | 'critical_unblock_low'
    | 'regular_high'
    | 'regular_low'
    | 'regular'

export interface WAPatchCreate {
    syncAction: any
    index: string[]
    type: WAPatchName
    apiVersion?: number
    operation: 'add' | 'update' | 'remove' | 'replace'
}

/* ------------------------------------------------------------------ */
/*  [MOD] Call media streaming API (lib/Utils/call-media, recv)         */
/* ------------------------------------------------------------------ */

export interface CallCandidate {
    ip: string
    port: number
    type: string
    relayId?: string
    priority?: number
}

export interface AudioQuality {
    codec: string
    bitrate: string
    sampleRate: number
    channels: number
    frameDuration: number
}

export interface VideoQuality {
    codec: string
    bitrate: string
    width: number
    height: number
    fps: number
    preset?: string
}

/** Information about an ongoing group voice/video chat. */
export interface GroupCallInfo {
    groupJid: string
    callId?: string | null
    callCreator?: string | null
    callKey?: Buffer | null
    callKeyHex?: string | null
    offerNode?: BinaryNode
    chatId?: string
    source?: string
    discoveredAt?: number
    raw?: BinaryNode
    [k: string]: any
}

export interface JoinGroupCallOptions {
    forceQuery?: boolean
    timeoutMs?: number
    iceTimeoutMs?: number
    audioQuality?: Partial<AudioQuality>
    videoQuality?: Partial<VideoQuality>
    videoInput?: string
    [k: string]: any
}

/** Either a plain media source path or an audio+video object. */
export type CallAudioInput =
    | string
    | {
          audio?: string
          video?: string
          audioQuality?: Partial<AudioQuality>
          videoQuality?: Partial<VideoQuality>
      }

/**
 * A live call media session. Handles ICE connectivity, RTP/SRTP and the
 * FFmpeg media pump. Emits: 'connected' (pair), 'rtp', 'trackEnd', 'closed'.
 */
export class WACallMediaSession extends EventEmitter {
    callId: string
    callKey: Buffer | null
    candidates: CallCandidate[]
    logger: Logger
    socket: DgramSocket
    selected: { ip: string; port: number } | null
    closed: boolean

    constructor(opts: {
        callId: string
        callKey: Buffer | null
        candidates: CallCandidate[]
        logger?: Logger
    })

    connect(timeoutMs?: number): Promise<{ ip: string; port: number }>

    streamAudio(input: string, quality?: Partial<AudioQuality>): this
    streamVideo(input: string, quality?: Partial<VideoQuality>): this
    streamMedia(
        input: string,
        quality?: { audio?: Partial<AudioQuality>; video?: Partial<VideoQuality> }
    ): this

    stopAudio(): void
    stopVideo(): void
    close(): void

    on(event: 'connected', listener: (pair: { ip: string; port: number }) => void): this
    on(
        event: 'rtp',
        listener: (data: { data: Buffer; from: string }) => void
    ): this
    on(
        event: 'trackEnd',
        listener: (info: { kind: 'audio' | 'video'; skipped: boolean }) => void
    ): this
    on(event: 'closed', listener: () => void): this
    on(event: string, listener: (...args: any[]) => void): this
}

/* ------------------------------------------------------------------ */
/*  sendMessage options                                                */
/* ------------------------------------------------------------------ */

export interface WASendMessageOptions {
    quoted?: WAMessage
    ephemeralExpiration?: number | string
    disappearingMessagesInChat?: boolean
    media?: any
    caption?: string
    detectMentionedJids?: boolean
    mentions?: string[]
    thumbnail?: Buffer
    thumbnailUrl?: string
    backgroundColor?: string
    font?: number
    textColor?: string
    broadcast?: boolean
    additionalNodes?: BinaryNode[]
    statusJidList?: string[]
    useCachedGroupMetadata?: boolean
    cachedGroupMetadata?: CachedGroupMetadata
    linkPreview?: string
    linkPreviewHighQuality?: boolean
    edit?: WAMessageKey
    ai?: any
    /** force background / foreground etc. */
    background?: boolean
    [k: string]: any
}

/* ------------------------------------------------------------------ */
/*  Socket configuration (lib/Socket/socket + Defaults/connection)      */
/* ------------------------------------------------------------------ */

export interface SocketConfig {
    waWebSocketUrl?: string | URL
    connectTimeoutMs?: number
    keepAliveIntervalMs?: number
    logger?: Logger
    printQRInTerminal?: boolean
    defaultQueryTimeoutMs?: number
    transactionOpts?: { [k: string]: any }
    qrTimeout?: number
    makeSignalRepository?: (auth: SignalAuthState) => any
    mobile?: boolean
    syncFullHistory?: boolean
    shouldSyncHistoryMessage?: (msg: WAMessage) => boolean
    cachedGroupMetadata?: CachedGroupMetadata
    getMessage?: (key: WAMessageKey) => Promise<WAMessage | undefined>
    emitOwnEvents?: boolean
    mediaCache?: CacheStore
    msgRetryCounterCache?: CacheStore
    placeholderResendCache?: CacheStore
    userDevicesCache?: CacheStore
    msgRetryCounterCacheTTL?: number
    labelAssociationKey?: string
    enableAutoSessionRecreation?: boolean
    maxMsgRetryCount?: number
    retryRequestDelayMs?: number
    globalCachePolicy?: { [k: string]: any }
    fireInitQueries?: boolean
    linkPreviewImageThumbnailWidth?: number
    generateHighQualityLinkPreview?: boolean
    browser?: [string, string, string]
    version?: [number, number, number]
    countryCode?: string
    options?: { [k: string]: any }
    agent?: any
    fetchAgent?: any
    wsSocket?: any
    socket?: any
    /** [MOD] cache of incoming offers keyed by call id */
    callOfferCache?: any
    [k: string]: any
}

export interface UserFacingSocketConfig extends SocketConfig {
    auth: AuthenticationState
    version: [number, number, number]
    browser?: [string, string, string]
    printQRInTerminal?: boolean
}

/* ------------------------------------------------------------------ */
/*  USync query helpers (lib/WAUSync)                                   */
/* ------------------------------------------------------------------ */

export class USyncUser {
    constructor()
    queryId?: string
    phone?: string
    jid?: string
    lid?: string
    name?: string
    [k: string]: any
    static fromId(id: string): USyncUser
    static fromPhone(phone: string, trivial?: boolean): USyncUser
    static fromJid(jid: string): USyncUser
}

export class USyncQuery {
    constructor()
    [k: string]: any
    static query(): USyncQuery
    withUserList(): USyncQuery
    withLIDList(): USyncQuery
    withBusinessPromise(): USyncQuery
    withContactProfile(): USyncQuery
    withStatus(): USyncQuery
    withPicture(): USyncQuery
    withDevices(devices?: { [k: string]: any }): USyncQuery
    withDisappearingMode(): USyncQuery
    withBotProfile(): USyncQuery
}

export type USyncQueryResult = USyncQuery & {
    result?: any
    [k: string]: any
}

/* [MOD] USync protocol helpers */
export class USyncBotProfileProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}
export class USyncContactProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}
export class USyncDeviceProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}
export class USyncDisappearingModeProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}
export class USyncLIDProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}
export class USyncStatusProtocol {
    constructor()
    name?: string
    getQueryElement(): any
    getUserElement(user: any): any
    parser(node: any): any
}

/* ------------------------------------------------------------------ */
/*  WAM buffer (lib/WAM/BinaryInfo)                                     */
/* ------------------------------------------------------------------ */

export class BinaryInfo {
    constructor(options?: { [k: string]: any })
    [k: string]: any
}

/* ------------------------------------------------------------------ */
/*  The composed WhatsApp socket (the public surface of makeWASocket)   */
/* ------------------------------------------------------------------ */

export interface WASocket {
    /* transport / connection */
    type: 'md'
    ws: WebSocket
    ev: BaileysEventEmitter
    authState: AuthenticationState
    signalRepository: any
    logger?: Logger
    wamBuffer: BinaryInfo

    get user(): Contact | undefined

    generateMessageTag(): string
    query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>
    waitForMessage(
        tag: string,
        timeoutMs?: number,
        predicate?: (node: BinaryNode) => boolean
    ): Promise<BinaryNode>
    waitForSocketOpen(): Promise<void>
    sendRawMessage(data: Buffer | Uint8Array): Promise<void>
    sendNode(node: BinaryNode): Promise<void>
    logout(): Promise<void>
    end(): void
    onUnexpectedError(error: Error, namespace: string): void
    uploadPreKeys(): Promise<void>
    uploadPreKeysToServerIfRequired(): Promise<void>
    digestKeyBundle(...args: any[]): Promise<void>
    rotateSignedPreKey(): Promise<void>
    requestPairingCode(phoneNumber: string): Promise<string>
    waitForConnectionUpdate(
        predicate: (update: Partial<ConnectionState>) => boolean | undefined
    ): Promise<Partial<ConnectionState>>
    sendWAMBuffer(): void
    executeUSyncQuery(query: USyncQuery): Promise<USyncQueryResult>
    onWhatsApp(
        phones: string[]
    ): Promise<
        { jid: string; exists: boolean; isBusiness: boolean; isEnterprise: boolean }[]
    >

    /* chat / presence / profile (lib/Socket/chats) */
    star(
        jid: string,
        messages: { id: string; fromMe?: boolean }[],
        star: boolean
    ): Promise<void>
    addOrEditContact(contact: Partial<WAContact> & { id: string }): Promise<void>
    removeContact(jid: string): Promise<void>
    fetchPrivacySettings(): Promise<{ [k: string]: any }>
    upsertMessage(message: WAMessage, type: 'append' | 'notify' | 'replace'): void
    appPatch(patch: WAPatchCreate): Promise<void>
    createCallLink(): Promise<string>
    sendPresenceUpdate(type: PresenceUpdateType, toJid: string): Promise<void>
    presenceSubscribe(jid: string): Promise<void>
    getBotListV2(): Promise<any>
    messageMutex: { mutex<T>(fn: () => Promise<T>): Promise<T> }
    receiptMutex: any
    appStatePatchMutex: any
    notificationMutex: any
    getLidUser(jid: string): Promise<string | undefined>
    fetchBlocklist(): Promise<string[]>
    fetchStatus(jid: string): Promise<{ status?: string; setAt?: Date } | undefined>
    fetchDisappearingDuration(): Promise<any>
    updateProfilePicture(jid: string, img: Buffer): Promise<void>
    removeProfilePicture(): Promise<void>
    updateProfileStatus(status: string): Promise<void>
    updateProfileName(name: string): Promise<void>
    updateBlockStatus(jid: string, action: 'block' | 'unblock'): Promise<void>
    updateCallPrivacy(value: string): Promise<void>
    updateMessagesPrivacy(value: string): Promise<void>
    updateLastSeenPrivacy(value: string): Promise<void>
    updateOnlinePrivacy(value: string): Promise<void>
    updateProfilePicturePrivacy(value: string): Promise<void>
    updateStatusPrivacy(value: string): Promise<void>
    updateReadReceiptsPrivacy(value: string): Promise<void>
    updateGroupsAddPrivacy(value: string): Promise<void>
    updateDefaultDisappearingMode(duration: number): Promise<void>
    updateDisableLinkPreviewsPrivacy(value: boolean): Promise<void>
    getBusinessProfile(jid: string): Promise<any>
    resyncAppState(
        collections?: WAPatchName[],
        shouldProcessHistoryMsg?: (msg: WAMessage) => boolean
    ): Promise<any>
    chatModify(mod: any, jid: string): Promise<void>
    cleanDirtyBits(): Promise<void>
    addLabel(label: any): Promise<void>
    addChatLabel(jid: string, labelId: string): Promise<void>
    removeChatLabel(jid: string, labelId: string): Promise<void>
    addMessageLabel(jid: string, messageId: string, labelId: string): Promise<void>
    removeMessageLabel(jid: string, messageId: string, labelId: string): Promise<void>
    clearMessage(jid: string, messageId: string, onlyTrim?: boolean): Promise<void>
    addOrEditQuickReply(quickReply: any): Promise<void>
    removeQuickReply(quickReplyId: string): Promise<void>

    /* groups (lib/Socket/groups) */
    groupQuery(jid: string, type: string, content: BinaryNode[]): Promise<BinaryNode>
    groupMetadata(jid: string): Promise<GroupMetadata>
    groupCreate(subject: string, participants: string[]): Promise<GroupMetadata>
    groupLeave(id: string): Promise<void>
    groupUpdateSubject(jid: string, subject: string): Promise<void>
    groupRequestParticipantsList(jid: string): Promise<any>
    groupRequestParticipantsUpdate(
        jid: string,
        participants: string[],
        action: 'approve' | 'reject'
    ): Promise<any>
    groupParticipantsUpdate(
        jid: string,
        participants: string[],
        action: ParticipantAction
    ): Promise<string[]>
    groupUpdateDescription(jid: string, description: string): Promise<void>
    groupInviteCode(jid: string): Promise<string>
    groupRevokeInvite(jid: string): Promise<string>
    groupAcceptInvite(code: string): Promise<string>
    groupRevokeInviteV4(groupJid: string, invitedJid: string): Promise<void>
    groupAcceptInviteV4(inviteMessage: any, err?: any): Promise<void>
    groupGetInviteInfo(code: string): Promise<GroupMetadata>
    groupToggleEphemeral(jid: string, ephemeralExpiration: number): Promise<void>
    groupSettingUpdate(jid: string, setting: string): Promise<void>
    groupMemberAddMode(jid: string, mode: string): Promise<void>
    groupJoinApprovalMode(jid: string, mode: string): Promise<void>
    groupFetchAllParticipating(): Promise<{ [jid: string]: GroupMetadata }>

    /* messages — send (lib/Socket/messages-send) */
    getPrivacyTokens(jids: string[]): Promise<void>
    assertSessions(jids: string[], force: boolean): Promise<void>
    profilePictureUrl(
        jid: string,
        timeoutMs?: number,
        mediaType?: string
    ): Promise<string | undefined>
    relayMessage(
        jid: string,
        message: WAProto['Message'],
        options: {
            messageId: string
            useCachedGroupMetadata?: boolean
            additionalAttributes?: BinaryNodeAttributes
            statusJidList?: string[]
            additionalNodes?: BinaryNode[]
            AI?: any
        }
    ): Promise<void>
    sendReceipt(
        jid: string,
        participant: string | undefined,
        messageIds: string[],
        type: 'read' | 'read-self'
    ): Promise<void>
    sendReceipts(receipts: any[]): Promise<void>
    readMessages(keys: WAMessageKey[]): Promise<void>
    getUSyncDevices(
        jids: string[],
        useCache: boolean,
        ignoreZeroDevices: boolean
    ): Promise<{ user: string; device: number }[]>
    refreshMediaConn(force: boolean): Promise<MediaConnInfo>
    waUploadToServer(
        data: Buffer | Uint8Array,
        opts: { mediaType: string; fileEncSha256B64?: string; [k: string]: any }
    ): Promise<{ mediaUrl: string; directPath: string; handle?: string }>
    getEphemeralGroup(jid: string): Promise<GroupMetadata>
    messageRetryManager: any
    createParticipantNodes(
        jids: string[],
        message: WAProto['Message'],
        extraAttrs: BinaryNodeAttributes
    ): Promise<{ nodes: BinaryNode[]; shouldIncludeDeviceIdentity: boolean }>
    sendPeerDataOperationMessage(
        peerDataOperation: any,
        options?: any
    ): Promise<{ message: WAProto['Message']; key: WAMessageKey }>
    updateMemberLabel(...args: any[]): Promise<void>
    updateMediaMessage(message: WAMessage): Promise<void>
    sendStatusMentions(content: WAMessageContent, jids?: string[]): Promise<void>
    sendMessage(
        jid: string,
        content: WAMessageContent,
        options?: WASendMessageOptions
    ): Promise<WAMessage>

    /* messages — receive + [MOD] calls (lib/Socket/messages-recv) */
    sendMessageAck(...args: any[]): Promise<void>
    sendRetryRequest(node: BinaryNode, forceIncludeKeys?: boolean): Promise<void>
    offerCall(toJid: string, isVideo?: boolean): Promise<{ id: string; to: string }>
    rejectCall(callId: string, callFrom: string): Promise<void>
    /** [MOD] signaling-level accept of an incoming call */
    acceptCall(callId: string, callFrom: string): Promise<{ id: string; callKey: string }>
    /** [MOD] hang up / end / cancel a (incoming or outgoing) call */
    terminateCall(callId: string, callFrom: string, reason?: string): Promise<void>
    /** [MOD] decrypt the inbound media callKey from a call <offer> node */
    decryptCallKey(offerNode: BinaryNode, callFrom: string): Promise<Buffer | null>
    /** [MOD] open the UDP/ICE media transport and start streaming */
    connectCall(
        callId: string,
        callFrom: string,
        audioInput?: CallAudioInput,
        opts?: JoinGroupCallOptions
    ): Promise<WACallMediaSession>
    /** [MOD] access a live media session by call id */
    getCallMediaSession(callId: string): WACallMediaSession | undefined
    /** [MOD] tear down a media session by call id */
    stopCallMedia(callId: string): void
    /** [MOD] get ongoing group call metadata by group JID */
    getCallInfo(groupJid: string, opts?: JoinGroupCallOptions): Promise<GroupCallInfo | null>
    /** [MOD] list discovered active group calls */
    getActiveGroupCalls(): GroupCallInfo[]
    /** [MOD] discover + join a group voice chat and stream audio (one-shot) */
    joinGroupCall(
        groupJid: string,
        audioInput?: CallAudioInput,
        opts?: JoinGroupCallOptions
    ): Promise<WACallMediaSession>
    fetchMessageHistory(...args: any[]): Promise<any>
    requestPlaceholderResend(...args: any[]): Promise<any>
    messageRetryManager: any

    /* business (lib/Socket/business) */
    getOrderDetails(orderId: string, tokenBase64: string): Promise<any>
    getCatalog(jid: string, limit?: number, cursor?: { [k: string]: any }): Promise<any>
    getCollections(
        jid: string,
        limit?: number,
        cursor?: { [k: string]: any }
    ): Promise<any>
    productCreate(jid: string, product: any): Promise<any>
    productDelete(jid: string, productId: string): Promise<any>
    productUpdate(jid: string, product: any): Promise<any>
    updateBussinesProfile(
        jid: string,
        profile: any
    ): Promise<void>
    updateCoverPhoto(
        jid: string,
        cover: { url: string; mediaKey: string } | { url: string; handle: string }
    ): Promise<void>
    removeCoverPhoto(jid: string): Promise<void>

    /* newsletter (lib/Socket/newsletter) */
    newsletterCreate(name: string, description?: string): Promise<NewsletterMetadata>
    newsletterSubscribers(jid: string): Promise<any>
    newsletterMetadata(
        type: 'invite' | 'jid' | 'lick' | string,
        key: string
    ): Promise<NewsletterMetadata>
    newsletterFollow(jid: string): Promise<void>
    newsletterUnfollow(jid: string): Promise<void>
    newsletterMute(jid: string): Promise<void>
    newsletterUnmute(jid: string): Promise<void>
    newsletterUpdateName(jid: string, name: string): Promise<void>
    newsletterUpdateDescription(jid: string, description: string): Promise<void>
    newsletterUpdatePicture(jid: string, content: Buffer): Promise<void>
    newsletterRemovePicture(jid: string): Promise<void>
    newsletterReactMessage(
        jid: string,
        serverId: string,
        reaction: WAReaction
    ): Promise<void>
    newsletterFetchMessages(
        jid: string,
        count: number,
        since?: number,
        after?: number
    ): Promise<any>
    subscribeNewsletterUpdates(jid: string): Promise<void>
    newsletterAdminCount(jid: string): Promise<{ admin_count: number }>
    newsletterChangeOwner(jid: string, newOwnerJid: string): Promise<void>
    newsletterDemote(jid: string, userJid: string): Promise<void>
    newsletterDelete(jid: string): Promise<void>

    /* communities (lib/Socket/community) */
    communityQuery(jid: string, type: string, content: BinaryNode[]): Promise<BinaryNode>
    communityMetadata(jid: string): Promise<CommunityMetadata>
    communityCreate(subject: string, body?: string): Promise<CommunityMetadata>
    communityCreateGroup(
        subject: string,
        participants: string[],
        parentCommunityJid: string
    ): Promise<GroupMetadata>
    communityLeave(id: string): Promise<void>
    communityUpdateSubject(jid: string, subject: string): Promise<void>
    communityLinkGroup(groupJid: string, parentCommunityJid: string): Promise<void>
    communityUnlinkGroup(groupJid: string, parentCommunityJid: string): Promise<void>
    communityFetchLinkedGroups(jid: string): Promise<{
        communityJid: string
        isCommunity: boolean
        linkedGroups: GroupMetadata[]
    }>
    communityRequestParticipantsList(jid: string): Promise<any>
    communityRequestParticipantsUpdate(
        jid: string,
        participants: string[],
        action: 'approve' | 'reject'
    ): Promise<any>
    communityParticipantsUpdate(
        jid: string,
        participants: string[],
        action: ParticipantAction
    ): Promise<string[]>
    communityUpdateDescription(jid: string, description: string): Promise<void>
    communityInviteCode(jid: string): Promise<string>
    communityRevokeInvite(jid: string): Promise<string>
    communityAcceptInvite(code: string): Promise<string>
    communityRevokeInviteV4(communityJid: string, invitedJid: string): Promise<void>
    communityAcceptInviteV4(inviteMessage: any, err?: any): Promise<void>
    communityGetInviteInfo(code: string): Promise<CommunityMetadata>
    communityToggleEphemeral(jid: string, ephemeralExpiration: number): Promise<void>
    communitySettingUpdate(jid: string, setting: string): Promise<void>
    communityMemberAddMode(jid: string, mode: string): Promise<void>
    communityJoinApprovalMode(jid: string, mode: string): Promise<void>
    communityFetchAllParticipating(): Promise<{ [jid: string]: CommunityMetadata }>

    /** [MOD] cache of incoming call offers, keyed by call id */
    callOfferCache?: any
}

/* ------------------------------------------------------------------ */
/*  Media connection info                                              */
/* ------------------------------------------------------------------ */

export interface MediaConnInfo {
    auth: string | null
    ttl: number
    hosts: { hostname: string; sni: string }[]
    fetchDate: Date
}

/* ------------------------------------------------------------------ */
/*  Public factory + auth helpers                                      */
/* ------------------------------------------------------------------ */

export function makeWASocket(config?: UserFacingSocketConfig): WASocket
export default makeWASocket

export function useMultiFileAuthState(folder: string): Promise<{
    state: AuthenticationState
    saveCreds: () => Promise<void>
    clearState?: () => Promise<void>
}>

export function fetchLatestBaileysVersion(options?: {
    [k: string]: any
}): Promise<{
    version: [number, number, number]
    isLatest: boolean
    error?: Error
}>

export function makeCacheableSignalKeyStore(
    store: SignalKeyStore,
    logger?: Logger,
    _cache?: CacheStore
): SignalKeyStore

export function makeInMemoryStore(
    config?: { logger?: Logger; [k: string]: any }
): any

export function makeCacheManagerStore(
    strArray?: string[],
    options?: { [k: string]: any }
): any

export function extractGroupMetadata(
    group: BinaryNode,
    modes?: any
): GroupMetadata

export function extractCommunityMetadata(
    community: BinaryNode,
    modes?: any
): CommunityMetadata

export function parseNewsletterMetadata(
    result: any,
    type?: string,
    role?: string
): NewsletterMetadata

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const DisconnectReason: {
    connectionClosed: 428
    connectionLost: 408
    connectionReplaced: 440
    timedOut: 408
    loggedOut: 401
    badSession: 500
    restartRequired: 515
    multideviceMismatch: 411
    forbidden: 403
    unavailableService: 503
    [k: string]: number
}

export const WAMessageStubType: { [key: string]: number }
export const WAMessageStatus: { [key: string]: number }

export const WAMessageAddressingMode: {
    PN: 'pn'
    LID: 'lid'
}

export const SyncState: {
    Connecting: 0
    AwaitingInitialSync: 1
    Syncing: 2
    Online: 3
}

export const LabelColor: {
    Color1: 0
    Color2: 1
    Color3: 2
    Color4: 3
    Color5: 4
    Color6: 5
    Color7: 6
    Color8: 7
    Color9: 8
    Color10: 9
    Color11: 10
    Color12: 11
    Color13: 12
    Color14: 13
    Color15: 14
    Color16: 15
    Color17: 16
    Color18: 17
    Color19: 18
    Color20: 19
}

export const ALL_WA_PATCH_NAMES: string[]

export const XWAPaths: {
    CREATE: string
    SUBSCRIBERS: string
    VIEW: string
    METADATA: string
    UPDATE: string
    ADMIN_COUNT: string
    MUTE_V2: string
    UNMUTE_V2: string
    FOLLOW: string
    UNFOLLOW: string
    CHANGE_OWNER: string
    DEMOTE: string
    DELETE_V2: string
    [k: string]: string
}

export const QueryIds: {
    CREATE: string
    UPDATE_METADATA: string
    METADATA: string
    SUBSCRIBERS: string
    FOLLOW: string
    UNFOLLOW: string
    MUTE: string
    UNMUTE: string
    ADMIN_COUNT: string
    CHANGE_OWNER: string
    DEMOTE: string
    DELETE: string
    [k: string]: string
}

/* ------------------------------------------------------------------ */
/*  WABinary helpers (re-exported from lib/WABinary)                   */
/* ------------------------------------------------------------------ */

export function encodeBinaryNode(node: BinaryNode): Buffer
export function decodeBinaryNode(data: Buffer | Uint8Array): BinaryNode
export function getBinaryNodeChild(
    node: BinaryNode,
    tag: string
): BinaryNode | undefined
export function getBinaryNodeChildren(
    node: BinaryNode,
    tag: string
): BinaryNode[]
export function getAllBinaryNodeChildren(node: BinaryNode): BinaryNode[]
export function getBinaryNodeChildString(
    node: BinaryNode,
    tag: string
): string | undefined
export function getBinaryNodeChildBuffer(
    node: BinaryNode,
    tag: string
): Buffer | undefined
export function assertNodeErrorFree(node: BinaryNode): void
export function jidNormalizedUser(jid: string): string
export function jidDecode(jid: string): {
    server: string
    user: string
    device?: number
    [k: string]: any
} | null
export function jidEncode(
    jid: string,
    server: string,
    device?: number,
    agent?: number
): string
export function isJidUser(jid: string): boolean
export function isJidGroup(jid: string): boolean
export function isJidBroadcast(jid: string): boolean
export function isJidNewsletter(jid: string): boolean
export function isJidStatusBroadcast(jid: string): boolean
export function isLidUser(jid: string): boolean
export function isPnUser(jid: string): boolean
export function isJidBot(jid: string): boolean
export function isJidMetaAI(jid: string): boolean

/* ------------------------------------------------------------------ */
/*  Call-media engine re-exports (lib/Utils/call-media)                */
/* ------------------------------------------------------------------ */

export const DEFAULT_AUDIO_QUALITY: AudioQuality
export const DEFAULT_VIDEO_QUALITY: VideoQuality

/* ------------------------------------------------------------------ */
/*  Misc commonly used utils                                           */
/* ------------------------------------------------------------------ */

export function generateMessageID(userJid?: string): string
export function toBuffer(obj: any): Buffer
export function getContentType(message: WAMessageContent): string | undefined
export function normalizeMessageContent(content: any): any
export function downloadMediaMessage(
    message: WAMessage,
    type?: 'buffer' | 'stream',
    options?: any
): Promise<Buffer | NodeJS.ReadableStream>
export function getWAProtoTypeName(obj: any): string | undefined

/* `Long` is the protobufjs Long used by timestamps; declared loosely. */
export type Long = {
    low: number
    high: number
    unsigned: boolean
    toNumber(): number
    toString(): string
    [k: string]: any
}

/* ------------------------------------------------------------------ */
/*  Re-exported secondary API (utils, constants, protocols)            */
/*  Typed permissively so every package export is importable & callable.*/
/* ------------------------------------------------------------------ */

export const Browsers: { [key: string]: any }
export const BufferJSON: { [key: string]: any }
export const CALL_VIDEO_PREFIX: string
export const Curve: { [key: string]: any }
export const DECRYPTION_RETRY_CONFIG: { [key: string]: any }
export const DEFAULT_ORIGIN: string
export const DEF_CALLBACK_PREFIX: string
export const DEF_TAG_PREFIX: string
export const DICT_VERSION: number
export const FLAG_BYTE: number
export const FLAG_EVENT: number
export const FLAG_FIELD: number
export const FLAG_GLOBAL: number
export const INITIAL_PREKEY_COUNT: number
export function Itsuki(): any
export const KEY_BUNDLE_TYPE: Buffer
export const MEDIA_KEYS: any
export const MEDIA_PATH_MAP: { [key: string]: any }
export const META_AI_JID: string
export const MIN_PREKEY_COUNT: number
export const MIN_UPLOAD_INTERVAL: number
export const MISSING_KEYS_ERROR_TEXT: string
export const MexOperations: { [key: string]: any }
export const MexUpdatesOperations: { [key: string]: any }
export const NACK_REASONS: { [key: string]: any }
export const NOISE_MODE: string
export const NOISE_WA_HEADER: Buffer
export const OFFICIAL_BIZ_JID: string
export const PHONENUMBER_MCC: any
export const PHONE_CONNECTION_CB: string
export const PSA_WID: string
export const SERVER_JID: string
export const STORIES_JID: string
export const S_WHATSAPP_NET: string
export const Status: any
export const StubType: any
export const UNAUTHORIZED_CODES: any[]
export const UPLOAD_TIMEOUT: number
export const URL_REGEX: any
export const WAJIDDomains: { [key: string]: any }
export const WA_ADV_ACCOUNT_SIG_PREFIX: Buffer
export const WA_ADV_DEVICE_SIG_PREFIX: Buffer
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX: Buffer
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX: Buffer
export const WA_CERT_DETAILS: { [key: string]: any }
export const WA_DEFAULT_EPHEMERAL: number
export const WEB_EVENTS: any[]
export const WEB_GLOBALS: any[]
export function addTransactionCapability(state: any, logger: any, maxCommitRetries: any, delayBetweenTriesMs: any): any
export function aesDecrypt(buffer: any, key: any): any
export function aesDecryptCTR(ciphertext: any, key: any, iv: any): any
export function aesDecryptGCM(ciphertext: any, key: any, iv: any, additionalData: any): any
export function aesDecryptWithIV(buffer: any, key: any, IV: any): any
export function aesEncrypWithIV(buffer: any, key: any, IV: any): any
export function aesEncrypt(buffer: any, key: any): any
export function aesEncryptCTR(plaintext: any, key: any, iv: any): any
export function aesEncryptGCM(plaintext: any, key: any, iv: any, additionalData: any): any
export function aggregateMessageKeysNotFromMe(keys: any): any
export function areJidsSameUser(jid1: any, jid2: any): any
export function asciiEncode(text: any): any
export function bindWaitForConnectionUpdate(ev: any): any
export function bindWaitForEvent(ev: any, event: any): any
export function buildBinding(username: any, integrityKey: any): any
export function bytesToCrockford(buffer: any): any
export function callKdf(callKey: any, label: any, len: any): any
export function chatModificationToAppPatch(mod: any, jid: any): any
export function cleanMessage(message: any, meId: any, meLid: any): any
export function configureSuccessfulPairing(stanza: any, advSecretKey: any, signedIdentityKey: any, signalIdentities: any): any
export function createSignalIdentity(wid: any, accountSignatureKey: any): any
export function debouncedTimeout(intervalMs: any, task: any): any
export function decodeDecompressedBinaryNode(buffer: any, opts: any, indexRef: any): any
export function decodeMediaRetryNode(node: any): any
export function decodeMessageNode(stanza: any, meId: any, meLid: any): any
export function decodePatches(name: any, syncds: any, initial: any, getAppStateSyncKey: any, options: any, minimumVersionNumber: any, logger: any, validateMacs: any): any
export function decodeSyncdMutations(msgMutations: any, initialState: any, getAppStateSyncKey: any, onMutation: any, validateMacs: any): any
export function decodeSyncdPatch(msg: any, name: any, initialState: any, getAppStateSyncKey: any, onMutation: any, validateMacs: any): any
export function decodeSyncdSnapshot(name: any, snapshot: any, getAppStateSyncKey: any, minimumVersionNumber: any, validateMacs: any): any
export function decompressingIfRequired(buffer: any): any
export function decryptComment(encPayload: any, encIv: any, commentCreatorJid: any, commentMsgId: any, commentEncKey: any, commentJid: any): any
export function decryptEventEdit(encPayload: any, encIv: any, eventCreatorJid: any, eventMsgId: any, eventEncKey: any, responderJid: any): any
export function decryptEventResponse(encPayload: any, encIv: any, eventCreatorJid: any, eventMsgId: any, eventEncKey: any, responderJid: any): any
export function decryptMediaRetryData(ciphertext: any, iv: any, mediaKey: any, msgId: any): any
export function decryptMessageNode(stanza: any, meId: any, meLid: any, repository: any, logger: any): any
export function decryptPollVote(encPayload: any, encIv: any, pollCreatorJid: any, pollMsgId: any, pollEncKey: any, voterJid: any): any
export function decryptReaction(encPayload: any, encIv: any, reactionCreatorJid: any, reactionMsgId: any, reactionEncKey: any, reactionJid: any): any
export function delay(ms: any): any
export function delayCancellable(ms: any): any
export function downloadAndProcessHistorySyncNotification(msg: any, options: any): any
export function downloadContentFromMessage(mediaKey: any, directPath: any, url: any, type: any, opts: any): any
export function downloadEncryptedContent(downloadUrl: any, cipherKey: any, iv: any, startByte: any, endByte: any, options: any): any
export function downloadExternalBlob(blob: any, options: any): any
export function downloadExternalPatch(blob: any, options: any): any
export function downloadHistory(msg: any, options: any): any
export function encodeBase64EncodedStringForUpload(b64: any): any
export function encodeBigEndian(e: any, t: any): any
export function encodeNewsletterMessage(message: any): any
export function encodeSyncdPatch(type: any, index: any, syncAction: any, apiVersion: any, operation: any, myAppStateKeyId: any, state: any, getAppStateSyncKey: any): any
export function encodeWAMessage(message: any): any
export function encryptMediaRetryRequest(key: any, mediaKey: any, meId: any): any
export function encryptedStream(media: any, mediaType: any, logger: any, saveOriginalFileIfRequired: any, opts: any): any
export function extensionForMediaMessage(message: any): any
export function extractAddressingContext(stanza: any): any
export function extractCandidates(offerNode: any): any
export function extractDeviceJids(result: any, myJid: any, myLid: any, excludeZeroDevices: any): any
export function extractImageThumb(bufferOrFilePath: any, width: any, quality: any): any
export function extractMessageContent(content: any): any
export function extractSyncdPatches(result: any, options: any): any
export function extractUrlFromText(text: any): any
export function extractVideoThumb(path: any, destPath: any, time: any, size: any): any
export function fetchLatestWaWebVersion(options: any): any
export function fromUnicodeEscape(escapedText: any): any
export function generateForwardMessageContent(message: any, forceForward: any): any
export function generateLinkPreviewIfRequired(text: any, getUrlInfo: any, logger: any): any
export function generateLoginNode(userJid: any, config: any): any
export function generateMdTagPrefix(): any
export function generateOrGetPreKeys(creds: any, range: any): any
export function generateParticipantHashV2(participants: any): any
export function generateProfilePicture(mediaUpload: any, dimensions: any): any
export function generateRegistrationId(): any
export function generateRegistrationNode(registrationId: any, signedPreKey: any, signedIdentityKey: any, config: any): any
export function generateSignalPubKey(pubKey: any): any
export function generateThumbnail(file: any, mediaType: any, options: any): any
export function generateWAMessage(jid: any, content: any, options: any): any
export function generateWAMessageContent(message: any, options: any): any
export function generateWAMessageFromContent(jid: any, message: any, options: any): any
export function getAggregateResponsesInEventMessage(eventResponses: any, meLid: any): any
export function getAggregateVotesInPollMessage(message: any, pollUpdates: any, meId: any): any
export function getAudioDuration(buffer: any): any
export function getAudioWaveform(buffer: any, logger: any): any
export function getBinaryFilteredBizBot(nodeContent: any): any
export function getBinaryFilteredButtons(nodeContent: any): any
export function getBinaryNodeChildUInt(node: any, childTag: any, length: any): any
export function getBinaryNodeMessages(content: any): any
export function getCallStatusFromNode(tag: any, attrs: any): any
export function getChatId(remoteJid: any, participant: any, fromMe: any): any
export function getCodeFromWSError(error: any): any
export function getDevice(id: any): any
export function getErrorCodeFromStreamError(node: any): any
export function getHttpStream(url: any, options: any): any
export function getKeyAuthor(key: any, meId: any): any
export function getMediaKeys(buffer: any, mediaType: any): any
export function getMediaRetryKey(mediaKey: any): any
export function getNextPreKeys(creds: any, keys: any, count: any): any
export function getPreKeys(get: any, min: any, limit: any): any
export function getRawMediaUploadData(media: any, mediaType: any, logger: any): any
export function getStatusCodeForMediaRetry(code: any): any
export function getStatusFromReceiptType(type: any): any
export function getStream(item: any, opts: any): any
export function getUrlFromDirectPath(directPath: any): any
export function getWAUploadToServer(customUploadHosts: any, fetchAgent: any, logger: any, options: any, refreshMediaConn: any): any
export function hasNonNullishProperty(message: any, key: any): any
export function hkdf(buffer: any, expandedLength: any, info: any): any
export function hkdfInfoKey(type: any): any
export function hmacSign(buffer: any, key: any, variant: any): any
export function isHostedLidUser(jid: any): any
export function isHostedPnUser(jid: any): any
export function isRealMessage(message: any): any
export function isWABusinessPlatform(platform: any): any
export function md5(buffer: any): any
export function mediaMessageSHA256B64(message: any): any
export function mutationKeys(keydata: any): any
export function newLTHashState(): any
export function parseAndInjectE2ESessions(node: any, repository: any): any
export function parseStun(buf: any): any
export function prepareAlbumMessageContent(jid: any, albums: any, options: any): any
export function prepareDisappearingMessageSettingContent(expiration: any): any
export function prepareStream(media: any, mediaType: any, logger: any, saveOriginalFileIfRequired: any, opts: any): any
export function prepareWAMessageMedia(message: any, options: any): any
export function printQRIfNecessaryListener(ev: any, logger: any): any
export function processHistoryMessage(item: any): any
export function promiseTimeout(ms: any, promise: any): any
export function reduceBinaryNodeToDictionary(node: any, tag: any): any
export function resolveVideoPreset(name: any): any
export function sha256(buffer: any): any
export function shouldIncrementChatUnread(message: any): any
export function signedKeyPair(identityKeyPair: any, keyId: any): any
export function toNumber(t: any): any
export function toReadable(buffer: any): any
export function toUnicodeEscape(text: any): any
export function transferDevice(fromJid: any, toJid: any): any
export function trimUndefined(obj: any): any
export function unixTimestampSeconds(date: any): any
export function unpadRandomMax16(e: any): any
export function updateMessageWithEventResponse(msg: any, update: any): any
export function updateMessageWithPollUpdate(msg: any, update: any): any
export function updateMessageWithReaction(msg: any, reaction: any): any
export function updateMessageWithReceipt(msg: any, receipt: any): any
export function uploadWithNodeHttp(url: any, filePath: any, headers: any, timeoutMs: any, agent: any, redirectCount: any): any
export function waChatKey(pin: any): any
export const waLabelAssociationKey: { [key: string]: any }
export function waMessageID(m: any): any
export function writeRandomPadMax16(msg: any): any
export function xmppPreKey(pair: any, id: any): any
export function xmppSignedPreKey(key: any): any

/* ------------------------------------------------------------------ */
/*  Re-exported secondary API (utils, constants, protocols)            */
/*  Typed permissively so every package export is importable & callable.*/
/* ------------------------------------------------------------------ */

export const CALL_AUDIO_PREFIX: string
export const DEFAULT_CACHE_TTLS: { [key: string]: any }
export const DEFAULT_CONNECTION_CONFIG: { [key: string]: any }
export const FLAG_EXTENDED: number
export const LT_HASH_ANTI_TAMPERING: any
export const MEDIA_HKDF_KEY_MAPPING: { [key: string]: any }
export const MEDIA_RETRY_STATUS_MAP: { [key: string]: any }
export class MessageRetryManager { constructor(...args: any[]); [key: string]: any }
export const NO_MESSAGE_FOUND_ERROR_TEXT: string
export class ObjectRepository { constructor(...args: any[]); [key: string]: any }
export const PROCESSABLE_HISTORY_TYPES: any[]
export const XWAPathsMexUpdates: { [key: string]: any }
export function asciiDecode(codes: any): any
export function assertMediaContent(content: any): any
export function binaryNodeToString(node: any, i: any): any
export function derivePairingCodeKey(pairingCode: any, salt: any): any
export function encodeSignedDeviceIdentity(account: any, includeSignatureKey: any): any
export function encodeWAM(binaryInfo: any): any
export function getHistoryMsg(message: any): any
export function getNextPreKeysNode(state: any, count: any): any
export function getPlatformId(browser: any): any
export function getServerFromDomainType(initialServer: any, domainType: any): any
export function getUrlInfo(text: any, opts: any, fetchOpts: any): any
export function initAuthCreds(): any
export function makeCacheManagerAuthState(store: any, sessionKey: any): any
export function makeEventBuffer(logger: any): any
export function makeNoiseHandler(keyPair: any, public: any, NOISE_HEADER: any, logger: any, routingInfo: any): any
export function makeOrderedDictionary(idGetter: any): any
export function processMessage(message: any, shouldProcessHistoryMsg: any, placeholderResendCache: any, ev: any, creds: any, signalRepository: any, keyStore: any, logger: any, options: any, getMessage: any): any
export function processSyncAction(syncAction: any, ev: any, me: any, initialSyncOpts: any, logger: any): any
