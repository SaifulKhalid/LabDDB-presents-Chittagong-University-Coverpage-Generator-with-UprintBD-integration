# Frontend Guide

The browser app in [`../public/`](../public): four cover-page generators, the kiosk OTP
flow, a wallet, and two separate admin surfaces. Deliberately framework-free (vanilla
IIFEs, no build step) so it drops into LabDDB as static files.

---

## Files

| File | Role |
|---|---|
| `index.html` | the main generator: header + status dot + account chip, form panel, live A4 preview, OTP modal, history drawer |
| `experiment-index.html`, `experiment-cover.html`, `experiment-main-cover.html` | the other three cover formats. Same shell, same scripts, different cover layout |
| `console.html` | **project admin** — overview, users, jobs, ledger, pricing, reconcile. Unlinked; the gate is server-side |
| `admin.html` | **coverpage admin** — the course/faculty/student catalogue |
| `css/styles.css` | app chrome + a pixel-faithful A4 cover (`210mm × 297mm`, Times New Roman, inset border), responsive at `@900px`, plus `@media print` |
| `js/labddb-config.js` | **loads first on every page.** Both Firebase configs, `bridgeUrl`, fallback pricing, `isAuthConfigured()`, `api(path)` |
| `js/labddb-auth.js` | `window.LabDDB.auth` — dual app init, Google sign-in sheet, live wallet listener, header chip, wallet sheet |
| `js/uprint.js` | `window.Uprint` (PDF→base64, bridge calls, quoting, history) and `window.OtpModal` |
| `js/app.js`, `js/experiment-*.js` | the four generators: data loading, preview, edit mode, PDF, Get-OTP |
| `js/console.js` | the project-admin console |
| `js/admin.js` | the catalogue admin, behind a `coverAdmin` custom token |
| `culogo.png` | CU crest (header + cover) |

### Load order (identical on every page)

```html
<!-- head -->
html2canvas 1.4.1 · jsPDF 2.5.1 (UMD)          <!-- generators only -->
firebase 9.0.2 compat: app · database · auth
js/labddb-config.js                             <!-- must be first of ours -->
<!-- end of body -->
js/uprint.js                                    <!-- generators only -->
js/labddb-auth.js
js/<page>.js
```

`labddb-auth.js` reads `window.LabDDB` on entry and logs
`labddb-config.js must load first` and returns if it is missing, so the order is a real
contract rather than a convention.

---

## Two Firebase apps in one page

`labddb-config.js` holds both configs, and `labddb-auth.js` initialises both:

```js
firebase.initializeApp(LabDDB.dataConfig);                 // default app  → lddb-demo
firebase.initializeApp(LabDDB.authConfig, 'labddb-pro');   // named app    → auth + wallet
```

The **default** app is lddb-demo, which is what makes this cheap: every pre-existing
`firebase.database().ref('cvr3_courses')` call in the generators keeps working untouched.
Sign-in and the wallet live on the named app.

`LabDDB.isAuthConfigured()` returns false while `authConfig.apiKey` still reads
`REPLACE_WITH_…`. Pages check it and degrade honestly — browsing, generating and
downloading a PDF need no account, so those keep working, and only "Get Kiosk OTP" reports
that sign-in is not configured yet. **The LabDDB-Pro config is now filled in**, so it returns
true and the OTP button gates on Google sign-in; the degraded path remains for anyone who
clones this without credentials. The one field worth checking is `databaseURL` —
[PRODUCTION-SETUP.md §1](PRODUCTION-SETUP.md).

---

## `LabDDB.auth` — the account layer

| Member | Does |
|---|---|
| `signIn()` / `signOut()` | Google popup, on the `labddb-pro` app |
| `getToken(forceRefresh)` | current ID token, or `null` when signed out |
| `fetch(path, opts)` | `fetch` with `Authorization: Bearer …` attached and the bridge URL prefixed |
| `requireUser(reason)` | resolve if signed in, otherwise open the sign-in sheet with `reason` as its explanation. **Rejects with `.cancelled = true`** if dismissed, so callers can do nothing quietly instead of showing an error |
| `openSignIn(reason)` / `openWallet()` | the two sheets, directly |
| `refresh()` | re-read `/api/me` |
| `subscribe(cb)` | called on every auth/wallet/role change; returns an unsubscribe function |
| `user`, `wallet`, `roles` | live getters on current state |
| `isConfigured()` | false while `authConfig` is unfilled — every caller checks this before gating |

**The wallet chip is push, not poll.** After sign-in, `labddb-auth.js` attaches
`authApp.database().ref('wallets/' + uid).on('value', …)` and renders `avatar · ৳ available`. When
the cron settles a print a minute later, the chip changes by itself — which is exactly the
moment a student is staring at the screen wondering whether they were charged. Rules make
that node readable only by its owner and writable by nobody.

The wallet sheet shows `balance`, `reserved` and the statement from `/api/jobs`, so a hold
is explainable: *"৳10, ৳3 of it committed to a code you haven't used."*

---

## `Uprint` — the bridge client

| Member | Does |
|---|---|
| `elementToPdfBase64(el)` | forces `210mm / minHeight 297mm`, `html2canvas` (scale 2, white bg, `useCORS`), builds A4 portrait jsPDF, returns base64 with no `data:` prefix, then restores the element's inline styles |
| `quote({pages, copies, color})` | **the single pricing function.** All four generators call it, so the number in the UI and the number charged cannot drift |
| `pricing()` | live prices from `GET /api/config`, falling back to `LabDDB.pricing` |
| `requestPrint(opts)` | **the whole Get-OTP flow** — validate, gate, render, post, and every error branch. This is what the four generators call |
| `requestOtp(base64, meta)` | the low-level `POST /api/print` **with the bearer token**; rejects with the server's `error` string and carries `.status` / `.data` |
| `health()` | `GET /api/health` → `{ ok, configured, missing }` |
| `bindBridgeBadge(el)` | drives the header dot (`up` = "Kiosk link ready"), polled |
| `saveToHistory`, `initHistoryDrawer`, `showToast` | the history drawer and toasts |

