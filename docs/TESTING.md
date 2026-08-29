# Testing & Verification

Six layers, in the order you should run them: static checks and money logic offline, then
the UprintBD engine, then the HTTP contract, then account hygiene, then the browser. The one
thing no script can prove — that a real page came out of a real kiosk — has its own procedure
in [PRODUCTION-SETUP.md §8](PRODUCTION-SETUP.md#8-the-headline-test).

> ⚠️ Everything from §2 onward runs against the **real** UprintBD account in `.env`. Each
> mints a genuine job and then deletes it. Don't run them in a tight loop.
>
> §1 touches nothing at all.

---

## 1. The money — `npm test`

```bash
npm test             # node scripts/test-ledger.js
```

**No credentials, no network, no Firebase project.** `scripts/test-ledger.js` runs
`lib/ledger.js` against an in-memory RTDB that reproduces Firebase's ETag compare-and-swap,
and asserts the product promise directly. Nine suites:

| Suite | What it pins down |
|---|---|
| Pricing and filenames | 3 mono / 5 colour, `pages × copies`, unique-suffix filenames |
| Hold then settle | a printed page charges exactly once, and writes one statement row |
| Hold then release | **an unused code writes no ledger row at all** |
| Idempotency | replaying settle/release/top-up after a crash changes nothing |
| Insufficient funds | `402` with `required`/`available`; the balance is untouched |
| Concurrency | a **forced** race — a second writer commits between the first's read and write — so the CAS retry path genuinely executes rather than being assumed |
| Admin top-ups and adjustments | overdraw refused not clamped; junk inputs rejected without a row |
| Rate and volume limits | open-hold cap, per-hour cap, page/copy caps, duplicate `clientJobId` |
| End to end | mint and walk away → balance unchanged; mint and print → charged once, margin 1 Tk |

Run this first. It is the fastest signal that the wallet is intact, it needs nothing set up,
and it is the layer where a bug costs real money.

---

## 2. Bridge library — `npm run smoke`

`scripts/smoke-test.js` builds a minimal one-page PDF in memory, then exercises the engine
directly: `login()` → `printAndGetOtp()` → assert the OTP matches `^\d{4,8}$` →
`deletePrintRequest()`. No wallet, no Firebase — just UprintBD.

```bash
npm run smoke        # node scripts/smoke-test.js
```

```
1) logging in ...
   sessionid acquired: true
2) uploading test cover page + accepting options ...
   RESULT: { "ok": true, "otp": "646813", "recordId": "13696",
             "pages": 1, "copies": 1, "color": false,
             "cost": 3, "currency": "BDT", "validForSeconds": 3600 }
   ✅ OTP minted: 646813  (cost 3 BDT)
3) cleaning up test job ...
   deleted: true
SMOKE TEST PASSED ✅
```

**Proves:** the full UprintBD flow works end-to-end and returns a real OTP. Note `cost: 3`
here is the figure **declared** to UprintBD, not the student's price — see
[UPRINT-PROTOCOL.md §0](UPRINT-PROTOCOL.md).

---

## 3. HTTP contract — `npm run test:http`

`scripts/http-test.js` calls the running server the way the browser does, and asserts the
headline property over real HTTP: **mint a code, and the balance must not move.**

```bash
# terminal 1
npm start

# terminal 2 — no token: verifies the auth gate and stops
npm run test:http

# with a token: the full money flow
TEST_ID_TOKEN=eyJhbGci... npm run test:http
```

Get a token from the browser console while signed in:

```js
await LabDDB.auth.getToken()
```

They last an hour. Without one the script checks `/api/health`, `/api/config` and that an
anonymous `POST /api/print` is refused with `401` — then stops and tells you how to supply
one, rather than failing in a way that looks like a broken server.

With a token it runs the sequence that matters:

```
3) POST /api/print with no token (must be refused)
   ok   an anonymous mint is refused with 401
5) POST /api/print
   ok   returns a real OTP
   ok   appends a server-side unique suffix to the filename
6) GET /api/me (money reserved, not charged)
   ok   balance is UNCHANGED — an OTP alone never charges
   ok   the price is held in reserved instead
7) POST /api/cancel { jobId }
8) GET /api/me (hold returned)
   ok   balance never moved at any point
   ok   back exactly where we started — the unused code cost nothing
HTTP ROUTE TEST PASSED ✅  — minted a real OTP and charged nothing for it.
```

**Proves:** the auth gate, the JSON contract `public/js/*.js` depends on, the server-side
filename suffix, and reserve-not-charge against the real ledger.

Two non-failures it reports and exits cleanly on: `missing` secrets (routes answer `503`),
and `402` when the test account has no DDB balance — top up from `/console.html` first.
Override the target with `TEST_BASE=http://host:port`.

---

## 4. Account hygiene — `npm run verify:clean`

`scripts/verify-clean.js` logs in and checks that specific record ids are gone
(`scrapeOtp` returns `null` once a job is deleted). Defaults to the ids used by the tests;
pass your own as arguments.

```bash
npm run verify:clean               # checks 13696 13697
node scripts/verify-clean.js 13710 # check a specific id
```

Exit code is non-zero if any job remains, so it's CI-friendly.

**Proves:** testing left the institutional account clean — no dangling jobs or live OTPs.
Worth running after any session that minted codes, because a forgotten code is money held
against the institution's balance.

---

## 5. Static hosting & path-traversal guard (manual)

With the server running:

```bash
for p in / /index.html /console.html /admin.html /css/styles.css /js/app.js /js/labddb-auth.js; do
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "http://localhost:3000$p"
done
# traversal must NOT be 200:
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/../.env"      # → 404
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/../server.js" # → 404
```

Expect `200` with correct MIME types, and `404` for both traversal attempts.

`/console.html` returning `200` is **correct and not a leak** — the page loads for anyone,
and then every `/api/admin/*` call it makes is checked against the verified admin email
server-side. The unlisted URL is convenience; the server check is the control.

---

## 6. Browser walk-through (manual)

The DOM → PDF layer needs a real browser (html2canvas + jsPDF rasterise the DOM), and so
does anything involving Google sign-in.

1. `npm start`, open `http://localhost:3000/`.
2. Header dot turns green ("Kiosk link ready") within a few seconds.
3. Pick a course + assignment, enter a roll number (`24702008` exists in the sample data),
   click **Generate Cover Page** — the A4 preview fills in. **No sign-in needed for any of
   this**, which is deliberate.
4. (Optional) **📄 PDF** downloads the same PDF locally to eyeball the output.
5. Click **🖨️ Get Kiosk OTP** → the sign-in sheet appears. Sign in with Google.
6. The chip in the header shows `৳ available`. Click OTP again → modal shows a **real OTP**,
   the cost, pages × copies, validity and kiosk steps.
7. Watch the chip: `available` drops by the price, **`balance` does not**. Open the wallet
   sheet — the statement has no charge row yet.
8. Cancel from the history drawer. The chip returns to its original value and the statement
   is still empty. That is the promise, visible in the UI.

**Why the render isn't automated:** headless rasterisation needs a browser engine
(Puppeteer/Playwright), which contradicts the zero-dependency design. The base64 PDF this
step produces is the same shape `npm run test:http` already feeds to `/api/print`
successfully, so both sides of that boundary are independently verified.

---

## Static checks — `npm run verify`

```bash
npm run verify       # node scripts/mobile-verify.js
```

Offline, no credentials, no shell loop — so it behaves identically in PowerShell and bash.
Four passes:

| Pass | What it catches |
|---|---|
| `node --check` on `server.js` and every `.js` in `lib/`, `src/`, `scripts/`, `public/js/` | a typo that would otherwise surface at request time. The list is read from the directories, so a file added tomorrow is covered without editing the script |
| Page markup | a generator missing its viewport, mobile nav, floating dock, drag handle or history drawer. `admin.html` and `console.html` are checked against their own shapes, not the generators' |
| Script load order | `labddb-auth.js` loading before `labddb-config.js`. It bails out silently in that case, so sign-in would simply not work and nothing would say why |
| Responsive CSS | the six rules the mobile layout depends on — including `font-size: 16px !important`, because iOS zooms the page when a smaller input takes focus |

Non-zero exit on any failure.

One wrinkle worth knowing if you ever run `node --check` by hand: this project is CommonJS
(`package.json` has no `"type": "module"`) *except* `src/worker.js`, which must be ESM
because that is the Workers module format. Checking it directly fails with
`Cannot use import statement outside a module` on Node 20, which looks like a broken file and
isn't. `mobile-verify.js` detects ESM syntax and checks those files through a temporary
`.mjs` copy instead.

---

## What is and isn't covered

| Layer | Automated? | By |
|---|---|---|
| JS syntax, page markup, load order, responsive CSS | ✅ offline | `npm run verify` |
| Pricing, holds, settle/release, idempotency, limits | ✅ offline | `npm test` |
| CAS under a forced race | ✅ offline | `npm test` |
| UprintBD flow | ✅ | `npm run smoke` |
| Auth gate + reserve-not-charge over HTTP | ✅ | `npm run test:http` |
| Account cleanliness | ✅ | `npm run verify:clean` |
| Static serving + traversal guard | ⚠️ manual curl | §5 |
| Browser DOM → PDF, sign-in, wallet chip | ⚠️ manual | §6 |
| Reconciler settling a **real** kiosk print | ⚠️ manual, at a kiosk | [PRODUCTION-SETUP.md §8](PRODUCTION-SETUP.md#8-the-headline-test) |
| RTDB rules as deployed | ❌ | read them; there is no rules emulator here |

The last two rows are the honest gaps. Everything above them can be checked from a laptop;
those two need a kiosk and a deployed project, and the first of them is the one the whole
design exists to guarantee.
