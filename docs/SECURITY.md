# Security Model

What can go wrong, what stops it, and what is deliberately left open. The system spends
real money on every mint, so "who can trigger a spend" is the question that shapes most of
this.

---

## 1. What we are protecting

Four assets, in descending order of what a breach would cost:

| Asset | Worst case | Guarded by |
|---|---|---|
| The UprintBD institutional account | someone prints on the institution's credit until the balance is gone | credentials server-side only; auth + rate limits on `/api/print` |
| Student balances | a student's taka disappears, or someone spends someone else's | `.write: false` on every path; the Worker is the only writer |
| The two service-account keys | full read/write on both Firebase projects | Worker secrets; never in the repo, never in `public/` |
| Course/student catalogue | defacement — wrong course codes on thousands of cover pages | `coverAdmin` claim on lddb-demo writes |

---

## 2. Credentials

- The institutional UprintBD login, both service-account JSON keys, and
  `FIREBASE_API_KEY` live **only** in Worker secrets (production) or the gitignored `.env`
  (local). `.env.example` carries placeholders only.
- Nothing in `public/` can reach them. The browser sees `{ otp, cost, wallet }` and never
  a credential, a session cookie, or an internal error string.
- `createContext()` records which secrets are missing and every dependent route answers
  `503` with a plain sentence, rather than crashing or — worse — proceeding.
- **The Firebase web config in `public/js/labddb-config.js` is not a secret.** Every
  Firebase web app ships it. It identifies a project; it authorises nothing. The rules
  files are the control.

> **The service accounts bypass the rules files.** That is the design — the Worker is the
> only writer — but it means a leaked key is total for that project. Rotate at Google Cloud
> console → IAM & Admin → Service accounts → Keys.

---

## 3. Identity

`Authorization: Bearer <Firebase ID token>` on everything that can move money. Verified
server-side via Identity Toolkit `accounts:lookup`, not by locally checking a signature.
That is a deliberate trade: one extra network hop (cached 60 s per token in-isolate) buys

- **project scoping** — a token from any other Firebase project is rejected by Google, not
  by our own `aud` check;
- **live state** — a disabled or deleted account stops working immediately, instead of
  staying valid for the rest of the token's hour;
- the fresh profile we store on `/users/{uid}`.

Cheap local pre-checks (malformed, already expired, wrong `aud`) run first so junk costs no
round trip.

### The two admin roles are genuinely separate

| | Project admin | Coverpage admin |
|---|---|---|
| Surface | `/console.html` | `/admin.html` |
| Gate | verified email `=== ADMIN_EMAIL` | `/roles/{uid}/coverAdmin` |
| Can | move money, set prices, force settle | edit courses, faculty, students |
| Cannot | — | see any balance |

The project admin's gate is an **email comparison against the verified identity**, checked
on every request — never a role in the database, never a claim from the client. Both
`emailVerified` and the address must match; the whole gate is an address comparison, so an
unverified account holding that address would otherwise be the admin.

`console.html` is unlinked, but that is convenience. The server check is the control, and
it does not care how you found the URL.

---

## 4. Money

### Nothing in the browser can write it

Every `.write` in `firebase/labddb-pro.rules.json` is `false` — not as a placeholder
awaiting real rules, but as the design. Reads are scoped to the owner
(`auth.uid === $uid`); `/config` is world-readable so the calculator can quote a price
before anyone signs in. A student can watch their own balance live and can never change
it, and neither can anyone who reads the page source.

### Charging is exactly-once by construction

Money moves through one primitive, `applyToWallet(rtdb, uid, opId, mutate)`, which
compare-and-swaps `/wallets/{uid}` on its ETag **and records the `opId` inside the same
node in the same write**. The idempotency key and the balance therefore cannot disagree —
they are one write. A replayed settle finds its own `opId` already present and returns the
prior result.

This is what makes the reconciler safe to run every minute, `Force settle` safe to click
twice, and a crashed mint safe to retry. `scripts/test-ledger.js` proves it against an
in-memory RTDB that reproduces ETag CAS, including a forced race.

### An unused code costs nothing

Minting reserves; only a confirmed `Completed` row in `print_history` charges. That is not
generosity — it mirrors UprintBD, which debits the institutional account 37 s *after* a
print, not when a code is minted.

### Ordering: delete the code, then release the money

In both the reconciler and user-initiated cancel, `deletePrintRequest(recordId)` runs
**before** `release()`. Releasing first would leave a working OTP with no money behind it —
a student could print on a hold that no longer existed. If the delete fails, the money
stays held and the student is told it returns when the code expires.

### Overdraw is refused, not clamped

An adjustment that would take a balance below zero throws `400`. A silently clamped
clawback loses taka the admin believes they removed, and the ledger row would then disagree
with the wallet.

---

## 5. Abuse and spend caps

**Every mint costs the institution real money even if nothing prints** (the upload is
queued at UprintBD either way), so the brake is on minting, not only on the wallet:

| Cap | Default | Why |
|---|---|---|
| `maxOpenHolds` | 3 | unprinted codes per user; stops a loop from parking the whole balance |
| `maxJobsPerHour` | 20 | per user |
| `maxPagesPerJob` | 20 | one runaway PDF |
| `maxCopies` | 10 | multiplies cost directly |
| `minTopUp` / `maxTopUp` | 5 / 2000 | fat-finger guard on the admin's own hand |
| PDF size | 15 MB | before base64 decode |
| `clientJobId` | — | a double-click returns the original job instead of minting twice |

All editable from the console. The wallet is the real backstop: a user with ৳0 cannot mint
at all, which is why balances are admin-loaded rather than self-service.

