# Changelog

All notable changes to the LabDDB × UprintBD pitch prototype.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [2.0.1] — 2026-08-29

### Changed
- **Worker service renamed**: Renamed Cloudflare worker from `labddb-uprint-pitch` to `pitch` (live domain `https://pitch.labddb.workers.dev`).
- **Domain propagation notice**: Documented that it may take a few minutes for `pitch.labddb.workers.dev` to accept incoming requests following the rename and deployment.

## [2.0.0] — 2026-08-25

Production build. The prototype minted OTPs for anyone who could reach the URL; this
version puts identity, a wallet, and a settlement loop underneath it. The headline
property: **nobody is charged unless a page actually printed.** Generating an OTP and
walking away costs the user nothing.

The design mirrors UprintBD's own behaviour rather than guessing at it —
`transaction_history` shows they debit the institutional account 37 s *after* a print
completes, not when a code is minted. So: **reserve on mint, settle on confirmed print,
release on expiry.**

### Added — money and identity
- **`lib/ledger.js`** — the only code that moves money. Pricing (`priceJob`), `hold`,
  `settle`, `release`, `topUp`, `adjust`, `checkLimits`, unique filename generation.
  Every mutation goes through one primitive, `applyToWallet(rtdb, uid, opId, mutate)`,
  which compare-and-swaps `/wallets/{uid}` on its ETag **and records the `opId` in the
  same node in the same write**. That is what makes settlement exactly-once: the
  idempotency key and the balance cannot disagree, because they are one write.
- **`lib/reconcile.js`** — the settle/expire engine. Reads `/uprint/print_history/`,
  settles jobs whose filename shows up `Completed`, and releases holds whose OTP lapsed.
  Runs on a Cron Trigger every minute *and* inline from `/api/print` when the last run
  looks stale, so a cron outage delays settlement instead of freezing balances.
- **`lib/firebase-rest.js`** — Firebase without `firebase-admin`: service-account JWT
  (RS256 via WebCrypto) → OAuth token, cached; RTDB REST with `X-Firebase-ETag` /
  `if-match`; custom-token minting. Isomorphic, so the same file runs on Workers and Node.
- **`lib/auth-verify.js`** — Firebase ID-token verification via `identitytoolkit
  accounts:lookup`. Email must be verified before it counts for anything.
- **`lib/api.js`** — the whole route table (19 paths), shared by `src/worker.js` and
  `server.js`: `/api/me`, `/api/jobs`, `/api/config`, `/api/cover-token`, and twelve
  `/api/admin/*` routes. `requireAdmin` checks the caller's verified email on **every**
  request.
- **`public/js/labddb-auth.js`** — dual Firebase app init, Google sign-in sheet, live
  wallet listener, header account chip (`avatar · ৳ available`), wallet sheet with ledger.
- **`public/js/labddb-config.js`** — both Firebase configs, the bridge URL and pricing
  defaults in one place, replacing the config duplicated across five page scripts. The
  LabDDB-Pro web config is filled in and live; only `databaseURL` needs checking against the
  console, since it is the one field the copied snippet omits.
- **`public/console.html`** + **`public/js/console.js`** — the project-admin console:
  overview, users, jobs, ledger with CSV export, pricing/limits, and a reconcile pane.
  Unlinked URL, but the gate is server-side; hiding it is convenience, not security.
- **`firebase/labddb-pro.rules.json`**, **`firebase/lddb-demo.rules.json`** — the real
  enforcement. See Security below.
- **`scripts/test-ledger.js`** — the money tests, against an in-memory RTDB that
  reproduces ETag CAS semantics. No credentials, no network. Includes a *forced* race
  (two holds on one wallet inside one tick) to prove the retry path actually runs.
- **`scripts/mobile-verify.js`** (`npm run verify`) — offline static checks: `node --check`
  over every JS file (discovered by reading the directories, so it cannot go stale), each
  page's mobile markup, the `labddb-config.js`-before-`labddb-auth.js` load order, and the
  responsive CSS rules. ESM files are checked through a temporary `.mjs` copy, because
  `src/worker.js` is the one module in an otherwise CommonJS project.
- **`scripts/probe-*.js`** — read-only reconnaissance of `print_history`,
  `transaction_history`, outlet data and pricing. No uploads, no spend.
- **`docs/PRODUCTION-SETUP.md`** — deployment, both Firebase projects, secrets, and the
  kiosk test procedure.

### Added — UprintBD bridge
- `getPrintHistory({ sinceMs })` — date-filtered (Asia/Dhaka), header-mapped column
  parsing, so a reordered table cannot silently charge the wrong amount.
- `getQueuedRecordIds()`, `scrapeOtpExpiry()` (reads the dashboard's real countdown
  instead of assuming 3600 s), `getAccountBalance()`.
- Caller-supplied unique filenames — the job-id suffix that makes a history row
  attributable to exactly one person.

### Changed
- **`POST /api/print` now requires a Firebase ID token.** Browsing, generating and
  downloading a PDF stay free and anonymous; only the kiosk OTP action needs an account.
- Cover-page prices come from `/config/pricing` (admin-editable, defaults 3 mono /
  5 colour). All four calculators call one `Uprint.quote()`, so the number in the UI and
  the number charged cannot drift apart.
- Pages are counted **server-side from the PDF bytes** and priced from that, instead of
  trusting a client-declared count. The cost strip in the UI quotes `pages: 1` because a
  cover page is one page; it previews the server's arithmetic rather than reimplementing it.
