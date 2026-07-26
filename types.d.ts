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
import type { WebSocket } from 'ws'
import type { Readable, Transform } from 'stream'
import type { Boom } from '@hapi/boom'
import type { Agent } from 'http'

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

/**
 * `proto` is also usable in type position (`proto.IMessage`, `proto.IWebMessageInfo`, ...).
 * The generated protobuf types are not reproduced here, so members resolve to `any`.
 */
export namespace proto {
    export type SyncdMutations = any
    export type MediaRetryNotification = any
    export type IConversation = any
    export type PinInChat = any
    export namespace PinInChat {
        export type Type = any
    }
    export type IMessage = any
    export type Message = any
    export namespace Message {
        export type EventResponseMessage = any
        export type IAudioMessage = any
        export type IContactMessage = any
        export type IDocumentMessage = any
        export type IHistorySyncNotification = any
        export type IImageMessage = any
        export type IListResponseMessage = any
        export type ILocationMessage = any
        export type IPollEncValue = any
        export type IReactionMessage = any
        export type IStickerMessage = any
        export type IVideoMessage = any
        export type PollVoteMessage = any
        export type ProductMessage = any
        export namespace ProductMessage {
            export type IProductSnapshot = any
            export type ICatalogSnapshot = any
        }
    }
    export type IWebMessageInfo = any
    export type WebMessageInfo = any
    export namespace WebMessageInfo {
        export type Status = any
        export type StubType = any
    }
    export type IContextInfo = any
    export type ISyncdMutation = any
    export type ISyncdRecord = any
    export type ISyncdPatch = any
    export type ISyncdSnapshot = any
    export type SyncdMutation = any
    export type IHistorySync = any
    export type HistorySync = any
    export namespace HistorySync {
        export type HistorySyncType = any
    }
    export type IHistorySyncNotification = any
    export type IExternalBlobReference = any
    export type ISyncActionValue = any
    export type SyncActionValue = any
    export namespace SyncActionValue {
        export type IContactAction = any
        export type IPrivacySettingDisableLinkPreviewsAction = any
        export type IQuickReplyAction = any
        export type ISyncActionMessageRange = any
    }
    export type ISyncActionData = any
    export type SyncActionData = any
    export type IClientPayload = any
    export type ClientPayload = any
    export type IADVSignedDeviceIdentity = any
    export type ADVSignedDeviceIdentity = any
    export type IPollUpdate = any
    export type IPollEncValue = any
    export type IReaction = any
    export type IEventResponse = any
    export type IPastParticipants = any
    export type IAudioMessage = any
    export type IImageMessage = any
    export type IVideoMessage = any
    export type IDocumentMessage = any
    export type IStickerMessage = any
    export type IMessageKey = any
    export type MessageKey = any
    export type IDeviceListMetadata = any
    export type IUserReceipt = any
    export type IMessageContextInfo = any
    export type IAppStateSyncKey = any
    export type IAppStateSyncKeyData = any
    export type IAppStateSyncKeyId = any
    export type IHandshakeMessage = any
    export type HandshakeMessage = any
    export type INoiseCertificate = any
    export type ICertChain = any
    export type IBizIdentityInfo = any
    export type IBizAccountPayload = any
    export type IEventResponseMessage = any
    export type IKeepInChat = any
}

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
    /** reactions attached to this message (see updateMessageWithReaction) */
    reactions?: proto.IReaction[]
    /** poll votes attached to this message (see updateMessageWithPollUpdate) */
    pollUpdates?: proto.IPollUpdate[]
    /** event responses attached to this message */
    eventResponses?: proto.IEventResponse[]
    /** per-user delivery/read receipts */
    userReceipt?: proto.IUserReceipt[]
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

export type GroupParticipant = Participant

export interface Participant {
    id: string
    lid?: string
    admin?: 'superadmin' | 'admin' | null
}

export interface GroupMetadata {
    id: string
    /** LID of the group, when addressed over LID */
    lid?: string
    owner: string | undefined
    /** alternate (PN/LID) form of the owner jid */
    ownerAlt?: string
    ownerCountry?: string
    subject: string
    subjectOwner?: string
    /** alternate (PN/LID) form of the subject owner jid */
    subjectOwnerAlt?: string
    subjectTime?: number
    creation?: number
    desc?: string
    descId?: string
    linkedParent?: string
    linkedSubject?: string
    size?: number
    participants: Participant[]
    ephemeralDuration?: number
    /** 'pn' | 'lid' */
    addressingMode?: string
    inviteCode?: string
    /** only admins can send messages */
    announce?: boolean
    /** only admins can edit group info */
    restrict?: boolean
    /** is this group a community parent */
    isCommunity?: boolean
    /** is this the announcement group of a community */
    isCommunityAnnounce?: boolean
    /** new members require admin approval */
    joinApprovalMode?: boolean
    /** your role in the group */
    admin?: 'admin' | 'superadmin' | null
    author?: string
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
    /** write a batch of keys; pass `null` as a value to delete that id */
    set(data: SignalDataSet): Promise<void>
    /** clear all the data in the store (optional, not all stores implement it) */
    clear?(): Promise<void>
}

export interface SignalKeyStoreWithTransaction extends SignalKeyStore {
    isInTransaction: () => boolean
    /** run `work` inside a keyed transaction (see lib/Utils/auth-utils.js) */
    transaction<T>(work: () => Promise<T>, key: string): Promise<T>
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
    'call': WACallEvent[]
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
    logger: ILogger
    socket: DgramSocket
    selected: { ip: string; port: number } | null
    closed: boolean

