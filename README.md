# LabDDB × UprintBD — One-Click Kiosk OTP

[![Release](https://img.shields.io/badge/release-v2.0.0-blue.svg)](https://github.com/SaifulKhalid/LabDDB-presents-Chittagong-University-Coverpage-Generator-with-UprintBD-integration/releases/tag/v2.0.0)
[![Production](https://img.shields.io/badge/production-live-green.svg)](https://pitch.labddb.workers.dev)
[![Tests](https://img.shields.io/badge/tests-215%2B%20passed-brightgreen.svg)](docs/TESTING.md)

A production-grade Chittagong University Cover Page Generator paired with a **"Get Kiosk OTP"** bridge that talks directly to UprintBD's *existing* web application — **requiring zero API cooperation from UprintBD** — and returns an instant 6-digit kiosk print OTP in a single click.

> **Production URL:** [https://pitch.labddb.workers.dev](https://pitch.labddb.workers.dev)  
> **Release:** `v2.0.0` (Production Release)  
> **Headline Property: Nobody is charged unless a page actually printed.** Generating an OTP and walking away costs the student nothing — the money is reserved using Compare-And-Swap (CAS) ledger semantics, and automatically released if unused. See [docs/TESTING.md](docs/TESTING.md) for evidence.

---

## Why this exists

Today a student who wants to print a cover page has to:

1. Generate it on LabDDB.
2. **Leave** LabDDB, open `uprintbd.com`, log in.
3. Upload the PDF, choose print options.
4. Copy the OTP.
5. Enter it at a CU kiosk to print.

Steps 2–4 are pure friction. This project collapses them into a **single button** on
LabDDB. UprintBD's challenge was: *"We won't give you an API. Build something that
works with our existing system, and we'll sign the contract."* This meets that
literally — the bridge performs the **same HTTP requests the UprintBD website itself
makes**, so no cooperation or new endpoint is required on their side.

---

## Quick start

Requires **Node.js ≥ 20** (built-in `fetch`, `FormData`, `Blob`, `crypto.subtle`,
`Headers.getSetCookie()`). **Zero npm dependencies.**

```bash
cd Pitch
npm test                  # the money tests: no credentials, no network, no Firebase
npm run verify            # syntax, page markup, load order, responsive CSS — offline too
```

Both of those work on a fresh clone, before any configuration. To actually mint a code:

```bash
cp .env.example .env      # then add the institutional UprintBD login
npm start                 # -> http://localhost:3000/
```

Open **http://localhost:3000/**, pick a course + assignment, enter a roll number, click
**Generate Cover Page**, then **🖨️ Get Kiosk OTP**.

Local details: **[docs/SETUP.md](docs/SETUP.md)**.
Deploying: **[docs/PRODUCTION-SETUP.md](docs/PRODUCTION-SETUP.md)**.

---

## How the money works

Three separate numbers, deliberately never conflated:

| Number | Value | Who sees it |
|---|---|---|
| **Declared** to UprintBD in `total_cost` | 3 mono / 5 colour | mirrors UprintBD's own `calculateCost()` |
| **Billed** by the outlet | 2.00 Tk for a 1-page mono job | confirmed in `transaction_history` |
| **Paid** by the student | `/config/pricing`, default 3 mono / 5 colour | admin-editable, live |

At the defaults that is **1 Tk margin per b/w page**, and the ledger stores the student's
price on the job at mint time — so changing the price never re-prices a code already held.

The flow mirrors UprintBD's own behaviour rather than guessing at it: their
`transaction_history` shows the institutional account is debited **37 s *after* a print
completes**, not when the code is minted. So the ledger does the same thing —

```
mint OTP   ->  reserve the price   (balance unchanged, available drops)
printed    ->  settle              (balance drops once, one statement row)
expired    ->  release             (no ledger row is written at all)
```

A cron pass every minute reads `print_history`, settles jobs whose filename shows up
`Completed`, and releases holds whose OTP lapsed. Students top up out-of-band via bKash and
the project admin credits the wallet from `/console.html`.

---

## The verified flow (one glance)

| # | Request | Result |
|---|---|---|
| 1 | `GET /login/` | `csrftoken` cookie + form token |
| 2 | `POST /login/` | `302 → /home/`, sets `sessionid` |
| 3 | `GET /uprint/dashboard/` | fresh `csrfmiddlewaretoken` |
| 4 | `POST /uprint/uploader/` (multipart) | `302 → /uprint/set_options/<id>/` |
| 5 | `POST /uprint/accept_print_info/<id>/` (JSON) | `{"status":"OK"}` — **queues job + mints OTP** |
| 6 | `GET /uprint/dashboard/` | scrape the **6-digit OTP** for `<id>` |
| 7 | `GET /uprint/print_history/` | `Completed` — the settlement ground truth |

Byte-level detail — every header, the full options payload, the OTP-scraping regex,
the cost model, and the quirks that had to be solved — is in
**[docs/UPRINT-PROTOCOL.md](docs/UPRINT-PROTOCOL.md)**.

---

## Three-Tier Authorization Model

| Level | Identity | Capabilities | Limitations |
|---|---|---|---|
| **Anonymous** | Unauthenticated visitor | Browse catalogue, generate covers, direct print, download PDF | Roll number is in-memory only; cannot mint OTPs; cannot edit catalogue; no Console access |
| **Signed-in Student** | Any verified Google Account (`@*`) | All anonymous features + server-side roll persistence across sessions, mint `lddb-demo` tokens, edit course catalogue, mint kiosk OTPs | Rejected with `403 Forbidden` on `/api/admin/*`; cannot view `console.html` |
| **Project Owner** | `htmlwithkhalid@gmail.com` | Full access to all endpoints, student features, financial administration, top-ups, adjustments, user monitoring, audit logs, and reconcile triggers | Configured via server-side `ADMIN_EMAIL` env var |

---

## Project Layout

```
Pitch/
├── server.js                         # Node.js runtime host (local & self-host)
├── src/worker.js                     # Cloudflare Worker runtime entry (fetch + cron)
├── wrangler.toml                     # Worker config, D1/R2 bindings, cron triggers
├── schema.sql                        # Cloudflare D1 relational schema (audit & history)
├── lib/
│   ├── domain/                       # Core domain entities, errors & wallet rules
│   │   ├── errors.js                 # DomainError, LedgerError, ConflictError, etc.
│   │   ├── print-job.js              # PrintJob state machine (reserving -> reserved -> printed)
│   │   ├── wallet.js                 # Double-entry CAS balance mutations & limit checks
│   │   └── limits.js                 # Concurrency and volume caps (pages, copies, holds)
│   ├── application/                  # Business orchestration & use cases
│   ├── infrastructure/               # External adapters & driver integrations
│   │   ├── firebase/                 # Zero-dependency WebCrypto JWT, REST client, verifier
│   │   └── uprint/                   # CookieJar, SessionQueue, HTML parsers, adapter
│   ├── services/                     # Application services (Ledger, Reconcile, Audit, Catalogue)
│   └── api/                          # HTTP route handlers, context factory & RBAC gates
├── firebase/
│   ├── labddb-pro.rules.json         # Realtime DB rules: read own wallet, write nothing
│   └── lddb-demo.rules.json          # Catalogue DB rules: public read, coverAdmin write
├── public/                           # Frontend client application
│   ├── index.html                    # Assignment cover generator
│   ├── experiment-cover.html         # Lab experiment single cover generator
│   ├── experiment-main-cover.html    # Lab experiment main cover generator
│   ├── experiment-index.html         # Lab experiment index table generator
│   ├── admin.html                    # Course & catalogue administration panel
│   ├── console.html                  # Privileged project owner financial console
│   ├── css/styles.css                # Mobile-first responsive styles & strict A4 print geometry
│   └── js/
│       ├── labddb-config.js          # Shared catalogue layer & Firebase configuration
│       ├── labddb-auth.js            # Dual Firebase Auth, live wallet chips & drawer
│       ├── uprint.js                 # Client print bridge, OTP modal & quoting
│       ├── app.js                    # Generator state controllers
│       ├── admin.js                  # Catalogue editor controller
│       └── console.js                # Privileged financial administration controller
├── scripts/                          # Comprehensive automated test & audit suites
└── docs/                             # Full architectural & protocol documentation
```

---

## Documentation

| Document | What's inside |
|---|---|
| **[docs/RELEASE-v2.0.0.md](docs/RELEASE-v2.0.0.md)** | Production release notes, commit SHA, tag, deployment revision, verification audit log, and feature list. |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | System design, the two runtimes, the request lifecycle, the reserve→settle→release ledger, and key design decisions. |
| **[docs/AUTHORIZATION.md](docs/AUTHORIZATION.md)** | The authoritative three-tier access control policy (Anonymous, Student, Project Owner). |
| **[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md)** | Zero-dependency Firebase Identity Toolkit REST integration & WebCrypto RS256 token verification. |
| **[docs/LEDGER.md](docs/LEDGER.md)** | Double-entry CAS wallet rules, concurrency handling, and mathematical proofs. |
| **[docs/UPRINTBD.md](docs/UPRINTBD.md)** / **[docs/UPRINT-PROTOCOL.md](docs/UPRINT-PROTOCOL.md)** | The reverse-engineered UprintBD flow: headers, options payload, OTP scraping, and reconciliation. |
| **[docs/API.md](docs/API.md)** | Complete HTTP API reference — routes, request/response schemas, error status codes. |
| **[docs/FRONTEND.md](docs/FRONTEND.md)** | Browser app architecture, script load order, Dual Firebase apps, and mobile modal UX. |
| **[docs/DATABASE.md](docs/DATABASE.md)** | Data schema specifications for Firebase RTDB, Cloudflare D1 (SQL), and Cloudflare R2. |
| **[docs/SETUP.md](docs/SETUP.md)** | Local development environment setup, prerequisites, and environment variable table. |
| **[docs/PRODUCTION-SETUP.md](docs/PRODUCTION-SETUP.md)** | Cloudflare deployment: Worker secrets, D1/R2 bindings, RTDB rules, and cron triggers. |
| **[docs/TESTING.md](docs/TESTING.md)** | Verification layers, test matrices, automated scripts, and test run logs. |
| **[docs/SECURITY.md](docs/SECURITY.md)** | Threat model, secret hygiene, CAS invariants, and security boundaries. |
| **[docs/PITCH.md](docs/PITCH.md)** | The business case for UprintBD — problem, solution, no-API architecture, and partnership. |
| **[CHANGELOG.md](CHANGELOG.md)** | Version history and release notes. |

---

## Verification & Audits

- ✅ **Financial Ledger (CAS & Races):** `node scripts/test-ledger.js` & `node scripts/audit-concurrency.js` prove reserve → settle → release against in-memory RTDB CAS: no double-settle under forced races, no negative balances.
- ✅ **Domain State Machine & Pricing:** `node scripts/test-domain.js` verifies all state transitions and pricing bounds.
- ✅ **Catalogue Selection Defaults:** `node scripts/test-catalogue-defaults.js` verifies latest course/experiment auto-selection.
- ✅ **Static Architecture & Syntax:** `npm run verify` validates all 80 JavaScript files, page semantics, and responsive CSS tokens.
- ✅ **Single-Page PDF & Direct Print Layout:** `node scripts/audit-pdf-visual.js` and `node scripts/audit-print-layout.js` (Puppeteer headless engine) confirm exact 1-page A4 geometry across 8 content variations.
- ✅ **Mobile & Viewport Responsiveness:** `node scripts/audit-browser-interaction.js` & `node scripts/audit-admin-signin-ui.js` verify full responsiveness and 44px touch targets across 320px, 375px, 390px, 414px, 768px, 1366px, and 1920px.
- ✅ **Live UprintBD Bridge:** `node scripts/test-live-uprint.js` proves automated login, PDF upload, queue checking, OTP parsing, and INV-6 clean deletion against the live kiosk site.
- ✅ **Secret Hygiene:** `node scripts/audit-secrets.js` confirms zero secrets, unredacted private keys, or credentials in tracked files.

---

## License / Status

Internal production release for LabDDB & Chittagong University Cover Page Generator. All rights reserved.