Concurrency: the UprintBD leg is serialised through one cookie jar, because a record id
arrives on a redirect and overlapping uploads could attribute the wrong OTP to a job.
Ledger writes run in parallel and are safe by CAS.

---

## 6. Untrusted input

`/api/print` treats the body as hostile:

| Check | Result |
|---|---|
| body parses as JSON, `pdfBase64` present | `400 No document was received.` |
| decodes to > 0 bytes | `400 The document was empty.` |
| ≤ 15 MB | `413` |
| starts with `%PDF-` magic | `400 That file is not a PDF.` |
| page count | read from the **PDF itself** — a client cannot under-declare pages to pay less |
| `copies` | coerced and clamped |
| `filename` | non-`[A-Za-z0-9._-]` replaced, ≤ 90 chars, forced `.pdf`, **and a server-generated job-id suffix appended** |
| `meta.*`, `note`, `clientJobId` | `String()` + truncated before storage |
| `uid`, `jobId`, `action` | truncated; existence checked before use |
| `recordId` | digits only |

Filenames deserve a note: they are the join key between a print-history row and the person
who pays for it, so the client does **not** get to choose one. `AssignmentCover_EEE417_
24702008.pdf` is reproducible by anyone holding that roll number — two students printing
the same cover on the same day would have been indistinguishable, and one would have paid
for the other's page. The suffix removes the collision.

On the response side only two small values are scraped from UprintBD's HTML — a CSRF token
and a 4–8 digit OTP, both with anchored regexes — so there is no HTML-parsing attack
surface either.

---

## 7. lddb-demo: what was open, and what replaced it

**Before:** the catalogue database had no rules. Anyone who viewed the page source could
rewrite every course, faculty name and student record.

**Now:** public **read** — anonymous browsing and PDF download are deliberate features and
students never sign in to this project at all — with writes gated on
`auth.token.coverAdmin === true`. Since nobody signs in there, a plain `auth != null`
check would have been meaningless.

The claim arrives on a one-hour custom token from `POST /api/cover-token`, minted by the
lddb-demo service account only after the *LabDDB-Pro* identity is verified and found to
hold the role. So the trust chain is: Google sign-in → LabDDB-Pro ID token → server role
check → scoped lddb-demo token. The token can never touch a wallet: wallets are in a
different Firebase project.

`students` requires the claim to read the node **whole**; per-roll reads stay public so
the generators keep working. Enumerating the student body is a different act from looking
up your own roll number, and the rules distinguish them.

---

## 8. Transport, CORS, logging

- `ALLOWED_ORIGIN` should be the LabDDB origin in production. It defaults to echoing the
  caller's origin, which is right for local demo and too permissive for production —
  though note CORS protects the *browser*, not the API: the bearer token is what stops a
  direct call.
- Cloudflare terminates TLS. Behind `server.js` locally, run a reverse proxy if it is ever
  exposed.
- Known errors (`AuthError`, `LedgerError`) return their own message, written for a
  student to read. Unknown errors log a stack **server-side** and return
  `Something went wrong on our side. Please try again.` No internal detail reaches a
  browser.
- Every API response is `Cache-Control: no-store`. Balances and OTPs must not sit in an
  intermediary.

---

## 9. Data handling

- Cover-page PDFs are generated in the browser, streamed through to UprintBD, and **never
  persisted** by us — in memory for the duration of the request only.
- OTPs are stored on the job (the admin needs to answer "what was my code?") and returned
  by `/api/jobs` **only while the job is `reserved`**. An expired code is useless.
- Stored per user: uid, email, display name, photo URL, timestamps, and the jobs/ledger
  history. Course code and title if the generator supplied them. No roll number is
  required to have an account.
- The ledger is append-only. Corrections are new rows, never edits — a statement you can
  rewrite is not a statement.

---

## 10. Known gaps

Honest list, in the order they would matter:

1. **Charge-on-print-only is unit-tested, not yet kiosk-proven.** The procedure is
   [PRODUCTION-SETUP.md §8](PRODUCTION-SETUP.md#8-the-headline-test). Do it before students
   are told the service exists.
2. **`unmatchedPrints` is a detector, not a fix.** A print we cannot attribute is
   surfaced on the overview and needs a human. It must stay at 0.
3. **One institutional account** — the shared session is a single point of failure and of
   spend. Its balance is the first number on the overview for that reason.
4. **Rate limits are per-user, not per-IP.** Sign-up is open to any Google account, so a
   determined attacker can create accounts — but a new account has ৳0 and cannot mint
   anything, which is the actual brake.
5. **Admin actions are logged in the ledger, not in a separate audit log.** Money changes
   carry `byUid`; `user-flags` changes carry `disabledBy`/`grantedBy` but no history.
6. **No alerting.** Nobody is paged when the institutional balance runs low, `lastError`
   is set, or `unmatchedPrints` goes non-zero. Today that means looking at the overview.

---

## 11. Responsible-use posture

This integration is **not** an exploit. It uses ordinary, documented web endpoints with
valid credentials, performing the same requests in the same order as UprintBD's own UI —
and it was **requested by UprintBD** ("build something that works with our existing
system"). It creates only legitimate print jobs and deletes its own test jobs.

**The ask to UprintBD** (also in [PITCH.md](PITCH.md)): a blessed institutional account for
CU printing, and a note to their ops team allow-listing this traffic so a burst of
legitimate student prints is not mistaken for abuse.

If an official API arrives, the entire UprintBD-facing surface is one file
(`lib/uprint-bridge.js`). Swap it; the ledger, the rules and the console do not change.
