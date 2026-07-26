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

      // 1) accept (signaling). Sends <preaccept> then <accept>, and returns
      //    the call's REAL media key (the one the caller minted).
      const { callKey, callKeyHex } = await sock.acceptCall(call.id, call.from)

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

### The media key comes from the caller — you never generate it

A WhatsApp call has exactly **one** media key. The **caller** mints it and ships
it to each of the callee's devices inside the offer's `<enc>` node (a Signal
ciphertext wrapping `proto.Message.call.callKey`). The callee decrypts it — it
must never invent its own.

`acceptCall` therefore returns the decrypted offer key:

```js
const res = await sock.acceptCall(call.id, call.from)
res.callKey       // Buffer(32) | null   <- the real key
res.callKeyHex    // hex string   | null
res.isVideo       // answered as video?
```

`callKey` is `null` only when the offer was never observed (e.g. the process
restarted mid-call) or its `<enc>` could not be decrypted with any known Signal
session. Signaling is still sent in that case, but media cannot be decrypted.

The same key is attached to the `call` event and is carried onto **every**
subsequent event for that call (`ringing`, `preaccept`, `accept`, `transport`),
so you can read `call.callKeyHex` at any point in the call's lifetime.

### `acceptCall(callId, callFrom, opts?)`

| Option | Default | Meaning |
|---|---|---|
| `isVideo` | the offer's own type | answer as a video call |
| `preaccept` | `true` | send `<preaccept>` before `<accept>`, like a real client |

Real clients send `<preaccept>` the moment the call is displayed, *before*
`<accept>`. It is what makes the caller start sending media candidates, so
skipping it is a common reason an accept "succeeds" but no audio ever flows.

### Methods (on the socket)

| Method | Description |
|---|---|
| `acceptCall(callId, callFrom, opts?)` | Answer a call (`<preaccept>` + `<accept>`); returns the caller's real media key. |
| `preacceptCall(callId, callFrom, isVideo?)` | Send `<preaccept>` on its own ("I'm ringing"). |
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

1. The offer carries transport **candidates**. They are **not** `ip=`/`port=`
   attributes — WhatsApp packs each endpoint as raw big-endian bytes in the
   node's *content*:

   | Node | Meaning | Payload |
   |---|---|---|
   | `<rte>` | the peer's own reflexive endpoint (direct P2P) | 6 B = IPv4 + port |
   | `<te2>` / `<te>` inside `<relay>` | Meta relay servers | 6 B v4, or 18 B = IPv6 + port |
   | `<relay><token>` | relay auth token | opaque blob |

   For example `te2` = `nfAJMw2W` (base64) decodes to
   `9d f0 09 33 0d 96` → **157.240.9.51:3478**, and
   `KgMogPIoAMP6zrAMAAABdw2W` → **[2a03:2880:f228:c3:face:b00c:0:177]:3478**.

   `extractCandidates()` parses both this binary form and the attribute form,
   preferring `rte` (direct) over relays and IPv4 over IPv6.
2. We run STUN binding connectivity checks (**retransmitted** every 300 ms,
   since single-shot UDP checks against a relay are routinely lost); when both
   peers are reachable, media flows **directly device-to-device**, otherwise via
   WhatsApp **relay** candidates. The `<relay><token>` is attached to the
   binding request.
3. Audio is **Opus over RTP**, payload-encrypted (SRTP-style, AES-CTR) using
   keys derived from the call's media key.
4. `connectCall(...)` runs FFmpeg to transcode any input (`file`, URL, pipe,
   device) to Opus 48k and pumps 20 ms RTP packets to the selected peer.
   FFmpeg emits **Ogg**, which is demuxed so that each RTP payload is exactly
   one Opus frame — slicing the raw byte stream into fixed-size chunks (as a
   naive implementation does) cuts through frame boundaries and produces audio
   no decoder can read.

Implementation: [`lib/Utils/call-media.js`](lib/Utils/call-media.js)
(`WACallMediaSession`, `extractCandidates`, `callKdf`, `buildBinding`,
`parseStun`). The transport (UDP sockets, ICE binding, RTP framing, SRTP, Opus
pump) is implemented and unit-tested over loopback.

### What is verified, and what still isn't

**Verified** (covered by `tests/call.test.js`, 17 tests):

- signaling: `<preaccept>` → `<accept>` stanza shape, LID/PN self-addressing,
  acking malformed call nodes;
- the media key is decrypted from the offer's `<enc>` (unpadded, then
  `proto.Message.call.callKey`) and returned by `acceptCall`;
- candidate parsing against **real captured** `te2`/`rte` payloads;
- ICE binding + retransmission and RTP delivery against a mock relay over
  loopback, including SRTP round-trip;
- the Ogg→Opus demuxer yields byte-exact frames.

> **Still unverified — the SRTP KDF.** The derivation labels in `callKdf()`
> (`"WhatsApp Call SRTP"` / `"Call Salt"` / `"Call ICE"`) are **educated
> guesses**, not recovered from WhatsApp's client. Everything up to and
> including "packets reach the peer" is confirmed, but a real WhatsApp endpoint
> will not be able to *decode* our audio until those labels match theirs. That
> requires reading the derivation out of WhatsApp's own VoIP code.
>
> If you need guaranteed-correct media today, the only known-working approach is
> to drive WhatsApp Web's official VoIP WASM stack in-process (as
> [`baileys-caller`](https://github.com/SheIITear/baileys-caller) does) instead
> of reimplementing SRTP.

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
