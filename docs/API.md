# API Reference

Every route lives in [`../lib/api.js`](../lib/api.js) and is served identically by
`src/worker.js` (production, Cloudflare) and `server.js` (local dev). Anything that moves
money or touches UprintBD is written **once** there, so the two runtimes cannot drift.

- **Base URL (local):** `http://localhost:3000` · **production:** your Worker's URL
- **CORS:** `ALLOWED_ORIGIN` (default: echo the caller's origin). `GET, POST, OPTIONS`;
  headers `Content-Type, Authorization`. `OPTIONS` → `204`.
- **Content type:** JSON in, JSON out. Every response carries `Cache-Control: no-store`.

## Authentication

Three tiers:

| Tier | Routes | How |
|---|---|---|
| **Anonymous** | `/api/health`, `/api/config` | nothing |
| **Signed in** | `/api/me`, `/api/print`, `/api/jobs`, `/api/cancel`, `/api/cover-token` | `Authorization: Bearer <Firebase ID token>` |
| **Project admin** | `/api/admin/*` | same header; the verified email must equal `ADMIN_EMAIL` |

Browsing the generator, previewing a cover page and downloading the PDF need **no
account** — that is deliberate. Only the kiosk OTP action, which spends real money, is
gated.

Tokens are minted by Firebase Auth in the browser (`user.getIdToken()`) against the
**LabDDB-Pro** project. The server verifies them through Identity Toolkit
`accounts:lookup` rather than local JWK verification, so a disabled or deleted account
stops working immediately instead of at the end of the token's hour. Verified identities
are cached in-isolate for 60 s.

Admin status is decided **only** by the verified email — never by a role in the database,
and never by anything the client sends. `emailVerified` is required.

### Auth errors

| Status | `error` | When |
|---|---|---|
| `401` | `Sign in to continue.` | no `Authorization` header |
| `401` | `Malformed sign-in token. Please sign in again.` | not a JWT |
| `401` | `Your session expired. Please sign in again.` | `exp` passed, or Google says `TOKEN_EXPIRED` / `INVALID_ID_TOKEN` / `USER_NOT_FOUND` |
| `403` | `Sign-in token was issued for a different app.` | `aud` ≠ `LABDDB_PROJECT_ID` |
| `403` | `This account has been disabled.` | disabled in Firebase Auth |
| `403` | `This area is restricted.` | signed in, but not `ADMIN_EMAIL` |
| `500` | `Auth is not configured on the server.` | `FIREBASE_API_KEY` missing |

---

# Public routes

## `GET /api/health`

Liveness plus which subsystems are configured. Useful as the first call after a deploy.

```json
{
  "ok": true,
  "service": "labddb-uprint-bridge",
  "version": 2,
  "time": "2026-08-25T08:02:11.000Z",
  "configured": { "kiosk": true, "auth": true, "wallet": true, "coverAdmin": true },
  "missing": []
}
```

`ok` is `false` when `missing` is non-empty. It names the env groups that are absent
(`UPRINT_EMAIL/UPRINT_PASSWORD`, `FIREBASE_API_KEY`, `LABDDB_DATABASE_URL`,
`LABDDB_SERVICE_ACCOUNT`) — no values, just which ones.

## `GET /api/config`

Current prices, so the anonymous cost calculator quotes the number the student will
actually be charged.

```json
{
  "ok": true,
  "pricing": { "mono": 3, "color": 5, "currency": "BDT", "maxCopies": 10 },
  "limits":  { "maxCopies": 10, "maxPagesPerJob": 20 }
}
```

If RTDB is unreachable this still answers, with the built-in defaults. A generator that
cannot reach the wallet database should still be able to price a page.

---

# Signed-in routes

## `GET /api/me`

The bootstrap call. **It also creates the user record** — `/users/{uid}`, a zeroed wallet
and the email→uid index — so a student who has never called it does not exist yet and
cannot be topped up.

```json
{
  "ok": true,
  "user":   { "uid": "…", "email": "…", "displayName": "…", "photoURL": "…", "disabled": false },
  "wallet": { "balance": 10, "reserved": 3, "available": 7 },
  "roles":  { "coverAdmin": false, "projectAdmin": false },
  "pricing": { "mono": 3, "color": 5, "currency": "BDT", "maxCopies": 10 }
}
```

`available = balance − reserved`, and it is the only number worth showing a student: it is
what they can still spend. The header chip renders it.

## `POST /api/print`

Mint a kiosk OTP. **Reserves the price; never charges it.** Money moves only when
`print_history` confirms the page came out — see [UPRINT-PROTOCOL.md §8](UPRINT-PROTOCOL.md).

| Field | Type | Required | Notes |
|---|---|---|---|
| `pdfBase64` | string | ✅ | a `data:` prefix is stripped; whitespace ignored |
| `filename` | string | – | a unique job-id suffix is **appended server-side**; a client-supplied name is a hint, never the final name |
| `copies` | number | – | clamped to `1..pricing.maxCopies` |
| `color` | boolean | – | default mono |
| `clientJobId` | string | – | idempotency: the same value inside the dedupe window returns `409` with the original `jobId` instead of minting twice |
| `meta` | object | – | `{ tool, title, courseCode, roll }`, truncated, stored on the job for the admin's jobs table |

Page count is read from the PDF itself; a client cannot under-declare it. `total_cost`
declared to UprintBD is computed the way their own `calculateCost()` does, which is a
different number from what the student pays — §0 of the protocol doc explains all three.

**`200`:**
```json
{
  "ok": true,
  "jobId": "K7Q2M9…",
  "otp": "902306",
  "recordId": "13694",
  "filename": "AssignmentCover_EEE417_24702008_K7Q2M9.pdf",
  "pages": 1, "copies": 1, "color": false,
  "cost": 3, "unitPrice": 3, "currency": "BDT",
  "validForSeconds": 3600,
  "expiresAt": 1787654321000,
  "wallet": { "balance": 10, "reserved": 3, "available": 7 }
}
```

`cost` is what the student pays. Note the balance is unchanged and `reserved` went up —
that is the whole design in one object.

**Errors:**

| Status | `error` / `code` | Cause |
|---|---|---|
| `400` | `No document was received.` | missing `pdfBase64` |
| `400` | `The document was empty.` | decoded to zero bytes |
| `400` | `That file is not a PDF.` | no `%PDF-` magic |
| `413` | `That document is too large.` | over 15 MB |
| `403` | `This account has been disabled…` | `disabled` on the user record (distinct from disabled in Firebase Auth) |
| `400` | — | over `maxPagesPerJob` or `maxCopies` |
| `402` | `code: INSUFFICIENT_BALANCE` | plus `required`, `available`, `balance`, `reserved` |
| `429` | `code: TOO_MANY_HOLDS` | too many unused codes already open |
| `429` | — | jobs-per-hour cap |
| `409` | — | duplicate `clientJobId`; carries the original `jobId` |
| `502` | `The kiosk service could not create a code right now. Your balance was not touched.` | UprintBD failed; the hold is released before returning |
| `503` | `The wallet database is not configured on the server.` | missing secrets |

A `402` carries the numbers the UI needs to say *"you need ৳3 and have ৳0"* without a
second round trip. The `429`s exist because **every mint spends real money at UprintBD
even if nothing prints**, so the brake is on minting, not only on the wallet.

**Concurrency:** the UprintBD leg is serialised through one cookie jar — overlapping
uploads could otherwise attribute the wrong record id, and therefore the wrong OTP, to a
job. Ledger operations run in parallel and are safe under contention by compare-and-swap.

`/api/print` also runs the reconciler when the last run looks stale, so a cron outage
delays settlement instead of freezing balances.

## `GET /api/jobs`

The caller's 25 most recent jobs, for the history drawer.

```json
{ "ok": true, "jobs": [ {
  "id": "…", "status": "printed", "otp": null,
  "price": 3, "pages": 1, "copies": 1, "color": false,
  "title": "Assignment 2", "courseCode": "EEE 417",
  "filename": "…_K7Q2M9.pdf",
  "createdAt": 0, "expiresAt": 0, "settledAt": 0, "actualCost": 2
} ] }
```

`status` ∈ `reserving | reserved | printed | expired | failed | cancelled`. **`otp` is
returned only while `status === 'reserved'`** — an expired code is useless, and showing
one just invites a wasted trip to the kiosk.

## `POST /api/cancel`

Kill your own unused code and get the hold back immediately, rather than waiting out the
hour.

`{ "jobId": "…" }` → `{ ok, jobId, wallet: { balance, reserved, available } }`

| Status | Cause |
|---|---|
| `404` | not your job, or no such job |
| `409` | already `printed`/`expired`/`cancelled` — the message names the status |
| `502` | UprintBD would not delete it; the hold is deliberately **kept** |

That `502` is the interesting case. The code is deleted at UprintBD **before** the money
is released — if it were the other way round, a student could print on a hold that no
longer existed. So a failed delete leaves the money held and tells the student it will
come back when the code expires.

## `POST /api/cover-token`

Mints a one-hour Firebase **custom token** for the *lddb-demo* project carrying
`coverAdmin: true`. `admin.html` exchanges it via `signInWithCustomToken`, and its ~20
existing `db.ref().set()` calls keep working unchanged — while lddb-demo's rules stay
closed to everyone else.

No body. → `{ ok: true, token: "…", expiresIn: 3600 }`

| Status | Cause |
|---|---|
| `403` | no `coverAdmin` role (the project admin always passes) |
| `503` | `LDDB_DEMO_SERVICE_ACCOUNT` not set |

Two projects, two credentials, and the token is scoped to the catalogue only: it can never
touch a wallet, because wallets live in a different Firebase project entirely.

---

# Project-admin routes

All require the verified `ADMIN_EMAIL`. All are `403` otherwise, whatever the caller's
role in the database says.

## `GET /api/admin/overview`

The console's landing pane, in one constant-cost call.

```json
{
  "ok": true,
  "uprint": {
    "accountBalance": 480, "accountBalanceAt": 0,
    "lastReconcileAt": 0, "lastRun": { }, "lastError": null,
    "unmatchedPrints": 0
  },
  "totals": {
    "users": 42, "floatHeld": 310, "reserved": 9,
    "openHolds": 3, "openHoldValue": 9
  },
  "pricing": { }, "limits": { }
}
```

Two numbers deserve attention:

- **`uprint.accountBalance`** — the institutional account. When it runs dry nobody can
  print, however much DDB balance students hold.
- **`unmatchedPrints`** — history rows that could not be attributed to a job. **Must stay
  0.** Anything else is a page the institution paid for that nobody was charged for.

And `totals.floatHeld` is a **liability, not revenue**: pages already paid for and not yet
printed.

## `GET /api/admin/users?q=`

Up to 200 users, newest-seen first. `q` matches email, display name or exact uid.

Each row: `uid, email, displayName, photoURL, disabled, createdAt, lastSeenAt, balance,
reserved, available, coverAdmin`.

Only users who have signed in at least once appear — see `/api/me`.

## `POST /api/admin/topup`

The money-in route. Funding happens out of band (bKash); this records it.

`{ uid, amount, note, method }` → `{ ok, uid, wallet, ledgerId }`

`amount` is a whole number within `limits.minTopUp … limits.maxTopUp`; outside that →
`400` naming the range. `404` if the user has never signed in.

**Put the bKash transaction ID in `note`.** It is the only link between the money that
arrived and the balance you created, and it lands on the ledger row as your reconciliation
trail.

## `POST /api/admin/adjust`

Corrections and refunds. `{ uid, delta, note, type }` where `type` is `refund` or
`adjustment` and `delta` may be negative.

An adjustment that would take the balance below zero is **refused** with `400`, not
clamped to zero: a silently clamped clawback loses taka the admin believes they removed,
and the ledger row would then disagree with the wallet.

## `POST /api/admin/user-flags`

`{ uid, disabled?: boolean, coverAdmin?: boolean }` → `{ ok, uid, changes }`.
`400 Nothing to change.` if neither boolean is present.

`disabled` blocks minting (existing holds still settle honestly). `coverAdmin` writes or
removes `/roles/{uid}`, which is what `/api/cover-token` checks. The project admin's own
access is by email and cannot be revoked here.

## `GET /api/admin/jobs?scope=open|all`

- **`open`** (default) — the reconciler's working set joined back to the full job records,
  so the admin can see the OTP a student is asking about. Presence in `openJobs` *is* the
  status: settle and release both remove the entry.
- **`all`** — 200 most recent across everyone. A full tree scan; fine at this scale.

Rows carry `email` as well as `uid`, because the admin is usually looking at this table
because a specific person said their code did not work.

## `POST /api/admin/job-action`

Manual override for a stuck job. `{ uid, jobId, action }`, `action` ∈ `settle` |
`expire` | `cancel`.

Both go through the **same idempotent ledger paths the reconciler uses**, so clicking
twice cannot double-charge or double-refund. `expire`/`cancel` deletes the UprintBD
record first, then releases.

`404` for an unknown job, `400 Unknown action.` otherwise.

## `GET /api/admin/ledger?uid=`

The immutable statement: every `topup`, `charge`, `refund` and `adjustment`, newest first,
capped at 500 rows, with `totals: { topups, revenue, adjustments }`. Omit `uid` for
everyone. The console exports this to CSV.

## `POST /api/admin/pricing`

Edit prices and limits in one call. Accepts `mono`, `color`, `maxCopies` (whole numbers
0–1000) and any key of `DEFAULT_LIMITS` (`≥ 0`). Returns the merged result.

Changes apply to **new** jobs only. A job already reserved settles at the price quoted
when it was minted — the price is stored on the job, not looked up at settlement.

## `POST /api/admin/reconcile`

Force a reconciliation pass now, ignoring the staleness check. Returns the summary:
what settled, what expired, what could not be matched. This is the button for "a print
went through but the balance hasn't moved."

## `GET|POST /api/admin/unmatched`

`GET` lists the unattributable history rows. `POST { key }` clears one after you have
dealt with it by hand.

A row here means UprintBD printed something the ledger cannot tie to a job. Investigate
before clearing — clearing is bookkeeping, not a fix.

## `GET /api/admin/uprint`

The cost side: the institutional account's balance plus its last 7 days of print history
(100 rows max), straight from UprintBD.

Partial failure is reported, not thrown: if the balance scrape fails you still get the
history, with `balanceError` / `historyError` alongside. One flaky scrape should not blank
the whole pane.

---

## Error envelope

Every failure is `{ ok: false, error: "<message>" }` plus, when relevant, any of
`code`, `required`, `available`, `balance`, `reserved`, `jobId`.

Messages for known errors (`AuthError`, `LedgerError`) are **written to be shown to the
user as-is** — they say what happened and what to do. Unknown errors are logged
server-side with a stack and answered with `Something went wrong on our side. Please try
again.` A student never sees an internal detail, and never sees a raw stack trace.

| Code | Meaning |
|---|---|
| `200` | OK |
| `204` | CORS preflight |
| `400` | validation |
| `401` | not signed in / token bad |
| `402` | insufficient balance |
| `403` | signed in, not allowed |
| `404` | unknown endpoint or record |
| `405` | known path, wrong method |
| `409` | conflicting state (duplicate `clientJobId`, job already resolved) |
| `413` | PDF over 15 MB |
| `429` | rate/hold limit |
| `500` | unexpected |
| `502` | UprintBD failed |
| `503` | server not configured |

---

## Static hosting

Any non-`/api/` `GET` serves from `public/`: `/` → `index.html`, MIME by extension,
everything unknown `application/octet-stream`. The resolved path must stay inside
`public/` — `/../.env` returns `404`.

---

## The engine contract (embedding without HTTP)

```js
const { UprintSession } = require('./lib/uprint-bridge');
const s = new UprintSession({ email, password });
const r = await s.printAndGetOtp(pdfBytes, { filename, copies, color });
// { ok, otp, recordId, filename, pages, copies, color, cost, currency, validForSeconds }
await s.deletePrintRequest(r.recordId);
```

Also: `login()`, `ensureLogin()`, `scrapeOtp(id)`, `scrapeOtpExpiry(id)`,
`getQueuedRecordIds()`, `getPrintHistory({ sinceMs })`, `getAccountBalance()`,
`getProfile()`. Exported alongside: `CookieJar`, `countPdfPages(bytes)`, `BASE`.

`cost` here is the figure **declared** to UprintBD, not the student's price. The API layer
replaces it before anything reaches a browser. See
[UPRINT-PROTOCOL.md §0](UPRINT-PROTOCOL.md).
