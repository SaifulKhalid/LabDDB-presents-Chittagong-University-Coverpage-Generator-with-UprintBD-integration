# Local Setup

Running the project on your own machine. **For deploying it, see
[PRODUCTION-SETUP.md](PRODUCTION-SETUP.md)** — that covers the two Firebase projects, the
eight Worker secrets, the cron trigger and the kiosk test. This page is only about local
development.

---

## Prerequisites

- **Node.js ≥ 20.** The bridge uses built-in `fetch`, `FormData`, `Blob`, `crypto.subtle`
  and `Headers.getSetCookie()` (the last needs Node 20+). Check with `node -v`.
- **No `npm install` needed** — `dependencies` is empty. `npm install` is a no-op.
- Outbound HTTPS to `uprintbd.com`, for anything that actually mints a code.

## The money tests need nothing at all

```bash
npm test          # node scripts/test-ledger.js
```

No credentials, no network, no Firebase project. It runs `lib/ledger.js` against an
in-memory RTDB that reproduces ETag compare-and-swap, including a forced race, and it
asserts the headline property directly: mint a hold, walk away, balance unchanged. Run this
first — it is the fastest way to know the wallet logic is intact, and it works before you
have signed up for anything.

---

## Configure

```bash
cd Pitch
cp .env.example .env
```

`.env.example` documents every key inline. The short version:

| Var | Required | Default | Purpose |
|---|---|---|---|
| `UPRINT_EMAIL` | ✅ | — | institutional account the bridge logs in as |
| `UPRINT_PASSWORD` | ✅ | — | its password |
| `FIREBASE_API_KEY` | for sign-in | — | verifies the browser's ID tokens |
| `LABDDB_PROJECT_ID` | for sign-in | — | LabDDB-Pro project id; rejects tokens from other projects |
| `LABDDB_DATABASE_URL` | for the wallet | — | LabDDB-Pro RTDB |
| `LABDDB_SERVICE_ACCOUNT` | for the wallet | — | one-line service-account JSON; the only thing that writes money |
| `LDDB_DEMO_SERVICE_ACCOUNT` | for `/admin.html` | — | one-line JSON; mints the `coverAdmin` token |
| `ADMIN_EMAIL` | for `/console.html` | — | the single project-admin address |
| `PORT` | – | `3000` | local port |
| `ALLOWED_ORIGIN` | – | `*` | `*` echoes the caller's origin. Fine locally, [too loose in production](SECURITY.md#8-transport-cors-logging) |
| `UPRINT_BASE_URL` | – | `https://uprintbd.com` | override for staging |

**Only the UprintBD pair is fatal.** Miss either and the server prints `[FATAL]` and exits.
Everything else degrades instead:

```
[warn] Not configured yet: FIREBASE_API_KEY, LABDDB_SERVICE_ACCOUNT
       Sign-in and wallet routes will answer 503 until these are set.
```

That is deliberate — a half-configured server must not be able to spend money. The routes
that depend on a missing secret answer `503` with a plain sentence naming the subsystem, and
`GET /api/health` lists exactly what is absent.

The `.env` loader is a tiny built-in: `KEY=VALUE` per line, `#` comments, optional
surrounding quotes stripped. It never overrides a variable already set in the real
environment, so `PORT=8080 node server.js` wins over `.env`.

---

## Run

```bash
npm start            # or: node server.js
```

```
  LabDDB × UprintBD bridge (dev)
  ------------------------------------------
  Cover-page generator : http://localhost:3000/
  Project admin        : http://localhost:3000/console.html
  Coverpage admin      : http://localhost:3000/admin.html
  UprintBD account     : your-institutional-account@example.com
  Target               : https://uprintbd.com
  Reconciler           : every 60s
  ------------------------------------------
```

**That last line is the local stand-in for the Cron Trigger.** In production a Cloudflare
cron calls `scheduled()` every minute; locally `server.js` runs the same
`lib/reconcile.js` pass on a 60 s `setInterval`. Without it nothing would ever settle, and a
printed page would sit reserved forever. If the wallet database is not configured it logs
`[reconciler] not started` and stays out of the way. The timer is `unref()`d, so it never
keeps the process alive on its own.

