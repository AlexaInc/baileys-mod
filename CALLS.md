# Call support (voice calls + media streaming)

> Part of **[@alexainc/baileys-mod](https://github.com/Alexainc/baileys-mod)** — author: **hansaka@alexainc**

This library adds first-class WhatsApp **call media** support directly in the
source. No external module — the API is part of the socket.

## API

```js
sock.ev.on('call', async (calls) => {
  for (const call of calls) {
    if (call.status === 'offer') {
      console.log('incoming call from', call.from)
      console.log('decrypted media key:', call.callKeyHex)  // 32-byte callKey

      // 1) accept (signaling)
      await sock.acceptCall(call.id, call.from)

      // 2) connect the UDP/ICE media transport and stream audio
      const session = await sock.connectCall(call.id, call.from, 'welcome.mp3')

      // inbound media frames (SRTP/RTP)
      session.on('rtp', ({ data, from }) => { /* decode if needed */ })
    }

    if (['terminate','reject','timeout'].includes(call.status)) {
      sock.stopCallMedia(call.id)
    }
  }
})
```

### Methods (on the socket)

| Method | Description |
|---|---|
| `acceptCall(callId, callFrom)` | Send `<accept>` and share a media callKey. |
| `rejectCall(callId, callFrom)` | Decline a call. |
| `terminateCall(callId, callFrom, reason?)` | Hang up / cancel. |
| `offerCall(toJid, isVideo?)` | Place an outgoing call. |
| `decryptCallKey(offerNode, callFrom)` | Decrypt the 32-byte media key. |
| `connectCall(callId, callFrom, audioInput?, opts?)` | Open UDP/ICE transport, optionally stream audio. Returns a `WACallMediaSession`. |
| `getCallMediaSession(callId)` | Get the live session. |
| `stopCallMedia(callId)` | Tear down the transport. |
| `getCallInfo(groupJid, opts?)` | Get an ongoing **group voice chat** by JID (pytgcalls `get_group_call`). |
| `getActiveGroupCalls()` | List all discovered active group calls. |
| `joinGroupCall(groupJid, audioInput?, opts?)` | Join a group voice chat + stream audio (pytgcalls `join_group_call`). |

### `call` event extras (on `offer`)

- `call.offerNode` — raw offer node.
- `call.callKey` / `call.callKeyHex` — decrypted media key.

## Group calls / music-stream bots (pytgcalls style)

Join an **ongoing group voice chat by JID** — no call invite required — the same
way `pytgcalls`/`ntgcalls` expose `get_group_call` + `join_group_call`:

```js
// one-shot: discover the group call, join it, and stream audio
const session = await sock.joinGroupCall('123456789-987654@g.us', 'song.mp3')

// or do it in two steps
const info = await sock.getCallInfo('123456789-987654@g.us')
// => { callId, callCreator, callKeyHex, groupJid, source: 'cache' | 'query', ... }
if (info?.callId) {
  await sock.acceptCall(info.callId, info.callCreator)
  await sock.connectCall(info.callId, info.callCreator, 'song.mp3')
}

// list everything currently active
console.log(sock.getActiveGroupCalls())
```

**How discovery works**

1. **Passive cache** — whenever the bot (being a member of the group) observes a
   group-call `offer`/`offer_notice`, it is indexed by `groupJid` in an internal
   registry. `getCallInfo(jid)` returns it instantly. This is the most reliable
   path and mirrors how pytgcalls tracks active chats.
2. **Active query** — if nothing is cached, `getCallInfo` queries WhatsApp's
   `@call` endpoint for the group's current call state and returns the raw
   response under `.raw` plus any `callId`/`callCreator` it can extract.

> **Note for publishers:** WhatsApp's group-call query/response node shape isn't
> publicly documented and varies by client version. The passive-cache path is
> solid; the active `@call` query is best-effort — inspect `info.raw` and adjust
> the query/parse in `getCallInfo` to match what your WA version returns. The
> media transport after join is identical to 1:1 calls.

### `WACallMediaSession` events & methods

```js
session.on('connected', (pair) => {})         // ICE pair selected {ip, port}
session.on('rtp', ({ data, from }) => {})     // inbound media packet
session.on('trackEnd', ({ kind, skipped }) => {}) // 'audio'|'video' finished/skipped
session.on('closed', () => {})                // transport torn down

// audio (custom quality optional)
session.streamAudio(input, { codec, bitrate, sampleRate, channels, frameDuration })
session.stopAudio()         // stop current audio track WITHOUT leaving the call

// video (custom quality optional; preset or explicit dims)
session.streamVideo(input, { preset: '720p' })
session.streamVideo(input, { codec, bitrate, width, height, fps })
session.stopVideo()         // stop current video track

// both at once from one file
session.streamMedia(input, { audio: {...}, video: { preset: '480p' } })
session.close()             // leave the call / tear down transport
```

## Example: music bot

A complete, runnable group music bot with a per-group queue is in
[`examples/music-bot.js`](examples/music-bot.js):

```
!play <url|file>   queue a track; joins the voice chat if needed
!skip              skip the current track
!stop              stop, clear queue, leave the voice chat
!queue             show the queue
!ping              health check
```

```bash
node examples/music-bot.js                       # QR login
WA_NUMBER=94XXXXXXXXX node examples/music-bot.js --pairing
```

It uses `getCallInfo` → `joinGroupCall` → `streamAudio`, advancing the queue on
the `trackEnd` event — exactly the pytgcalls/ntgcalls bot pattern.

## How media works

WhatsApp calls use **ICE over UDP**:

1. The offer carries transport **candidates** (host / srflx / relay).
2. We run STUN binding connectivity checks; when both peers are reachable,
   media flows **directly device-to-device** (the peer IP you see while
   monitoring), otherwise via WhatsApp **relay** candidates.
3. Audio is **Opus over RTP**, payload-encrypted (SRTP-style, AES-CTR) using
   keys derived from the call's media key.
4. `connectCall(...)` runs FFmpeg to transcode any input (`file`, URL, pipe,
   device) to Opus 48k and pumps 20 ms RTP packets to the selected peer.

Implementation: [`lib/Utils/call-media.js`](lib/Utils/call-media.js)
(`WACallMediaSession`, `extractCandidates`, `callKdf`, `buildBinding`,
`parseStun`). The transport (UDP sockets, ICE binding, RTP framing, SRTP, Opus
pump) is implemented and unit-tested over loopback.

> **Crypto KDF note:** the media-key derivation labels in `callKdf()` are the
> integration point. If the relay rejects the binding or audio doesn't decode on
> the peer, adjust the derivation labels / SRTP layout to match the observed
> handshake. Everything else is concrete.

## Requirements

- `ffmpeg` on `PATH` (for `streamAudio`/`streamVideo`/`connectCall`).

## Custom qualities (pytgcalls style)

Pass a `quality` object to override any FFmpeg parameter. Audio defaults:
`{ codec:'libopus', bitrate:'32k', sampleRate:48000, channels:1, frameDuration:20 }`.
Video defaults: `{ codec:'libvpx', bitrate:'500k', width:640, height:360, fps:30 }`,
or use a named `preset`: `144p`, `240p`, `360p`, `480p`, `720p`, `1080p`.

```js
// high-quality stereo audio
session.streamAudio('song.flac', { bitrate: '128k', channels: 2 })

// 720p 30fps video at 1.5 Mbps
session.streamVideo('clip.mp4', { preset: '720p', bitrate: '1500k', fps: 30 })

// connectCall / joinGroupCall accept the same options:
await sock.connectCall(callId, callFrom,
  { audio: 'song.mp3', video: 'clip.mp4', videoQuality: { preset: '480p' } })

await sock.joinGroupCall(groupJid, 'song.mp3',
  { audioQuality: { bitrate: '64k' }, videoInput: 'clip.mp4', videoQuality: { preset: '360p' } })
```

Audio and video are separate RTP streams (Opus PT 111 / VP8 PT 96) with
independent SSRCs, so you can start/stop each independently.

## ⚠️ Note

Automating calls can get a number banned. Test with a throwaway number.
