# Sinos mobile relay

Cloudflare Worker + SQLite Durable Object + the standalone phone web app.
The desktop opens an outbound WebSocket; no inbound port or Tailscale is
required. Each paired device has its own room and revocable credentials.
NaCl box exchanges the content key; all workspace RPC frames use AES-256-GCM.
The relay stores pairing metadata and forwards ciphertext, without receiving
the content key. This is derived from EnsoCode (see `../third-party/`).

## Build and check

```sh
npm ci --prefix ../src-ui
npm ci
npm run typecheck
npm test
npm run build:phone
npm run deploy:check
```

## Local integration

Run `npm run dev` in this directory, then `npm run test:integration` in another
terminal. It checks the real Workers runtime on `127.0.0.1:8788`, including
one-time claims, invitation ownership, encryption, heartbeat and revocation.
Only debug desktop builds accept a loopback HTTP relay URL.

For browser review with disposable data, build the phone frontend and start
`node src-ui/scripts/mobile-preview.mjs` from the repository root. Start
`npx tsx test/preview-host.ts` here, then open the printed local pairing link.
That simulator forwards requests only to the loopback fixture server.

## Deploy

The current deployment is `https://sinos-relay.zhlhopefil.workers.dev`.
The desktop uses this origin by default. The Worker serves both the phone UI
and `/v1/` pairing/WebSocket endpoints; `/v1/health` reports its protocol.

The Worker was renamed in place from `coffee-relay` to `sinos-relay`.
Use the current origin for new invitations. Browsers paired on the previous
origin must pair again because browser credentials are scoped to their origin.

## Pair a phone

In desktop Settings → Mobile, choose Connect new device. Either scan the QR
code, open the copied HTTPS invitation link on the phone, or paste the link
into the phone landing page. These methods use the same single-use invitation,
which expires after 60 seconds. Pairing is required once per browser/device;
later visits reconnect using saved credentials while the desktop is running.
Clearing browser storage or revoking the device requires a new pairing.

## Publish changes

```sh
npx wrangler login
npm run deploy
```

Deployment uploads `../src-ui/dist-phone` and provisions the `PairRoom` binding
using the migration in `wrangler.jsonc`. The returned `workers.dev` HTTPS origin
can be pasted into desktop Settings → Mobile → Relay settings immediately.
To use your own domain, add a Cloudflare custom domain route to the config:

```json
"routes": [{ "pattern": "relay.example.com", "custom_domain": true }]
```

Keep `workers_dev: true` while previously paired devices still use that origin.
Changing the relay origin requires a new pairing. Do not point Sinos clients
at EnsoCode's production service: the Sinos RPC protocol and invitation-owner
authentication are intentionally separate.

To verify an existing deployment with disposable credentials:

```powershell
$env:RELAY_TEST_URL = 'https://sinos-relay.zhlhopefil.workers.dev'
npm run test:integration
```

The test creates and revokes its own pairing without touching real devices.

For a browser smoke test through a deployed relay, run the loopback UI fixture
as described above, then start `test/preview-host.ts` with `RELAY_TEST_URL` set.
Set `RELAY_FIXTURE_LARGE=1` to exercise a 512 KiB file whose JSON response is
larger than one WebSocket frame. Type `quit` in its interactive terminal when
finished; the simulator also revokes its disposable pairing after five minutes.

## Connection and payload behavior

- Cancelling or replacing an invitation invalidates it at the relay. Polling
  cannot recreate it. A claim accepted just before expiry can still be fetched
  by the desktop during the bounded credential retrieval window.
- A second browser tab takes over the same device connection. The old tab waits
  for an explicit resume action instead of reconnecting repeatedly.
- Responses up to 8 MiB use authenticated 192 KiB parts when needed. Each
  encrypted frame remains below 1 MiB; incomplete responses share the RPC
  deadline and are discarded on disconnect. Older clients receive a 413.
- Terminal input and workspace mutations execute in request order. Failed or
  uncertain prompt delivery is never automatically retried.

`.github/workflows/deploy-relay.yml` provides manual deployment after adding
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets in the
`cloudflare-relay` GitHub environment. Never commit these values. The desktop
stores each device key in the OS credential store; the browser keeps its key
in local storage. A future native shell should replace browser storage with
Keychain/Keystore and reuse the same transport and screens.

## Current boundaries

- This implementation uses encrypted WebSockets through Cloudflare. EnsoCode's
  optional WebRTC direct transport is not included.
- Real CLI transcripts are bound by the existing desktop conversation adapter.
  Tools without supported transcript adapters remain usable via the terminal.
- CLI approval prompts and model switches use the terminal; Sinos does not
  fabricate structured Agent controls unsupported by its CLI adapters.
- Project preview servers still need their own reachable URL. This relay does
  not proxy arbitrary local HTTP ports.
- The phone currently remembers one computer per browser. Multi-computer
  switching and photo/image upload are not implemented.
- Installing a native app, native push notifications and background execution
  are separate work. The phone build currently runs in a browser/PWA window.
- Real phone cellular reachability, iOS keyboard behavior and end-to-end use
  with a running desktop CLI still require device acceptance. Browser smoke
  tests use a disposable desktop simulator, not a real AI session.