Browsing, previewing and downloading a PDF work with no account. **Only "Get Kiosk OTP"
requires sign-in**, because only it spends money — so to exercise that path locally you need
the Firebase keys above. Firebase authorises `localhost` out of the box, so Google sign-in
works from `http://localhost:3000` without touching the Authorized domains list.

To test the bridge without a browser, see [TESTING.md](TESTING.md).

---

## Worker runtime, locally

```bash
npm run dev:worker      # npx wrangler dev
```

Runs `src/worker.js` on the real Workers runtime, which is worth doing before deploying
because it enforces the things Node does not: the CPU limit, the subrequest cap, and the
absence of Node built-ins. `wrangler dev` reads `.dev.vars`, not `.env` — copy the values
across if you use it. Cron triggers do not fire in `wrangler dev`; hit
`POST /api/admin/reconcile` instead.

---

## Self-hosting the Node server instead

Cloudflare Workers is the deployment target ([PRODUCTION-SETUP.md](PRODUCTION-SETUP.md)),
but `server.js` is a complete production-capable server if you would rather run a box.

<details>
<summary>systemd unit + Nginx proxy</summary>

```ini
# /etc/systemd/system/labddb-uprint.service
[Unit]
Description=LabDDB x UprintBD bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/labddb-uprint/Pitch
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/labddb-uprint/Pitch/.env
Restart=on-failure
User=labddb

[Install]
WantedBy=multi-user.target
```

```nginx
location /api/ { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
location /     { proxy_pass http://127.0.0.1:3000; }
```

Terminate TLS at the proxy — ID tokens and OTPs must not cross plaintext — and set
`ALLOWED_ORIGIN` to your real origin rather than leaving it `*`.

</details>

### Split hosting (static app on LabDDB, bridge elsewhere)

Host `public/` wherever LabDDB lives and run only the bridge as a service. Point the client
at it before the scripts load:

```html
<script>window.UPRINT_BRIDGE_URL = 'https://bridge.labddb.app';</script>
```

Then set `ALLOWED_ORIGIN` on the bridge to the LabDDB origin. Note CORS protects the
*browser*, not the API: the bearer token is what stops a direct call.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `[FATAL] UPRINT_EMAIL and UPRINT_PASSWORD must be set` | No `.env`, or the keys are blank. `cp .env.example .env` and fill it in. |
| `[warn] Not configured yet: …` | Expected until you add the Firebase keys. Sign-in and wallet routes answer `503` meanwhile; the generator still works. |
| `TypeError: res.headers.getSetCookie is not a function` | Node < 20. `nvm install 20 && nvm use 20`. |
| `/api/health` shows `ok: false` | `missing` names the env groups that are absent. Nothing else is wrong. |
| Sign-in button does nothing | Google sign-in not enabled on LabDDB-Pro, or the domain is not authorized. `localhost` is authorized by default, so locally this is usually the provider. See [PRODUCTION-SETUP.md §1](PRODUCTION-SETUP.md). |
| Signed in, but the wallet chip stays at ৳0 | `databaseURL` in `labddb-config.js` does not match `LABDDB_DATABASE_URL` — a region mismatch points the browser at a database nobody writes to. |
| `502 Login failed (HTTP …)` | Wrong UprintBD credentials, or the account is locked. |
| `502 accept_print_info failed …` | UprintBD changed the options contract; see [UPRINT-PROTOCOL.md](UPRINT-PROTOCOL.md) §5. Django's leaked `exception_value` is included in the message. |
| `502 … no OTP appeared on the dashboard` | Markup changed; check the scrape regex in `scrapeOtp()`. |
| A printed job stays `Reserved` | The reconciler is not running (check the banner) or cannot read `print_history`. `POST /api/admin/reconcile` forces a pass. |
| Browser: "PDF libraries not loaded" | CDN blocked (offline/firewall). Self-host `html2canvas`/`jsPDF` or allow the CDN. |
| Header dot stays grey/red | Bridge not running, or `UPRINT_BRIDGE_URL`/`ALLOWED_ORIGIN` mismatch. |