    constructor(opts: {
        callId: string
        callKey: Buffer | null
        candidates: CallCandidate[]
        logger?: ILogger
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
    logger?: ILogger
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
    /** patch the message right before it is encrypted & sent */
    patchMessageBeforeSending?: (
        msg: WAMessageContent,
        recipientJids?: string[]
    ) => Promise<WAMessageContent> | WAMessageContent
    /** ignore all events emitted for these JIDs */
    shouldIgnoreJid?: (jid: string) => boolean | undefined
    /** stay online after connecting */
    markOnlineOnConnect?: boolean
    /** extra hosts to try when uploading media */
    customUploadHosts?: MediaConnInfo['hosts']
    /** keep a cache of recently sent messages for retry receipts */
    enableRecentMessageCache?: boolean
    /** validate app-state patch / snapshot MACs */
    appStateMacVerification?: {
        patch: boolean
        snapshot: boolean
    }
    auth?: AuthenticationState
    /** [MOD] cache of incoming offers keyed by call id */
    callOfferCache?: any
    [k: string]: any
}

export type UserFacingSocketConfig = Partial<SocketConfig> & {
    auth: AuthenticationState
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
    /** run a WhatsApp MEX (GraphQL) query and return the node at `dataPath` */
    executeWMexQuery<T = any>(
        variables: { [k: string]: any },
        queryId: string,
        dataPath: string,
        query?: string,
        generateMessageTag?: () => string
    ): Promise<T>
    signalRepository: any
    logger?: ILogger
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
        ...phones: string[]
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
    updateProfilePicture(
        jid: string,
        content: WAMediaUpload,
        dimensions?: { w: number; h: number }
    ): Promise<void>
    removeProfilePicture(jid: string): Promise<void>
    updateProfileStatus(status: string): Promise<void>
    updateProfileName(name: string): Promise<void>
    updateBlockStatus(jid: string, action: 'block' | 'unblock'): Promise<void>
    updateCallPrivacy(value: WAPrivacyCallValue): Promise<void>
    updateMessagesPrivacy(value: WAPrivacyMessagesValue): Promise<void>
    updateLastSeenPrivacy(value: WAPrivacyValue): Promise<void>
    updateOnlinePrivacy(value: WAPrivacyOnlineValue): Promise<void>
    updateProfilePicturePrivacy(value: WAPrivacyValue): Promise<void>
    updateStatusPrivacy(value: WAPrivacyValue): Promise<void>
    updateReadReceiptsPrivacy(value: WAReadReceiptsValue): Promise<void>
    updateGroupsAddPrivacy(value: WAPrivacyGroupAddValue): Promise<void>
    updateDefaultDisappearingMode(duration: number): Promise<void>
    updateDisableLinkPreviewsPrivacy(value: boolean): Promise<void>
    getBusinessProfile(jid: string): Promise<WABusinessProfile | undefined>
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
    profilePictureUrl(jid: string): Promise<string | undefined>
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
    sendStatusMentions(content: AnyMessageContent, jids?: string[]): Promise<any>
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

    /* business (lib/Socket/business) */
    getOrderDetails(orderId: string, tokenBase64: string): Promise<OrderDetails>
    getCatalog(options?: GetCatalogOptions): Promise<CatalogResult>
    getCollections(
        jid?: string,
        limit?: number
    ): Promise<{ collections: CatalogCollection[] }>
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
    /** generic newsletter update (name / description / picture / settings) */
    newsletterUpdate(
        jid: string,
        updates: {
            name?: string
            description?: string
            picture?: string | null
            [k: string]: any
        }
    ): Promise<any>
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
/*  Supporting types referenced by the precise declarations below      */
/* ------------------------------------------------------------------ */


/** Fetch an app-state sync key by its base64 id */
export type FetchAppStateSyncKey = (keyId: string) => Promise<any | null | undefined>

export type LTHashAntiTampering = {
    generate: (input: Uint8Array) => Uint8Array
    [k: string]: any
}

export type EncryptedStreamOptions = {
    saveOriginalFileIfRequired?: boolean
    logger?: ILogger
    opts?: any
}

export type MediaUploadResult = {
    url?: string
    direct_path?: string
    meta_hmac?: string
    ts?: number
    fbid?: number
}

export type ExtractByKey<T, K extends PropertyKey> = T extends Record<K, any> ? T : never

export type VoteAggregation = {
    name: string
    voters: string[]
}

export type ResponseAggregation = {
    response: string
    responders: string[]
}

export type PollContext = {
    /** normalised jid of the person that created the poll */
    pollCreatorJid: string
    /** ID of the poll creation message */
    pollMsgId: string
    /** poll creation message enc key */
    pollEncKey: Uint8Array
    /** jid of the person that voted */
    voterJid: string
}

export type EventContext = {
    /** normalised jid of the person that created the event */
    eventCreatorJid: string
    /** ID of the event creation message */
    eventMsgId: string
    /** event creation message enc key */
    eventEncKey: Uint8Array
    /** jid of the person that responded */
    responderJid: string
}

export type BaileysBufferableEventEmitter = BaileysEventEmitter & {
    /** Use to process events in a batch */
    process(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): () => void
    /** starts buffering events, call flush() to release them */
    buffer(): void
    /** buffers all events till the promise completes */
    createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>
    /**
     * flushes all buffered events
     * @returns returns true if the flush actually happened, otherwise false
     */
    flush(): boolean
    /** is there an ongoing buffer */
    isBuffering(): boolean
    /** destroy the event buffer, clearing all resources */
    destroy(): void
}


/* --- precise supporting types (shape-matched to whiskeysockets/baileys) --- */

/* --- business / product / newsletter / signal-set types --- */

export type SignalDataSet = {
    [T in keyof SignalDataTypeMap]?: {
        [id: string]: SignalDataTypeMap[T] | null
    }
}

/** Alias kept for convenience: newsletter metadata object */
export type Newsletter = NewsletterMetadata

export type WABusinessHoursConfig = {
    day_of_week: string
    mode: string
    open_time?: number
    close_time?: number
}

export type WABusinessProfile = {
    description: string
    email: string | undefined
    business_hours: {
        timezone?: string
        config?: WABusinessHoursConfig[]
        business_config?: WABusinessHoursConfig[]
    }
    website: string[]
    category?: string
    wid?: string
    address?: string
}

export type ProductAvailability = 'in stock'

export type ProductBase = {
    name: string
    retailerId?: string
    url?: string
    description: string
    price: number
    currency: string
    isHidden?: boolean
}

/** Shape returned by parseProductNode() in lib/Utils/business.js */
export type Product = ProductBase & {
    id: string
    imageUrls: { [_: string]: string }
    reviewStatus: { [_: string]: string }
    availability: ProductAvailability
}

export type OrderPrice = {
    total: number
    currency: string
}

export type OrderProduct = {
    id: string
    name: string
    imageUrl: string
    price: number
    currency: string
    quantity: number
}

/** Shape returned by parseOrderDetailsNode() in lib/Utils/business.js */
export type OrderDetails = {
    price: OrderPrice
    products: OrderProduct[]
}

export type CatalogCursor = string

export type GetCatalogOptions = {
    /** cursor to start from */
    cursor?: CatalogCursor
    /** number of products to fetch */
    limit?: number
    jid?: string
}

/** Shape returned by parseCatalogNode() in lib/Utils/business.js */
export type CatalogResult = {
    products: Product[]
    nextPageCursor: CatalogCursor | undefined
}

export type CatalogCollection = {
    id: string
    name: string
    products: Product[]
    status: string
}


export type WAPrivacyValue = 'all' | 'contacts' | 'contact_blacklist' | 'none'
export type WAPrivacyOnlineValue = 'all' | 'match_last_seen'
export type WAPrivacyGroupAddValue = 'all' | 'contacts' | 'contact_blacklist'
export type WAReadReceiptsValue = 'all' | 'none'
export type WAPrivacyCallValue = 'all' | 'known'
export type WAPrivacyMessagesValue = 'all' | 'contacts'


export type WACallEvent = {
    chatId: string
    from: string
    id: string
    date: Date
    offline: boolean
    status: WACallUpdateType
    isVideo?: boolean
    isGroup?: boolean
    groupJid?: string
    /** [MOD] raw <offer> binary node, present on 'offer' events */
    offerNode?: BinaryNode
    /** [MOD] decrypted 32-byte call media key, present on 'offer' when derivable */
    callKey?: Buffer
    /** [MOD] hex form of `callKey` */
    callKeyHex?: string
}


/* --- internal helper shapes (mirrored from whiskeysockets/baileys) --- */

export type Mentionable = {
    /** list of jids that are mentioned in the accompanying text */
    mentions?: string[]
    /** mention all */
    mentionAll?: boolean
}

export type Contextable = {
    /** add contextInfo to the message */
    contextInfo?: any
}

export type ViewOnce = {
    viewOnce?: boolean
}

export type Editable = {
    edit?: WAMessageKey
}

export type WithDimensions = {
    width?: number
    height?: number
}

export type SharePhoneNumber = {
    sharePhoneNumber: boolean
}

export type RequestPhoneNumber = {
    requestPhoneNumber: boolean
}

export type MinimalRelayOptions = {
    /** override the message ID with a custom provided string */
    messageId?: string
    /** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
    useCachedGroupMetadata?: boolean
}

export type DecryptGroupSignalOpts = {
    group: string
    authorJid: string
    msg: Uint8Array
}

export type ProcessSenderKeyDistributionMessageOpts = {
    item: any
    authorJid: string
}

export type DecryptSignalProtoOpts = {
    jid: string
    type: 'pkmsg' | 'msg'
    ciphertext: Uint8Array
}

export type EncryptMessageOpts = {
    jid: string
    data: Uint8Array
}

export type EncryptGroupMessageOpts = {
    group: string
    data: Uint8Array
    meId: string
}

export type GetSenderKeyDistributionMessageOpts = {
    group: string
    meId: string
}

export type E2ESessionOpts = {
    jid: string
    session: any
}

/**
 * LID <-> phone-number mapping store.
 * NOTE: typed against THIS repo's lib/Signal/lid-mapping.js, which exposes
 * storeLIDPNMappings / getLIDForPN / getLIDsForPNs / getPNForLID.
 */
export interface LIDMappingStore {
    storeLIDPNMappings(pairs: LIDMapping[]): Promise<void>
    getLIDForPN(pn: string): Promise<string | null>
    getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null>
    getPNForLID(lid: string): Promise<string | null>
}


export type EventMessageOptions = {
    name: string;
    description?: string;
    startDate: Date;
    endDate?: Date;
    location?: WALocationMessage;
    call?: 'audio' | 'video';
    isCancelled?: boolean;
    isScheduleCall?: boolean;
    extraGuestsAllowed?: boolean;
    messageSecret?: Uint8Array;
};

export type PollMessageOptions = {
    name: string;
    selectableCount?: number;
    values: string[];
    /** 32 byte message secret to encrypt poll selections */
    messageSecret?: Uint8Array;
    toAnnouncementGroup?: boolean;
};

export type AlbumMessageOptions = {
    /** Number of images expected in the album */
    expectedImageCount?: number;
    /** Number of videos expected in the album */
    expectedVideoCount?: number;
};

export type WALocationMessage = proto.Message.ILocationMessage;

export type ButtonReplyInfo = {
    displayText: string;
    id: string;
    index: number;
};

export type GroupInviteInfo = {
    inviteCode: string;
    inviteExpiration: number;
    text: string;
    jid: string;
    subject: string;
};

export type WASendableProduct = Omit<proto.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
    productImage: WAMediaUpload;
};

export type MinimalMessage = Pick<WAMessage, 'key' | 'messageTimestamp'>;

export type AnyRegularMessageContent = (({
    text: string;
    linkPreview?: WAUrlInfo | null;
} & Mentionable & Contextable & Editable) | AnyMediaMessageContent | {
    event: EventMessageOptions;
} | ({
    poll: PollMessageOptions;
} & Mentionable & Contextable & Editable) | ({
    album: AlbumMessageOptions;
} & Contextable & Mentionable) | {
    contacts: {
        displayName?: string;
        contacts: proto.Message.IContactMessage[];
    };
} | {
    location: WALocationMessage;
} | {
    react: proto.Message.IReactionMessage;
} | {
    buttonReply: ButtonReplyInfo;
    type: 'template' | 'plain';
} | {
    groupInvite: GroupInviteInfo;
} | {
    listReply: Omit<proto.Message.IListResponseMessage, 'contextInfo'>;
} | {
    pin: WAMessageKey;
    type: proto.PinInChat.Type;
    /**
     * 24 hours, 7 days, 30 days
     */
    time?: 86400 | 604800 | 2592000;
} | {
    product: WASendableProduct;
    businessOwnerJid?: string;
    body?: string;
    footer?: string;
} | SharePhoneNumber | RequestPhoneNumber) & ViewOnce;

export type LastMessageList = MinimalMessage[] | proto.SyncActionValue.ISyncActionMessageRange;

export interface LabelActionBody {
    id: string;
    /** Label name */
    name?: string;
    /** Label color ID */
    color?: number;
    /** Is label has been deleted */
    deleted?: boolean;
    /** WhatsApp has 5 predefined labels (New customer, New order & etc) */
    predefinedId?: number;
}

export interface ChatLabelAssociationActionBody {
    labelId: string;
}

export interface MessageLabelAssociationActionBody {
    labelId: string;
    messageId: string;
}

export type QuickReplyAction = proto.SyncActionValue.IQuickReplyAction & {
    timestamp?: string;
};

export type JidWithDevice = {
    user: string;
    device?: number;
};

export type AccountSettings = {
    /** unarchive chats when a new message is received */
    unarchiveChats: boolean;
    /** the default mode to start new conversations with */
    defaultDisappearingMode?: Pick<proto.IConversation, 'ephemeralExpiration' | 'ephemeralSettingTimestamp'>;
};

export type MediaGenerationOptions = {
    logger?: ILogger;
    mediaTypeOverride?: MediaType;
    upload: WAMediaUploadFunction;
    /** cache media so it does not have to be uploaded again */
    mediaCache?: CacheStore;
    mediaUploadTimeoutMs?: number;
    options?: RequestInit;
    backgroundColor?: string;
    font?: number;
};

export type MiscMessageGenerationOptions = MinimalRelayOptions & {
    /** optional, if you want to manually set the timestamp of the message */
    timestamp?: Date;
    /** the message you want to quote */
    quoted?: WAMessage;
    /** disappearing messages settings */
    ephemeralExpiration?: number | string;
    /** timeout for media upload to WA server */
    mediaUploadTimeoutMs?: number;
    /** jid list of participants for status@broadcast */
    statusJidList?: string[];
    /** backgroundcolor for status */
    backgroundColor?: string;
    /** font type for status */
    font?: number;
    /** if it is broadcast */
    broadcast?: boolean;
};

export type ProtocolAddress = {
    name: string;
    deviceId: number;
};

export type SignalRepository = {
    decryptGroupMessage(opts: DecryptGroupSignalOpts): Promise<Uint8Array>;
    processSenderKeyDistributionMessage(opts: ProcessSenderKeyDistributionMessageOpts): Promise<void>;
    decryptMessage(opts: DecryptSignalProtoOpts): Promise<Uint8Array>;
    encryptMessage(opts: EncryptMessageOpts): Promise<{
        type: 'pkmsg' | 'msg';
        ciphertext: Uint8Array;
    }>;
    encryptGroupMessage(opts: EncryptGroupMessageOpts): Promise<{
        senderKeyDistributionMessage: Uint8Array;
        ciphertext: Uint8Array;
    }>;
    getSenderKeyDistributionMessage(opts: GetSenderKeyDistributionMessageOpts): Promise<Uint8Array>;
    hasSenderKey(opts: GetSenderKeyDistributionMessageOpts): Promise<boolean>;
    getSessionInfo(jid: string): Promise<{
        baseKey: Uint8Array;
        registrationId: number;
    } | null>;
    injectE2ESession(opts: E2ESessionOpts): Promise<void>;
    validateSession(jid: string): Promise<{
        exists: boolean;
        reason?: string;
    }>;
    jidToSignalProtocolAddress(jid: string): string;
    migrateSession(fromJid: string, toJid: string): Promise<{
        migrated: number;
        skipped: number;
        total: number;
    }>;
    validateSession(jid: string): Promise<{
        exists: boolean;
        reason?: string;
    }>;
    deleteSession(jids: string[]): Promise<void>;
};

export type WAMediaPayloadStream = {
    stream: Readable;
};

export type WAMediaPayloadURL = {
    url: URL | string;
};

export type AnyMediaMessageContent = (({
    image: WAMediaUpload;
    caption?: string;
    jpegThumbnail?: string;
} & Mentionable & Contextable & WithDimensions) | ({
    video: WAMediaUpload;
    caption?: string;
    gifPlayback?: boolean;
    jpegThumbnail?: string;
    /** if set to true, will send as a `video note` */
    ptv?: boolean;
} & Mentionable & Contextable & WithDimensions) | {
    audio: WAMediaUpload;
    /** if set to true, will send as a `voice note` */
    ptt?: boolean;
    /** optionally tell the duration of the audio */
    seconds?: number;
} | ({
    sticker: WAMediaUpload;
    isAnimated?: boolean;
} & WithDimensions) | ({
    document: WAMediaUpload;
    mimetype: string;
    fileName?: string;
    caption?: string;
} & Contextable)) & {
    mimetype?: string;
} & Editable & {
    /** key of the parent albumMessage to associate this media with */
    albumParentKey?: WAMessageKey;
};

export type AnyMessageContent = AnyRegularMessageContent | {
    forward: WAMessage;
    force?: boolean;
} | {
    /** Delete your message or anyone's message in a group (admin required) */
    delete: WAMessageKey;
} | {
    disappearingMessagesInChat: boolean | number;
} | {
    limitSharing: boolean;
};

export type BinaryNodeCodingOptions = {
    TAGS: { [name: string]: number }
    TOKEN_MAP: { [token: string]: { dict?: number; index: number } }
    SINGLE_BYTE_TOKENS: (string | undefined)[]
    DOUBLE_BYTE_TOKENS: (string | undefined)[][]
    [k: string]: any
}

export type BrowsersMap = {
    ubuntu(browser: string): [string, string, string];
    macOS(browser: string): [string, string, string];
    baileys(browser: string): [string, string, string];
    windows(browser: string): [string, string, string];
    appropriate(browser: string): [string, string, string];
};

export type ChatModification = {
    archive: boolean;
    lastMessages: LastMessageList;
} | {
    pushNameSetting: string;
} | {
    pin: boolean;
} | {
    /** mute for duration, or provide timestamp of mute to remove*/
    mute: number | null;
} | {
    clear: boolean;
    lastMessages: LastMessageList;
} | {
    deleteForMe: {
        deleteMedia: boolean;
        key: WAMessageKey;
        timestamp: number;
    };
} | {
    star: {
        messages: {
            id: string;
            fromMe?: boolean;
        }[];
        star: boolean;
    };
} | {
    markRead: boolean;
    lastMessages: LastMessageList;
} | {
    delete: true;
    lastMessages: LastMessageList;
} | {
    contact: proto.SyncActionValue.IContactAction | null;
} | {
    disableLinkPreviews: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction;
} | {
    addLabel: LabelActionBody;
} | {
    addChatLabel: ChatLabelAssociationActionBody;
} | {
    removeChatLabel: ChatLabelAssociationActionBody;
} | {
    addMessageLabel: MessageLabelAssociationActionBody;
} | {
    removeMessageLabel: MessageLabelAssociationActionBody;
} | {
    quickReply: QuickReplyAction;
};

export type ChatMutation = {
    syncAction: proto.ISyncActionData;
    index: string[];
};

export type ChatMutationMap = {
    [index: string]: ChatMutation;
};

export type DownloadableMessage = {
    mediaKey?: Uint8Array | null;
    directPath?: string | null;
    url?: string | null;
};

export type FullJid = JidWithDevice & {
    /** raw server part of the JID, e.g. 's.whatsapp.net' | 'g.us' | 'lid' | ... */
    server: JidServer | (string & {});
    domainType?: number;
};

export interface ILogger {
    level: string;
    child(obj: Record<string, unknown>): ILogger;
    trace(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
}

export type InitialAppStateSyncOptions = {
    accountSettings: AccountSettings;
};

export type JidServer = 'c.us' | 'g.us' | 'broadcast' | 's.whatsapp.net' | 'call' | 'lid' | 'newsletter' | 'bot' | 'hosted' | 'hosted.lid';

export type KeyPair = {
    public: Uint8Array;
    private: Uint8Array;
};

export type LIDMapping = {
    pn: string;
    lid: string;
};

export type LTHashState = {
    version: number;
    hash: Buffer;
    indexValueMap: {
        [indexMacBase64: string]: {
            valueMac: Uint8Array | Buffer;
        };
    };
};

export type MediaDecryptionKeyInfo = {
    iv: Uint8Array;
    cipherKey: Uint8Array;
    macKey?: Uint8Array;
};

export type MediaDownloadOptions = {
    startByte?: number;
    endByte?: number;
    options?: RequestInit;
    /** Optional media host override; falls back to DEF_MEDIA_HOST when not provided. */
    host?: string;
};

export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING;

export type MessageContentGenerationOptions = MediaGenerationOptions & {
    getUrlInfo?: (text: string) => Promise<WAUrlInfo | undefined>;
    getProfilePicUrl?: (jid: string, type: 'image' | 'preview') => Promise<string | undefined>;
    getCallLink?: (type: 'audio' | 'video', event?: {
        startTime: number;
    }) => Promise<string | undefined>;
    jid?: string;
};

export type MessageGenerationOptions = MessageContentGenerationOptions & MessageGenerationOptionsFromContent;

export type MessageGenerationOptionsFromContent = MiscMessageGenerationOptions & {
    userJid: string;
};

export type MessageUserReceipt = proto.IUserReceipt;

export interface RecentMessage {
    message: proto.IMessage;
    timestamp: number;
}

export enum RetryReason {
    UnknownError = 0,
    SignalErrorNoSession = 1,
    SignalErrorInvalidKey = 2,
    SignalErrorInvalidKeyId = 3,
    /** MAC verification failed - most common cause of decryption failures */
    SignalErrorInvalidMessage = 4,
    SignalErrorInvalidSignature = 5,
    SignalErrorFutureMessage = 6,
    /** Explicit MAC failure - session is definitely out of sync */
    SignalErrorBadMac = 7,
    SignalErrorInvalidSession = 8,
    SignalErrorInvalidMsgKey = 9,
    BadBroadcastEphemeralSetting = 10,
    UnknownCompanionNoPrekey = 11,
    AdvFailure = 12,
    StatusRevokeDelay = 13
}

export type SignalCreds = {
    readonly signedIdentityKey: KeyPair;
    readonly signedPreKey: SignedKeyPair;
    readonly registrationId: number;
};

export type SignalIdentity = {
    identifier: ProtocolAddress;
    identifierKey: Uint8Array;
};

export interface SignalRepositoryWithLIDStore extends SignalRepository {
    lidMapping: LIDMappingStore;
    close?: () => void;
}

export type SignedKeyPair = {
    keyPair: KeyPair;
    signature: Uint8Array;
    keyId: number;
    timestampS?: number;
};

export type TransactionCapabilityOptions = {
    maxCommitRetries: number;
    delayBetweenTriesMs: number;
};

export type URLGenerationOptions = {
    thumbnailWidth: number;
    fetchOpts: {
        /** Timeout in ms */
        timeout: number;
        proxyUrl?: string;
        headers?: HeadersInit;
    };
    uploadImage?: WAMediaUploadFunction;
    logger?: ILogger;
};

export type USyncQueryResultList = {
    [protocol: string]: unknown;
    id: string;
};

export type UploadParams = {
    url: string;
    filePath: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    agent?: Agent;
};

export type WACallUpdateType = 'offer' | 'ringing' | 'preaccept' | 'transport' | 'relaylatency' | 'timeout' | 'reject' | 'accept' | 'terminate';

export type WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL;

export type WAMediaUploadFunction = (encFilePath: string, opts: {
    fileEncSha256B64: string;
    mediaType: MediaType;
    timeoutMs?: number;
}) => Promise<{
    mediaUrl: string;
    directPath: string;
    meta_hmac?: string;
    ts?: number;
    fbid?: number;
}>;

export interface WAUrlInfo {
    'canonical-url': string;
    'matched-text': string;
    title: string;
    description?: string;
    jpegThumbnail?: Buffer;
    highQualityThumbnail?: proto.Message.IImageMessage;
    originalThumbnailUrl?: string;
}

export type WAVersion = [number, number, number];

/* ------------------------------------------------------------------ */
/*  Public factory + auth helpers                                      */
/* ------------------------------------------------------------------ */

export function makeWASocket(config: UserFacingSocketConfig): WASocket
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
    logger?: ILogger,
    _cache?: CacheStore
): SignalKeyStore

export function makeInMemoryStore(
    config?: { logger?: ILogger; [k: string]: any }
): any





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
/**
 * Decode a JID into its parts.
 * Returns `undefined` when the string contains no '@' separator.
 */
export function jidDecode(jid: string | undefined): FullJid | undefined
export function jidEncode(
    jid: string,
    server: string,
    device?: number,
    agent?: number
): string
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
export const toBuffer: (stream: Readable) => Promise<Buffer>;
export function getContentType(message: WAMessageContent | undefined): keyof WAMessageContent | undefined
export const normalizeMessageContent: (content: WAMessageContent | null | undefined) => WAMessageContent | undefined;
export function downloadMediaMessage(
    message: WAMessage,
    type: 'buffer',
    options?: MediaDownloadOptions,
    ctx?: MediaDownloadCtx
): Promise<Buffer>
export function downloadMediaMessage(
    message: WAMessage,
    type: 'stream',
    options?: MediaDownloadOptions,
    ctx?: MediaDownloadCtx
): Promise<Transform>
export function downloadMediaMessage(
    message: WAMessage,
    type?: 'buffer' | 'stream',
    options?: MediaDownloadOptions,
    ctx?: MediaDownloadCtx
): Promise<Buffer | Transform>

/** context used by downloadMediaMessage to re-request media that expired */
export type MediaDownloadCtx = {
    logger: ILogger
    reuploadRequest: (msg: WAMessage) => Promise<WAMessage>
}

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

export const Browsers: BrowsersMap;
export const BufferJSON: {
    replacer: (k: any, value: any) => any;
    reviver: (_: any, value: any) => any;
};
export const CALL_VIDEO_PREFIX: string
export const Curve: {
    generateKeyPair: () => KeyPair;
    sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => Buffer;
    sign: (privateKey: Uint8Array, buf: Uint8Array) => Uint8Array;
    verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
};
export const DECRYPTION_RETRY_CONFIG: {
    maxRetries: number;
    baseDelayMs: number;
    sessionRecordErrors: string[];
};
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
export const MEDIA_KEYS: MediaType[];
export const MEDIA_PATH_MAP: {
    [T in MediaType]?: string;
};
export const META_AI_JID: string
export const MIN_PREKEY_COUNT: number
export const MIN_UPLOAD_INTERVAL: number
export const MISSING_KEYS_ERROR_TEXT: string
export const MexUpdatesOperations: { [key: string]: any }
export const NACK_REASONS: {
    SenderReachoutTimelocked: number;
    ParsingError: number;
    UnrecognizedStanza: number;
    UnrecognizedStanzaClass: number;
    UnrecognizedStanzaType: number;
    InvalidProtobuf: number;
    InvalidHostedCompanionStanza: number;
    MissingMessageSecret: number;
    SignalErrorOldCounter: number;
    MessageDeletedOnPeer: number;
    UnhandledError: number;
    UnsupportedAdminRevoke: number;
    UnsupportedLIDGroup: number;
    DBOperationFailed: number;
};
export const NOISE_MODE: string
export const NOISE_WA_HEADER: Buffer
export const OFFICIAL_BIZ_JID: string
export const PHONENUMBER_MCC: any
export const PHONE_CONNECTION_CB: string
export const PSA_WID: string
export const SERVER_JID: string
export const STORIES_JID: string
export const S_WHATSAPP_NET: string
export const UNAUTHORIZED_CODES: number[];
export const UPLOAD_TIMEOUT: number
export const URL_REGEX: RegExp;
export const WAJIDDomains: { [key: string]: any }
export const WA_ADV_ACCOUNT_SIG_PREFIX: Buffer
export const WA_ADV_DEVICE_SIG_PREFIX: Buffer
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX: Buffer
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX: Buffer
export const WA_CERT_DETAILS: {
    SERIAL: number;
    ISSUER: string;
    PUBLIC_KEY: Buffer;
};
export const WA_DEFAULT_EPHEMERAL: number
export const WEB_EVENTS: Event[];
export const WEB_GLOBALS: Global[];
export const addTransactionCapability: (state: SignalKeyStore, logger: ILogger, opts?: TransactionCapabilityOptions) => SignalKeyStoreWithTransaction;
export function aesDecrypt(buffer: Uint8Array, key: Uint8Array): Buffer;
export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer;
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array): Buffer;
export function aesDecryptWithIV(buffer: Uint8Array, key: Uint8Array, IV: Uint8Array): Buffer;
export function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer): Buffer;
export function aesEncrypt(buffer: Uint8Array, key: Uint8Array): Buffer;
export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer;
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array): Buffer;
export const aggregateMessageKeysNotFromMe: (keys: WAMessageKey[]) => {
    jid: string;
    participant: string | undefined;
    messageIds: string[];
}[];
export const areJidsSameUser: (jid1: string | undefined, jid2: string | undefined) => boolean;
export function asciiEncode(text: any): any
export const bindWaitForConnectionUpdate: (ev: BaileysEventEmitter) => (check: (u: Partial<ConnectionState>) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
export function bindWaitForEvent<T extends keyof BaileysEventMap>(ev: BaileysEventEmitter, event: T): (check: (u: BaileysEventMap[T]) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
export function buildBinding(username: any, integrityKey: any): any
export function bytesToCrockford(buffer: Buffer): string;
export function callKdf(callKey: any, label: any, len: any): any
export const chatModificationToAppPatch: (mod: ChatModification, jid: string) => WAPatchCreate;
export const cleanMessage: (message: WAMessage, meId: string, meLid: string) => void;
export const configureSuccessfulPairing: (stanza: BinaryNode, { advSecretKey, signedIdentityKey, signalIdentities }: Pick<AuthenticationCreds, "advSecretKey" | "signedIdentityKey" | "signalIdentities">) => {
    creds: Partial<AuthenticationCreds>;
    reply: BinaryNode;
};
export const createSignalIdentity: (wid: string, accountSignatureKey: Uint8Array) => SignalIdentity;
export const debouncedTimeout: (intervalMs?: number, task?: () => void) => {
    start: (newIntervalMs?: number, newTask?: () => void) => void;
    cancel: () => void;
    setTask: (newTask: () => void) => () => void;
    setInterval: (newInterval: number) => number;
};
export const decodeDecompressedBinaryNode: (buffer: Buffer, opts: Pick<BinaryNodeCodingOptions, "DOUBLE_BYTE_TOKENS" | "SINGLE_BYTE_TOKENS" | "TAGS">, indexRef?: {
    index: number;
}) => BinaryNode;
export const decodeMediaRetryNode: (node: BinaryNode) => {
    key: WAMessageKey;
    media?: {
        ciphertext: Uint8Array;
        iv: Uint8Array;
    };
    error?: Boom;
};
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string): {
    fullMessage: WAMessage;
    author: string;
    sender: string;
};
export const decodePatches: (name: WAPatchName, syncds: proto.ISyncdPatch[], initial: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, options: RequestInit, minimumVersionNumber?: number, logger?: ILogger, validateMacs?: boolean) => Promise<{
    state: LTHashState;
    mutationMap: ChatMutationMap;
}>;
export const decodeSyncdMutations: (msgMutations: (proto.ISyncdMutation | proto.ISyncdRecord)[], initialState: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, onMutation: (mutation: ChatMutation) => void, validateMacs: boolean) => Promise<{
    hash: Buffer;
    indexValueMap: {
        [indexMacBase64: string]: {
            valueMac: Uint8Array | Buffer;
        };
    };
}>;
export const decodeSyncdPatch: (msg: proto.ISyncdPatch, name: WAPatchName, initialState: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, onMutation: (mutation: ChatMutation) => void, validateMacs: boolean) => Promise<{
    hash: Buffer;
    indexValueMap: {
        [indexMacBase64: string]: {
            valueMac: Uint8Array | Buffer;
        };
    };
}>;
export const decodeSyncdSnapshot: (name: WAPatchName, snapshot: proto.ISyncdSnapshot, getAppStateSyncKey: FetchAppStateSyncKey, minimumVersionNumber: number | undefined, validateMacs?: boolean, logger?: ILogger) => Promise<{
    state: LTHashState;
    mutationMap: ChatMutationMap;
}>;
export const decompressingIfRequired: (buffer: Buffer) => Promise<Buffer>;
export function decryptComment(encPayload: any, encIv: any, commentCreatorJid: any, commentMsgId: any, commentEncKey: any, commentJid: any): any
export function decryptEventEdit(encPayload: any, encIv: any, eventCreatorJid: any, eventMsgId: any, eventEncKey: any, responderJid: any): any
export function decryptEventResponse({ encPayload, encIv }: proto.Message.IPollEncValue, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }: EventContext): proto.Message.EventResponseMessage;
export const decryptMediaRetryData: ({ ciphertext, iv }: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
}, mediaKey: Uint8Array, msgId: string) => proto.MediaRetryNotification;
export const decryptMessageNode: (stanza: BinaryNode, meId: string, meLid: string, repository: SignalRepositoryWithLIDStore, logger: ILogger) => {
    fullMessage: WAMessage;
    category: string | undefined;
    author: string;
    decrypt(): Promise<void>;
};
export function decryptPollVote({ encPayload, encIv }: proto.Message.IPollEncValue, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }: PollContext): proto.Message.PollVoteMessage;
export function decryptReaction(encPayload: any, encIv: any, reactionCreatorJid: any, reactionMsgId: any, reactionEncKey: any, reactionJid: any): any
export const delay: (ms: number) => Promise<void>;
export const delayCancellable: (ms: number) => {
    delay: Promise<void>;
    cancel: () => void;
};
export const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: proto.IPastParticipants[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
}>;
export const downloadContentFromMessage: ({ mediaKey, directPath, url }: DownloadableMessage, type: MediaType, opts?: MediaDownloadOptions) => Promise<Transform>;
export const downloadEncryptedContent: (downloadUrl: string, { cipherKey, iv }: MediaDecryptionKeyInfo, { startByte, endByte, options }?: MediaDownloadOptions) => Promise<Transform>;
export const downloadExternalBlob: (blob: proto.IExternalBlobReference, options: RequestInit) => Promise<Buffer>;
export const downloadExternalPatch: (blob: proto.IExternalBlobReference, options: RequestInit) => Promise<proto.SyncdMutations>;
export const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => Promise<proto.HistorySync>;
export const encodeBase64EncodedStringForUpload: (b64: string) => string;
export const encodeBigEndian: (e: number, t?: number) => Uint8Array<ArrayBuffer>;
export function encodeNewsletterMessage(message: proto.IMessage): Uint8Array;
export const encodeSyncdPatch: ({ type, index, syncAction, apiVersion, operation }: WAPatchCreate, myAppStateKeyId: string, state: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey) => Promise<{
    patch: proto.ISyncdPatch;
    state: LTHashState;
}>;
export const encodeWAMessage: (message: proto.IMessage) => Buffer;
export const encryptMediaRetryRequest: (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => BinaryNode;
export const encryptedStream: (media: WAMediaUpload, mediaType: MediaType, { logger, saveOriginalFileIfRequired, opts }?: EncryptedStreamOptions) => Promise<{
    mediaKey: Buffer;
    originalFilePath: string | undefined;
    encFilePath: string;
    mac: Buffer;
    fileEncSha256: Buffer;
    fileSha256: Buffer;
    fileLength: number;
}>;
export function extensionForMediaMessage(message: WAMessageContent): string;
export const extractAddressingContext: (stanza: BinaryNode) => {
    addressingMode: string;
    senderAlt: string | undefined;
    recipientAlt: string | undefined;
};
export function extractCandidates(offerNode: any): any
export const extractDeviceJids: (result: USyncQueryResultList[], myJid: string, myLid: string, excludeZeroDevices: boolean) => FullJid[];
export const extractImageThumb: (bufferOrFilePath: Readable | Buffer | string, width?: number) => Promise<{
    buffer: any;
    original: {
        width: any;
        height: any;
    };
}>;
export const extractMessageContent: (content: WAMessageContent | undefined | null) => WAMessageContent | undefined;
export const extractSyncdPatches: (result: BinaryNode, options: RequestInit) => Promise<{
    critical_unblock_low: {
        patches: proto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: proto.ISyncdSnapshot;
    };
    regular_high: {
        patches: proto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: proto.ISyncdSnapshot;
    };
    regular_low: {
        patches: proto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: proto.ISyncdSnapshot;
    };
    critical_block: {
        patches: proto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: proto.ISyncdSnapshot;
    };
    regular: {
        patches: proto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: proto.ISyncdSnapshot;
    };
}>;
export const extractUrlFromText: (text: string) => string | undefined;
export function extractVideoThumb(path: any, destPath: any, time: any, size: any): any
export const fetchLatestWaWebVersion: (options?: RequestInit) => Promise<{
    version: WAVersion;
    isLatest: boolean;
    error?: undefined;
} | {
    version: WAVersion;
    isLatest: boolean;
    error: unknown;
}>;
export function fromUnicodeEscape(escapedText: any): any
export const generateForwardMessageContent: (message: WAMessage, forceForward?: boolean) => proto.IMessage;
export const generateLinkPreviewIfRequired: (text: string, getUrlInfo: MessageGenerationOptions["getUrlInfo"], logger: MessageGenerationOptions["logger"]) => Promise<WAUrlInfo | undefined>;
export const generateLoginNode: (userJid: string, config: SocketConfig) => proto.IClientPayload;
export const generateMdTagPrefix: () => string;
export const generateOrGetPreKeys: (creds: AuthenticationCreds, range: number) => {
    newPreKeys: {
        [id: number]: KeyPair;
    };
    lastPreKeyId: number;
    preKeysRange: readonly [number, number];
};
export const generateParticipantHashV2: (participants: string[]) => string;
export const generateProfilePicture: (mediaUpload: WAMediaUpload, dimensions?: {
    width: number;
    height: number;
}) => Promise<{
    img: Buffer;
}>;
export const generateRegistrationId: () => number;
export const generateRegistrationNode: ({ registrationId, signedPreKey, signedIdentityKey }: SignalCreds, config: SocketConfig) => proto.ClientPayload;
export const generateSignalPubKey: (pubKey: Uint8Array | Buffer) => Uint8Array | Buffer;
export function generateThumbnail(file: string, mediaType: 'video' | 'image', options: {
    logger?: ILogger;
}): Promise<{
    thumbnail: string | undefined;
    originalImageDimensions: {
        width: number;
        height: number;
    } | undefined;
}>;
export const generateWAMessage: (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => Promise<WAMessage>;
export const generateWAMessageContent: (message: AnyMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>;
export const generateWAMessageFromContent: (jid: string, message: WAMessageContent, options: MessageGenerationOptionsFromContent) => WAMessage;
export function getAggregateResponsesInEventMessage({ eventResponses }: Pick<WAMessage, 'eventResponses'>, meId?: string): ResponseAggregation[];
export function getAggregateVotesInPollMessage({ message, pollUpdates }: Pick<WAMessage, 'pollUpdates' | 'message'>, meId?: string): VoteAggregation[];
export function getAudioDuration(buffer: Buffer | string | Readable): Promise<number | undefined>;
export function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger): Promise<Uint8Array<ArrayBuffer> | undefined>;
export function getBinaryFilteredBizBot(nodeContent: any): any
export function getBinaryFilteredButtons(nodeContent: any): any
export const getBinaryNodeChildUInt: (node: BinaryNode, childTag: string, length: number) => number | undefined;
export const getBinaryNodeMessages: ({ content }: BinaryNode) => proto.WebMessageInfo[];
export const getCallStatusFromNode: ({ tag, attrs }: BinaryNode) => WACallUpdateType;
export const getChatId: ({ remoteJid, participant, fromMe }: WAMessageKey) => string;
export const getCodeFromWSError: (error: Error) => number;
export const getDevice: (id: string) => "web" | "unknown" | "android" | "ios" | "desktop";
export const getErrorCodeFromStreamError: (node: BinaryNode) => {
    reason: string;
    statusCode: number;
};
export const getHttpStream: (url: string | URL, options?: RequestInit & {
    isStream?: true;
}) => Promise<Readable>;
export const getKeyAuthor: (key: WAMessageKey | undefined | null, meId?: string) => string;
export function getMediaKeys(buffer: Uint8Array | string | null | undefined, mediaType: MediaType): Promise<MediaDecryptionKeyInfo>;
export function getMediaRetryKey(mediaKey: any): any
export const getNextPreKeys: ({ creds, keys }: AuthenticationState, count: number) => Promise<{
    update: Partial<AuthenticationCreds>;
    preKeys: {
        [id: string]: KeyPair;
    };
}>;
export const getPreKeys: ({ get }: SignalKeyStore, min: number, limit: number) => Promise<{
    [id: string]: KeyPair;
}>;
export const getRawMediaUploadData: (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => Promise<{
    filePath: string;
    fileSha256: Buffer;
    fileLength: number;
}>;
export const getStatusCodeForMediaRetry: (code: number) => 200 | 412 | 404 | 418;
export const getStatusFromReceiptType: (type: string | undefined) => proto.WebMessageInfo.Status | undefined;
export const getStream: (item: WAMediaUpload, opts?: RequestInit & {
    maxContentLength?: number;
}) => Promise<{
    readonly stream: Readable;
    readonly type: "buffer";
} | {
    readonly stream: Readable;
    readonly type: "readable";
} | {
    readonly stream: Readable;
    readonly type: "remote";
} | {
    readonly stream: import("fs").ReadStream;
    readonly type: "file";
}>;
export const getUrlFromDirectPath: (directPath: string, host?: string) => string;
export const getWAUploadToServer: ({ customUploadHosts, fetchAgent, logger, options }: SocketConfig, refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>) => WAMediaUploadFunction;
export const hasNonNullishProperty: <K extends PropertyKey>(message: AnyMessageContent, key: K) => message is ExtractByKey<AnyMessageContent, K>;
export function hkdf(buffer: any, expandedLength: any, info: any): any
export const hkdfInfoKey: (type: MediaType) => string;
export function hmacSign(buffer: Buffer | Uint8Array, key: Buffer | Uint8Array, variant?: 'sha256' | 'sha512'): Buffer;
export const isHostedLidUser: (jid: string | undefined) => boolean | undefined;
export const isHostedPnUser: (jid: string | undefined) => boolean | undefined;
export const isRealMessage: (message: WAMessage) => boolean;
export const isWABusinessPlatform: (platform: string) => platform is "smba" | "smbi";
export function md5(buffer: any): any
export const mediaMessageSHA256B64: (message: WAMessageContent) => string | null | undefined;
export function mutationKeys(keydata: any): any
export const newLTHashState: () => LTHashState;
export const parseAndInjectE2ESessions: (node: BinaryNode, repository: SignalRepositoryWithLIDStore) => Promise<void>;
export function parseStun(buf: any): any
export function prepareAlbumMessageContent(jid: any, albums: any, options: any): any
export const prepareDisappearingMessageSettingContent: (ephemeralExpiration?: number) => proto.Message;
export const prepareWAMessageMedia: (message: AnyMediaMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>;
export function printQRIfNecessaryListener(ev: any, logger: any): any
export const processHistoryMessage: (item: proto.IHistorySync, logger?: ILogger) => {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: proto.IPastParticipants[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
};
export function promiseTimeout<T>(ms: number | undefined, promise: (resolve: (v: T) => void, reject: (error: any) => void) => void): Promise<T>;
export const reduceBinaryNodeToDictionary: (node: BinaryNode, tag: string) => {
    [_: string]: string;
};
export function resolveVideoPreset(name: any): any
export function sha256(buffer: Buffer): Buffer;
export const shouldIncrementChatUnread: (message: WAMessage) => boolean;
export const signedKeyPair: (identityKeyPair: KeyPair, keyId: number) => {
    keyPair: KeyPair;
    signature: Uint8Array;
    keyId: number;
};
export const toNumber: (t: Long | number | null | undefined) => number;
export const toReadable: (buffer: Buffer) => Readable;
export function toUnicodeEscape(text: any): any
export const transferDevice: (fromJid: string, toJid: string) => string;
export function trimUndefined(obj: {
    [_: string]: any;
}): {
    [_: string]: any;
};
export const unixTimestampSeconds: (date?: Date) => number;
export const unpadRandomMax16: (e: Uint8Array | Buffer) => Uint8Array<ArrayBuffer>;
export const updateMessageWithEventResponse: (msg: Pick<WAMessage, "eventResponses">, update: proto.IEventResponse) => void;
export const updateMessageWithPollUpdate: (msg: Pick<WAMessage, "pollUpdates">, update: proto.IPollUpdate) => void;
export const updateMessageWithReaction: (msg: Pick<WAMessage, "reactions">, reaction: proto.IReaction) => void;
export const updateMessageWithReceipt: (msg: Pick<WAMessage, "userReceipt">, receipt: MessageUserReceipt) => void;
export const uploadWithNodeHttp: ({ url, filePath, headers, timeoutMs, agent }: UploadParams, redirectCount?: number) => Promise<MediaUploadResult | undefined>;
export function waChatKey(pin: any): any
export const waLabelAssociationKey: { [key: string]: any }
export function waMessageID(m: any): any
export const writeRandomPadMax16: (msg: Uint8Array) => Buffer;
export const xmppPreKey: (pair: KeyPair, id: number) => BinaryNode;
export const xmppSignedPreKey: (key: SignedKeyPair) => BinaryNode;

/* ------------------------------------------------------------------ */
/*  Re-exported secondary API (utils, constants, protocols)            */
/*  Typed permissively so every package export is importable & callable.*/
/* ------------------------------------------------------------------ */

export const CALL_AUDIO_PREFIX: string
export const DEFAULT_CACHE_TTLS: {
    SIGNAL_STORE: number;
    MSG_RETRY: number;
    CALL_OFFER: number;
    USER_DEVICES: number;
};
export const DEFAULT_CONNECTION_CONFIG: SocketConfig;
export const FLAG_EXTENDED: number
export const LT_HASH_ANTI_TAMPERING: LTHashAntiTampering;
export const MEDIA_HKDF_KEY_MAPPING: {
    audio: string;
    document: string;
    gif: string;
    image: string;
    ppic: string;
    product: string;
    ptt: string;
    sticker: string;
    video: string;
    'thumbnail-document': string;
    'thumbnail-image': string;
    'thumbnail-video': string;
    'thumbnail-link': string;
    'md-msg-hist': string;
    'md-app-state': string;
    'product-catalog-image': string;
    'payment-bg-image': string;
    ptv: string;
    'biz-cover-photo': string;
};
export const MEDIA_RETRY_STATUS_MAP: { [key: string]: any }
export class MessageRetryManager {
    private logger;
    private recentMessagesMap;
    private messageKeyIndex;
    private sessionRecreateHistory;
    private retryCounters;
    private baseKeys;
    private pendingPhoneRequests;
    private readonly maxMsgRetryCount;
    private statistics;
    constructor(logger: ILogger, maxMsgRetryCount: number);
    /**
     * Add a recent message to the cache for retry handling
     */
    addRecentMessage(to: string, id: string, message: proto.IMessage): void;
    /**
     * Get a recent message from the cache
     */
    getRecentMessage(to: string, id: string): RecentMessage | undefined;
    /**
     * Check if a session should be recreated based on retry count, history, and error code.
     * MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout.
     */
    shouldRecreateSession(jid: string, hasSession: boolean, errorCode?: RetryReason): {
        reason: string;
        recreate: boolean;
    };
    /**
     * Parse error code from retry receipt's retry node.
     * Returns undefined if no error code is present.
     */
    parseRetryErrorCode(errorAttr: string | undefined): RetryReason | undefined;
    /**
     * Check if an error code indicates a MAC failure
     */
    isMacError(errorCode: RetryReason | undefined): boolean;
    /**
     * Increment retry counter for a message
     */
    incrementRetryCount(messageId: string): number;
    /**
     * Get retry count for a message
     */
    getRetryCount(messageId: string): number;
    /**
     * Check if message has exceeded maximum retry attempts
     */
    hasExceededMaxRetries(messageId: string): boolean;
    /**
     * Mark retry as successful
     */
    markRetrySuccess(messageId: string): void;
    /**
     * Mark retry as failed
     */
    markRetryFailed(messageId: string): void;
    /**
     * Schedule a phone request with delay
     */
    schedulePhoneRequest(messageId: string, callback: () => void, delay?: number): void;
    /**
     * Cancel pending phone request
     */
    cancelPendingPhoneRequest(messageId: string): void;
    clear(): void;
    saveBaseKey(addr: string, msgId: string, baseKey: Uint8Array): void;
    hasSameBaseKey(addr: string, msgId: string, baseKey: Uint8Array): boolean;
    deleteBaseKey(addr: string, msgId: string): void;
    private keyToString;
    private removeRecentMessage;
}
export const NO_MESSAGE_FOUND_ERROR_TEXT: string
export class ObjectRepository { constructor(...args: any[]); [key: string]: any }
export const PROCESSABLE_HISTORY_TYPES: proto.HistorySync.HistorySyncType[];
export const XWAPathsMexUpdates: { [key: string]: any }
export function asciiDecode(codes: any): any
export const assertMediaContent: (content: proto.IMessage | null | undefined) => proto.Message.IVideoMessage | proto.Message.IImageMessage | proto.Message.IAudioMessage | proto.Message.IDocumentMessage | proto.Message.IStickerMessage;
export function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i?: number): string;
export function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer>;
export const encodeSignedDeviceIdentity: (account: proto.IADVSignedDeviceIdentity, includeSignatureKey: boolean) => Uint8Array;
export const encodeWAM: (binaryInfo: BinaryInfo) => Buffer;
export const getHistoryMsg: (message: proto.IMessage) => proto.Message.IHistorySyncNotification;
export const getNextPreKeysNode: (state: AuthenticationState, count: number) => Promise<{
    update: Partial<AuthenticationCreds>;
    node: BinaryNode;
}>;
export const getPlatformId: (browser: string) => string;
export const getServerFromDomainType: (initialServer: string, domainType?: number) => JidServer;
export const getUrlInfo: (text: string, opts?: URLGenerationOptions) => Promise<WAUrlInfo | undefined>;
export const initAuthCreds: () => AuthenticationCreds;
export function makeCacheManagerAuthState(store: any, sessionKey: any): any
export const makeEventBuffer: (logger: ILogger) => BaileysBufferableEventEmitter;
export const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }: {
    keyPair: KeyPair;
    NOISE_HEADER: Uint8Array;
    logger: ILogger;
    routingInfo?: Buffer | undefined;
}) => {
    encrypt: (plaintext: Uint8Array) => Uint8Array;
    decrypt: (ciphertext: Uint8Array) => Uint8Array;
    authenticate: (data: Uint8Array) => void;
    mixIntoKey: (data: Uint8Array) => void;
    finishInit: () => Promise<void>;
    processHandshake: ({ serverHello }: proto.HandshakeMessage, noiseKey: KeyPair) => Uint8Array;
    encodeFrame: (data: Buffer | Uint8Array) => Buffer;
    decodeFrame: (newData: Buffer | Uint8Array, onFrame: (buff: Uint8Array | BinaryNode) => void) => Promise<void>;
};
export function makeOrderedDictionary(idGetter: any): any
export function processMessage(message: any, shouldProcessHistoryMsg: any, placeholderResendCache: any, ev: any, creds: any, signalRepository: any, keyStore: any, logger: any, options: any, getMessage: any): any
export const processSyncAction: (syncAction: ChatMutation, ev: BaileysEventEmitter, me: Contact, initialSyncOpts?: InitialAppStateSyncOptions, logger?: ILogger) => void;
