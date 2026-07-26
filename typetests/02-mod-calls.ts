/** Emulation 2: [MOD] call/media API + groups/privacy/messaging. */
import makeWASocket, {
    getBinaryNodeChild, type WASocket, type WACallEvent, type BinaryNode,
    type GroupMetadata, type GroupParticipant, type WAMessage,
    type WAPrivacyValue, type WAMediaUpload, type WAReadReceiptsValue
} from '@alexainc/baileys-mod'

async function modFeatures(sock: WASocket, jid: string, msg: WAMessage) {
    sock.ev.on('call', async (calls: WACallEvent[]) => {
        for (const call of calls) {
            console.log(call.chatId, call.from, call.status, call.isVideo, call.offline, call.date.getTime())
            if (call.status === 'offer') {
                const node: BinaryNode | undefined = call.offerNode
                if (node) console.log(node.tag, node.attrs['call-id'], !!getBinaryNodeChild(node, 'enc'))
                if (call.callKey) console.log(call.callKey.length, call.callKeyHex)
                console.log(await sock.getCallInfo(call.id))
                await sock.acceptCall(call.id, call.from)
                const session = await sock.connectCall(call.id, call.from)
                console.log(session)
                await sock.stopCallMedia(call.id)
                await sock.terminateCall(call.id, call.from)
            }
        }
    })
    await sock.offerCall(jid, true)
    console.log(await sock.getActiveGroupCalls())
    await sock.joinGroupCall(jid)
    console.log(sock.getCallMediaSession('id'))

    const meta: GroupMetadata = await sock.groupMetadata(jid)
    const parts: GroupParticipant[] = meta.participants
    console.log(meta.subject, meta.owner, meta.announce, meta.restrict, meta.isCommunity, meta.joinApprovalMode)
    console.log(parts.map(p => `${p.id}:${p.admin}:${p.lid}`))

    await sock.groupParticipantsUpdate(jid, ['1@s.whatsapp.net'], 'promote')
    await sock.groupUpdateSubject(jid, 's')
    await sock.groupSettingUpdate(jid, 'announcement')
    console.log(await sock.groupInviteCode(jid))
    await sock.groupLeave(jid)
    await sock.sendStatusMentions({ text: 'status' }, [jid])

    const priv: WAPrivacyValue = 'contacts'
    const rr: WAReadReceiptsValue = 'all'
    await sock.updateLastSeenPrivacy(priv)
    await sock.updateReadReceiptsPrivacy(rr)
    await sock.updateProfileStatus('busy')
    const media: WAMediaUpload = { url: './pp.jpg' }
    await sock.updateProfilePicture(jid, media)
    await sock.removeProfilePicture(jid)
    console.log(await sock.profilePictureUrl(jid))

    await sock.presenceSubscribe(jid)
    await sock.chatModify({ archive: true, lastMessages: [msg] }, jid)
    await sock.readMessages([msg.key])
    await sock.sendMessage(jid, { text: 'hi' })
    await sock.sendMessage(jid, { delete: msg.key })
    await sock.sendMessage(jid, { react: { text: 'x', key: msg.key } })
    await sock.sendMessage(jid, { poll: { name: 'p', values: ['a'] } })
    await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id! })

    const [res] = await sock.onWhatsApp('94770000000')
    console.log(res?.exists, res?.jid)
    console.log(await sock.getBusinessProfile(jid))
    console.log(await sock.getLidUser(jid))

    // signatures corrected in pass 2
    await sock.logout('bye')
    sock.end(new Error('done'))
    console.log(await sock.requestPairingCode('94770000000', 'ABCD1234'))
    await sock.cleanDirtyBits('account_sync', 123)
    await sock.createCallLink('video', { startTime: 1 }, 5000)
    await sock.waitForConnectionUpdate(u => u.connection === 'open', 5000)
}
export { modFeatures }
