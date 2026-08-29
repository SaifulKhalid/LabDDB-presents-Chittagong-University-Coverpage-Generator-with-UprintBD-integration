# LabDDB × UprintBD — One-Click Kiosk OTP

A working clone of the CU Assignment Cover Page Generator with a **"Get Kiosk OTP"**
button that talks directly to UprintBD's *existing* website — **no API required from
UprintBD** — and returns a real, kiosk-printable OTP in one click.

> **Status: proven end-to-end against the live UprintBD site, and printed at a CU kiosk.**
> The bridge logs in, uploads the cover page, queues the job, and scrapes the real OTP the
> same way a student clicking through the site by hand would.
>
> **The headline property: nobody is charged unless a page actually printed.** Generating an
> OTP and walking away costs the student nothing — the money is *reserved*, then released.
> See [docs/TESTING.md](docs/TESTING.md) for the evidence.

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

## Project layout

```
Pitch/
├── server.js                  Node server: static host + the API (local & self-host)
├── src/worker.js              Cloudflare Worker entry: fetch() + scheduled()
├── wrangler.toml              Worker config — assets, cron trigger, secret names
├── lib/
│   ├── api.js                 The whole route table, shared by both runtimes
│   ├── ledger.js              The only code that moves money
│   ├── reconcile.js           Settles printed jobs, releases lapsed holds
│   ├── uprint-bridge.js       The engine — drives UprintBD's web flow (no API)
│   ├── firebase-rest.js       Firebase without firebase-admin (JWT, RTDB, ETag CAS)
│   └── auth-verify.js         Firebase ID-token verification
├── firebase/
│   ├── labddb-pro.rules.json  Wallets: read your own, write nothing. Ever.
│   └── lddb-demo.rules.json   Catalogue: public read, coverAdmin write
├── public/
│   ├── index.html             the main generator + 3 × experiment-*.html
│   ├── console.html           project admin (money) — unlinked, gated server-side
│   ├── admin.html             coverpage admin (course/faculty/student catalogue)
│   ├── css/styles.css         pixel-faithful A4 cover + app chrome + mobile
│   └── js/
│       ├── labddb-config.js   both Firebase configs + prices — the one file to edit
│       ├── labddb-auth.js     Google sign-in, live wallet chip
│       ├── uprint.js          PDF→base64, quoting, OTP modal, history drawer
│       ├── app.js             the generators (+ 3 × experiment-*.js)
│       └── console.js, admin.js
├── scripts/
│   ├── test-ledger.js         the money tests — offline, no credentials
│   ├── mobile-verify.js       syntax + page markup + load order + CSS
│   ├── smoke-test.js          bridge: login → mint OTP → delete (real)
│   ├── http-test.js           the API over HTTP, incl. reserve-not-charge
│   ├── verify-clean.js        confirms no test jobs remain on the account
│   └── probe-*.js             read-only recon of the live account (no spend)
├── Sample/                    the original CU generators, kept for reference
├── .env.example               config template (copy to .env)
├── package.json               name/scripts/engines; dependencies: {}
└── docs/                      ← full documentation (index below)
```

---

## Documentation

| Document | What's inside |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | System design, the two runtimes, the request lifecycle, the reserve→settle→release ledger, and the key design decisions. |
| **[docs/UPRINT-PROTOCOL.md](docs/UPRINT-PROTOCOL.md)** | The reverse-engineered UprintBD flow, request by request: headers, the exact options payload field-by-field, OTP scraping, `print_history`, the three prices, and every quirk solved along the way. |
| **[docs/API.md](docs/API.md)** | HTTP API reference — every route, request/response schema, error codes, `curl` examples. |
| **[docs/FRONTEND.md](docs/FRONTEND.md)** | The browser app: the twelve files, the load-order contract, the two Firebase apps, `LabDDB.auth`, and the Get-OTP flow with every failure branch. |
| **[docs/SETUP.md](docs/SETUP.md)** | Local development: prerequisites, the env table, running the server, `wrangler dev`, troubleshooting. |
| **[docs/PRODUCTION-SETUP.md](docs/PRODUCTION-SETUP.md)** | Deployment: both Firebase projects, the eight Worker secrets, RTDB rules, the cron trigger, and the kiosk test procedure. |
| **[docs/TESTING.md](docs/TESTING.md)** | Six verification layers, what each proves, how to run them, sample output, and an honest list of what is *not* covered. |
| **[docs/SECURITY.md](docs/SECURITY.md)** | Credential handling, the rules files, input validation, the threat model, abuse caps, and known gaps. |
| **[docs/PITCH.md](docs/PITCH.md)** | The business case for UprintBD — problem, solution, why no API is needed, the upgrade path, and the ask. |
| **[CHANGELOG.md](CHANGELOG.md)** | Version history. |

---

## What's proven vs. what to verify manually

- ✅ **Ledger** — `npm test` proves hold → settle → release against an in-memory RTDB that
  reproduces ETag compare-and-swap: no double-settle under a *forced* race, no negative
  balance, and an unused OTP that writes no ledger row at all. No credentials, no network.
- ✅ **Static surface** — `npm run verify` parses every JS file, checks each page's mobile
  markup, and enforces that `labddb-config.js` loads before `labddb-auth.js`.
- ✅ **Bridge library** — `npm run smoke` mints a real OTP and deletes the job.
- ✅ **HTTP contract** — `npm run test:http` proves the auth gate refuses an anonymous mint
  with `401`, then mints a real code and asserts **the balance did not move**.
- ✅ **Static hosting + traversal guard** — assets serve; `/../.env` returns `404`.
- ✅ **Cost model** — `pages × copies × unit`, confirmed live, with the three prices kept
  distinct (see the table above and
  [docs/UPRINT-PROTOCOL.md §0](docs/UPRINT-PROTOCOL.md)).
- ⚠️ **Browser DOM → PDF** (html2canvas + jsPDF) needs a real browser, so it's tested by
  loading the page and clicking through. The base64 it produces is exactly the payload
  `/api/print` already accepted, so the contract on both sides of that boundary is verified.
- ⚠️ **Charge-on-print-only, end to end** — the ledger logic is unit-tested above, but the
  loop that closes it (`print_history` → settle) can only be *proven* at a kiosk. The
  procedure is in
  [docs/PRODUCTION-SETUP.md §8](docs/PRODUCTION-SETUP.md#8-the-headline-test): mint a code
  and walk away, then mint one and print it.
- ❌ **RTDB rules as deployed** — read them; there is no rules emulator in this project.

---

## License / status

Internal pitch prototype for LabDDB. Not for public redistribution. The UprintBD-facing
surface is deliberately isolated in `lib/uprint-bridge.js` behind a stable
`{ otp, cost, … }` contract, so a future official API can be dropped in without touching
anything else.