`OtpModal`: `loading()`, `success(data)`, `error(msg, onRetry)`, **`insufficient(data)`**,
`show()`, `hide()`. All values `esc()`-escaped.

`insufficient()` is the money path: a `402` carries `required` and `available`, so the modal
says *"you need ৳3 and have ৳0"* and offers the top-up instructions without a second round
trip.

**Bridge URL override:** set `window.UPRINT_BRIDGE_URL` before any script loads to point at
a hosted bridge; default is same-origin.

---

## The Get-OTP flow

Each generator's button handler just gathers options and calls **one** orchestrator,
`Uprint.requestPrint(opts)`. The gate, the money errors and the double-submit guard live
there, so all four pages behave identically and none of them can forget a step:

```js
Uprint.requestPrint({ element, filename, copies, color, tool, title, courseCode, roll,
                      validate, reason }):
  opts.validate()                      → complaint? toast it, stop
  auth.isConfigured() ? auth.requireUser(reason) : resolve   ← the only gate in the app
  clientJobId = one id per gesture     ← a double tap cannot mint two OTPs
  OtpModal.loading('Rendering your page…')
  elementToPdfBase64(element)
  OtpModal.loading('Sending it to the kiosk…')
  requestOtp(base64, {...opts, clientJobId})                 ← Bearer token attached
    → OtpModal.success(data); auth.refresh()
```

The failure paths are the interesting half — each one gets a specific message and a button
that leads somewhere useful:

| Outcome | What the user sees |
|---|---|
| dismissed the sign-in sheet | nothing at all. `err.cancelled` is not an error |
| `402` | `OtpModal.insufficient()`: *"৳0 available · this print needs ৳3 — you are ৳3 short. Nothing was charged and no code was created."* plus the bKash top-up steps |
| `401` | *"Your session expired."* → **Sign in** button reopens the sheet |
| `DUPLICATE` | *"That page was already sent. Check your recent codes rather than paying twice."* → **View my codes** |
| `TOO_MANY_HOLDS` | the server's message → **Manage my codes** opens the wallet sheet |
| anything else | the server's `error` string → **Retry** |

Three things worth noting:

- **Sign-in happens at the button, not at the page.** A student can browse, generate and
  download without an account; only the action that spends money asks who they are. When
  auth is unconfigured the gate is skipped entirely rather than blocking the page.
- **`clientJobId` is minted per gesture, in the browser.** A retried POST or an impatient
  double-tap returns the original job instead of a second hold — and `printInFlight` blocks
  the overlap before it reaches the network.
- **The filename the client sends is a hint.** The server appends a job-id suffix, because
  the filename is the only join key from a `print_history` row back to the person who pays.
  The value in `success(data)` is the server's, not the one sent.

The cost strip under the form is `Uprint.quote()` on `pages: 1` — a cover page is one page,
and the server re-counts the real PDF and prices *that*, so the strip previews the same
arithmetic rather than being a second implementation of it.

---

## Data model (lddb-demo, unchanged from 1.0)

**Course** (`cvr3_courses/<code>`)
```js
{
  courseCode, courseTitle, department,
  courseType: 'theory' | 'lab',              // only 'theory' is offered here
  semesterText,
  facultyMembers: [ { name, designation, department } ],
  assignments: { <key>: { assignmentNumber, assignmentTitle, submissionDate? } }
}
```

**Student** (`students/<roll>`)
```js
{ fullName, studentId, session, department }
```

Reads are public by rule; **writes now require a `coverAdmin` claim**. `admin.html` gets one
by exchanging its LabDDB-Pro sign-in for a one-hour lddb-demo custom token from
`POST /api/cover-token`, so its ~20 direct `db.ref().set()` calls keep working behind a
single Google sign-in. Reading `students` *whole* needs the claim; per-roll reads stay
public so the generators keep working.

Fallbacks are intact: if the SDK is missing or the read fails, the generators fall back to
`SAMPLE_COURSES` / `SAMPLE_STUDENTS`, so the demo works offline. The original tool's
analytics writes (`cvr3_usage/*`, `cvr3_meta/stats/*`) are still not reimplemented.

---

## `data-field` hooks (contract between the page scripts and the markup)

`updatePreview()` targets these; keep them in sync if you edit the markup:

`department` · `university` · `cover-type` · `course-code` · `course-title` ·
`assignment-no` · `assignment-name` · `submission-date` · `faculty` · `student`

All interpolated values pass through `esc()`, so neither the catalogue nor typed input can
inject markup.

---

## Embedding into production LabDDB

- **Edit `js/labddb-config.js` — nothing else.** Both Firebase configs, the bridge URL and
  the fallback prices live there. This replaced the config that used to be copy-pasted into
  five page scripts, where changing a database URL meant five edits.
- The RTDB paths (`cvr3_courses`, `students/<roll>`) already match the live catalogue.
- If the bridge is hosted separately from the static files, set `window.UPRINT_BRIDGE_URL`
  before the scripts load and set `ALLOWED_ORIGIN` on the bridge.
- The whole `public/` folder can be dropped in as-is. `console.html` needs no link from
  anywhere — the admin types the URL, and the server checks the email.