- The history drawer is backed by job status from RTDB (Reserved → Printed), not
  localStorage alone.
- `public/admin.html` / `js/admin.js` — Google sign-in gate, `coverAdmin` role check, and
  a server-minted custom token for lddb-demo writes. The ~20 direct `db.ref().set()`
  calls keep working unchanged behind one sign-in.
- `wrangler.toml` — Cron Trigger (`* * * * *`) and the eight secret names documented.
- Cover-page admin and project admin are now genuinely separate surfaces with separate
  roles: `admin.html` manages the catalogue, `console.html` moves money, and holding one
  role grants nothing on the other.

### Security
- **Nothing in `public/` can write money.** `.write` is `false` on every path in
  `labddb-pro.rules.json` — not as a placeholder, but as the design. The service account
  bypasses rules, so the Worker is the only writer, and a student's browser can read
  their own balance and never change it.
- `lddb-demo` was **wide open**: anyone reading the page source could rewrite every
  course, faculty name and student record. Now public-read (anonymous browsing is a
  deliberate feature) with writes gated on a `coverAdmin` claim carried by a one-hour
  custom token. `students` needs the claim to read the node whole; per-roll reads stay
  public so the generators keep working.
- `/api/admin/*` is restricted to one verified email (`ADMIN_EMAIL`). The check is on the
  token, not on a role stored in the database.
- Stale-OTP leak closed: `deletePrintRequest(recordId)` runs **before** the hold is
  released, in both the reconciler and user-initiated cancel. Releasing first would leave
  a working code with no money behind it.
- Open-hold and jobs-per-hour caps: every mint spends real money at UprintBD even when
  nothing prints, so the brake is on mints, not just on the wallet.
- `.gitignore` now covers `.dev.vars` (the `wrangler dev` secrets file, which holds the same
  UprintBD password and service-account JSON as `.env`), `.wrangler/`, and downloaded
  service-account keys (`*firebase-adminsdk*.json`). A leaked service-account key bypasses
  every RTDB rule, so it is the one file that must never be committed.

### Known limitations
- Charge-on-print-only is unit-tested but can only be *proven* at a kiosk; the procedure
  is in `docs/PRODUCTION-SETUP.md`.
- `/api/admin/users` and the all-jobs scope scan the tree. Fine at this scale; they
  become per-day indices if the user count grows.
- Reconciliation granularity is one minute, so a student may watch a settled print for up
  to ~60 s before the chip updates.
- Workers' free tier gives 10 ms CPU per request; RSA-signing a JWT and base64-decoding a
  PDF in the same request is tight. A cold start that fails is a student at a kiosk with
  no code, so the $5/mo plan is the safer choice.

## [1.0.0] — 2026-08-23

First working end-to-end version: a cloned CU cover-page generator that mints real
UprintBD kiosk OTPs by automating UprintBD's existing web flow — no API required.

### Added
- **`lib/uprint-bridge.js`** — headless automation of UprintBD's web interface:
  `CookieJar`, manual-redirect `http()` helper, CSRF/OTP scraping, PDF page counting,
  and the `UprintSession` class (`login`, `ensureLogin`, `printAndGetOtp`,
  `scrapeOtp`, `deletePrintRequest`, `getProfile`).
- **`server.js`** — zero-dependency `node:http` server: static host for `public/`
  with a path-traversal guard, plus `POST /api/print`, `POST /api/cancel`,
  `GET /api/health`, `GET /api/profile`. Serialises print jobs through one
  institutional session via a promise chain. Refuses to start without credentials.
- **`public/`** — the cloned generator: `index.html`, `css/styles.css`,
  `js/app.js` (course/student data + preview + edit + PDF + Get-OTP), and
  `js/uprint.js` (PDF→base64 bridge client + OTP modal). Built-in sample course data
  so the demo runs even if Firebase is unreachable.
- **`scripts/`** — `smoke-test.js` (bridge), `http-test.js` (server API),
  `verify-clean.js` (account hygiene).
- **`docs/`** — architecture, protocol, API, frontend, setup, testing, security,
  and pitch documentation.
- **`.env.example`**, **`.gitignore`**, **`package.json`** (no dependencies).

### Verified (live, against uprintbd.com)
- Login → upload → `accept_print_info` → OTP scrape, returning genuine 6-digit OTPs.
- Cost model `pages × copies × unit`, using the 3 Tk mono / 5 Tk colour units the site's
  own `calculateCost()` uses. (Superseded in 2.0.0: `print_history` shows the outlet
  bills **2.0 Tk** for a 1-page mono job — the 3/5 figures are what we *declare*, not
  what is charged.)
- Static asset serving and path-traversal protection (`/../.env` → `404`).
- Cleanup: all test jobs deleted; account queue confirmed empty afterwards.

### Security
- `.env.example` ships with placeholders only; real credentials live solely in the
  gitignored `.env` and never reach the browser.
- Uploads validated server-side (base64 decode + `%PDF-` magic bytes, 15 MB cap).

### Known limitations
- Browser DOM → PDF rendering (html2canvas + jsPDF) is exercised by manual
  click-through, not headless automation.
- One shared institutional account; concurrent jobs are serialised, not parallel.
- Analytics writes from the original generator (`cvr3_usage/*`,
  `cvr3_meta/stats/*`) are not reimplemented in this clone.
