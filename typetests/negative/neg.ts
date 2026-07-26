/** Every statement below MUST be a compile error. */
import makeWASocket, {
    useMultiFileAuthState, jidDecode, getContentType, DisconnectReason,
    MessageRetryManager, WA_CERT_DETAILS, NACK_REASONS, buildBinding, getDevice,
    type WASocket, type WACallEvent, type GroupMetadata, type Product,
    type AuthenticationCreds
} from '@alexainc/baileys-mod'

declare const sock: WASocket
declare const jid: string

// @ts-expect-error - auth is required
makeWASocket({})
// @ts-expect-error - browser must be a 3-tuple
makeWASocket({ auth: {} as any, browser: 'Chrome' })
// @ts-expect-error - not a valid privacy value
sock.updateLastSeenPrivacy('everyone')
// @ts-expect-error - not a WAReadReceiptsValue
sock.updateReadReceiptsPrivacy('sometimes')
// @ts-expect-error - needs content object
sock.sendMessage(jid, 'hello')
// @ts-expect-error - unknown participant action
sock.groupParticipantsUpdate(jid, [jid], 'banish')
// @ts-expect-error - returns GroupMetadata
const meta: string = await sock.groupMetadata(jid)
// @ts-expect-error - takes an array of keys
sock.readMessages(jid)
// @ts-expect-error - removeProfilePicture requires a jid
sock.removeProfilePicture()
// @ts-expect-error - profilePictureUrl takes one arg in this build
sock.profilePictureUrl(jid, 'image')
// @ts-expect-error - DisconnectReason members are numbers
const dr: string = DisconnectReason.loggedOut
// @ts-expect-error - returns keyof WAMessageContent
const ct: number = getContentType(undefined)
// @ts-expect-error - cleanDirtyBits type must be a known literal
sock.cleanDirtyBits('nonsense')
// @ts-expect-error - createCallLink type must be audio|video
sock.createCallLink('hologram')
// @ts-expect-error - sendReceipts needs (keys, type)
sock.sendReceipts([{ id: 'x' }])

declare const gm: GroupMetadata
// @ts-expect-error - GroupMetadata is closed (no catch-all)
gm.totallyNotAField.foo
declare const p: Product
// @ts-expect-error - price is a number
const price: string = p.price
// @ts-expect-error - 'call' delivers an array
sock.ev.on('call', (c: WACallEvent) => console.log(c.status))
// @ts-expect-error - not a real event
sock.ev.on('definitely.not.an.event', () => {})
// @ts-expect-error - folder required
useMultiFileAuthState()

/* --- pass-2 regressions these MUST keep catching --- */
declare const mrm: MessageRetryManager
// @ts-expect-error - does not exist in this build
mrm.parseRetryErrorCode('4')
// @ts-expect-error - does not exist in this build
mrm.saveBaseKey('a', 'b', new Uint8Array())
// @ts-expect-error - does not exist in this build
mrm.clear()
// @ts-expect-error - WA_CERT_DETAILS only has SERIAL in this build
const iss = WA_CERT_DETAILS.ISSUER
// @ts-expect-error - not present in this build
const srt = NACK_REASONS.SenderReachoutTimelocked
// @ts-expect-error - buildBinding returns {packet,txId}, not Buffer
const bb: Buffer = buildBinding()
// @ts-expect-error - fallback is 'baileys', 'unknown' is not in the union
const dv: 'unknown' = getDevice('zz')
declare const creds: AuthenticationCreds
// @ts-expect-error - noiseKey is a KeyPair, not a string
const nk: string = creds.noiseKey
// @ts-expect-error - jidDecode can return undefined
const u: string = jidDecode(jid).user

export {}
