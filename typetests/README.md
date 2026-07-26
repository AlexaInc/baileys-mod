# Type definition verification

Checks that `types.d.ts` matches what `lib/` **actually does at runtime**.
Nothing here modifies library source.

Run everything:

```bash
./verify_all.sh
```

## What is checked

| # | Check | How |
|---|-------|-----|
| 1 | `types.d.ts` compiles under `--strict` | `tsc --noEmit --strict` |
| 2 | Realistic consumer code compiles | `typetests/0*.ts` |
| 3 | Wrong code is *rejected* | `typetests/negative/neg.ts` (31 `@ts-expect-error`) |
| 4 | Every declared value exists at runtime, and every runtime export is typed | reflection over `require('./lib')` |
| 5 | Functions actually return what they declare | `typetests/runtime/assert.cjs` |
| 6 | `lib/` untouched | `git status` |

## Runtime harnesses

- `runtime/assert.cjs` — 22 behavioural assertions (return types, ghost members).
- `runtime/drive-handlers.cjs` — feeds authentic protobuf/binary-node payloads
  through the real handlers (history sync, content types, reactions, receipts,
  binary round-trip) and prints the objects the library really produces.
- `runtime/drive-appstate.cjs` — app-state patches, `processSyncAction`
  emissions, call stanzas and event-buffer consolidation.
- `runtime/live-connect.cjs` — connects to the real WhatsApp endpoint.

### Note on the live test

`live-connect.cjs` reaches `web.whatsapp.com` but the CI sandbox allowlists
only npm, so TLS is reset and pairing cannot complete. It still drives the
connection lifecycle and confirmed:

- `connection.update` emits `receivedPendingNotifications`
- `lastDisconnect.error` is a **Boom** — `error.output.statusCode` (408)
  matches `DisconnectReason`, and `date` is a real `Date`

To fully validate the paired-session paths (`messages.upsert` from a real
chat, live `messaging-history.set` contents, newsletter/business IQ replies),
run it on a machine with unrestricted network access and scan the QR:

```bash
node typetests/runtime/live-connect.cjs
```
