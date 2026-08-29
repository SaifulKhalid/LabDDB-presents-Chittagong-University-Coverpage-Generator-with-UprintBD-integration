# UprintBD Protocol (reverse-engineered)

This is the complete, verified description of how the bridge obtains a real kiosk OTP
**without any API from UprintBD** — by performing the same HTTP requests the UprintBD
website itself makes for a logged-in user.

All of this is implemented in [`../lib/uprint-bridge.js`](../lib/uprint-bridge.js) and
was confirmed live against `https://uprintbd.com`.

> **Target stack (observed):** Django + Django REST Framework, session auth + CSRF for
> the print flow, JWT (`/api/user/*`) for profile/wallet. `DEBUG=True` is on in
> production, which conveniently leaks exception values we use for diagnostics.

---

## 0. Constants

| Name | Value | Notes |
|---|---|---|
| `BASE` | `https://uprintbd.com` | override with `UPRINT_BASE_URL` |
| `UA` | Chrome 125 on Win10 UA string | sent on every request |
| `UNIT_PRICE_MONO` | `3` (Tk/page) | **declared** in the payload, not what is charged — see below |
| `UNIT_PRICE_COLOR` | `5` (Tk/page) | same |
| session freshness | 8 minutes | reuse before re-login |
| OTP validity | ~3600 s (~1 hour) | then UprintBD auto-deletes the file |

> **The two prices are not the same number, and confusing them is expensive.**
>
> `UNIT_PRICE_MONO/COLOR` exist only to fill in `total_cost` on the
> `accept_print_info` payload, mirroring the site's own `calculateCost()` so our
> request looks exactly like the browser's. They are a *declaration*.
>
> What the outlet actually bills is different: a live 1-page mono print at a CU
> kiosk appears in `/uprint/print_history/` with **`Cost: 2.0`**, and
> `/uprint/transaction_history/` shows the matching `From Print` debit of 2.0 Tk
> 37 seconds later. That 2.0 is our cost of goods.
>
> And what a *student* pays is a third number, unrelated to both: it comes from
> `/config/pricing` in RTDB (defaults 3 mono / 5 colour) and is the only price the
> UI ever shows. At today's defaults the margin is 1 Tk per b/w page.
>
> So: declared cost mirrors the site, `actualCost` is scraped from history and
> stored on the job for margin reporting, and `price` is what we charge. The
> reconciler never lets `actualCost` change `price`.

Two cookies matter throughout:
- **`csrftoken`** — Django's CSRF cookie, set on the first GET. Also echoed as a hidden
  `csrfmiddlewaretoken` form field and required as the `X-CSRFToken` header on JSON POSTs.
- **`sessionid`** — the authenticated session, set by a successful login. Its presence
  is our definition of "logged in."

A tiny `CookieJar` absorbs `Set-Cookie` from every response (via
`Headers.getSetCookie()`) and replays them as the `Cookie` header on the next request.

---

## 1. `GET /login/` — acquire CSRF

```
GET /login/
```
- Sets the `csrftoken` cookie.
- The HTML contains `<input name="csrfmiddlewaretoken" value="...">`, extracted with:
  ```js
  /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/
  ```
- We keep the form token; if absent we fall back to the cookie value.

## 2. `POST /login/` — authenticate

```
POST /login/
Content-Type: application/x-www-form-urlencoded
Origin:  https://uprintbd.com
Referer: https://uprintbd.com/login/

csrfmiddlewaretoken=<token>&email=<EMAIL>&password=<PASSWORD>
```
- **Success = a `302` that sets the `sessionid` cookie** (redirects to `/home/`).
  We don't rely on the status text; we check for `sessionid` in the jar.
- If `sessionid` is missing afterwards → `Login failed (HTTP <status>)`.

Because we send `redirect: 'manual'`, we never auto-follow — we just read the result and
inspect cookies.

## 3. `GET /uprint/dashboard/` — fresh upload token

```
GET /uprint/dashboard/
```
- The dashboard renders the `#uploadForm`, which carries a **fresh**
  `csrfmiddlewaretoken`. We scrape it (same regex as step 1) and use it for the upload.
  Loading the dashboard first mirrors exactly what a browser does.

## 4. `POST /uprint/uploader/` — upload the PDF (multipart)

```
POST /uprint/uploader/
Origin:  https://uprintbd.com
Referer: https://uprintbd.com/uprint/dashboard/
Content-Type: multipart/form-data; boundary=...   (set automatically by FormData)

fields:
  csrfmiddlewaretoken = <dashboard token>
  file                = <the PDF blob, application/pdf, filename>
```
- Built with the global `FormData` + `Blob`; `fetch` sets the multipart boundary.
- **Success = a `302` whose `Location` is `/uprint/set_options/<id>/`.** That `<id>` is
  the **record id** for this job — the single most important value in the flow, and the
  reason we handle redirects manually:
  ```js
  location.match(/set_options\/(\d+)/)  // → recordId
  ```
- No match → throw with the HTTP status and the raw `Location`.

> ⚠️ **Do not** `GET /uprint/uploader/` — that view is POST-only and 500s on GET
> (`NoReverseMatch`). Always POST the multipart form directly, as the dashboard does.

## 5. `POST /uprint/accept_print_info/<id>/` — queue job + **mint OTP**

This is the pivotal call. It both queues the job and causes UprintBD to generate the OTP.

```
POST /uprint/accept_print_info/<recordId>/
Content-Type: application/json; charset=utf-8
X-CSRFToken:  <csrftoken cookie value>
X-Requested-With: XMLHttpRequest
Origin:  https://uprintbd.com
Referer: https://uprintbd.com/uprint/set_options/<recordId>/

{
  "total_copies":         <copies>,
  "total_cost":           <pages * copies * unitPrice>,
  "pages":                "all",
  "no_of_page":           <pages>,
  "duplex_option":        "one-sided",
  "print_progress_status":"In Queue",
  "colorMode":            "MONO" | "COLOR",
  "layout":               "portrait",
  "paperSize":            "A4",
  "scale":                "false",       // UI label: "actual-size"
  "pagesPerSheet":        1,             // MUST be numeric
  "watermarkOption":      "no_watermark"
}
```
- **Success = HTTP 200** (the site returns `{"status":"OK"}`).
- On non-200 we scrape Django's leaked `exception_value` for a precise reason:
  ```js
  /<pre class="exception_value">([^<]+)<\/pre>/
  ```

### Field notes (the ones that bite)
| Field | Gotcha |
|---|---|
| `pagesPerSheet` | Must be the **number** `1`. Sending `"one"` (the select's label) → `500 ValueError: Field 'pagesPerSheet' expected a number but got 'one'`. The site's own `calculateCost()` converts the label to an int before sending; we send the int directly. |
| `scale` | String `"false"` (not boolean). Represents "actual size". |
| `X-CSRFToken` | Required for the JSON POST. Missing it → `403 CSRF token missing`. Uses the **cookie** value, not the form field. |
| `total_cost` | Must match `no_of_page × total_copies × unit`. We compute it the same way the site does. |

## 6. `GET /uprint/dashboard/` — scrape the OTP

The OTP appears in the dashboard's job table immediately. Each row shows the OTP in a
styled cell **right before** a per-row countdown cell `<td id="seconds<recordId>">`.
We anchor on that countdown id so we can never read a different job's code:

```js
// primary — anchored to this job's countdown cell
new RegExp(`text-danger fw-bold fs-5">\\s*(\\d{4,8})\\s*</td>\\s*<td id="seconds${recordId}"`)

// fallback — the nearest OTP-styled cell in the 400 chars before id="seconds<recordId>"
html.indexOf(`id="seconds${recordId}"`) ...
```

Because there can be a brief re-render race, we try once, wait **900 ms**, and try again
before giving up with "queued but no OTP appeared."

The OTP is a **4–8 digit** code (6 in practice), valid ~1 hour.

---

## 7. Cancellation / cleanup

```
GET /uprint/delete_print_request/<recordId>/?file_id=<recordId>
Referer: https://uprintbd.com/uprint/dashboard/
```
- Treated as success on `200` **or** `302`.
- Used by `POST /api/cancel` and by every test script to leave the account clean.

---

## 8. `GET /uprint/print_history/` — the settlement ground truth

This is the endpoint the whole "you are only charged if it printed" guarantee rests on.
It is the only place UprintBD tells us whether paper actually came out of a printer.

```
GET /uprint/print_history/?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Referer: https://uprintbd.com/uprint/dashboard/
```

- Both date params or neither. Omitting them returns the account's default window;
  `getPrintHistory({ sinceMs })` converts a timestamp to a **Asia/Dhaka** date, because
  the site's dates are local and a UTC date would drop the evening's prints.
- The table is `#userPrintHistoryDataTable`. Columns observed live:

  | Column | Example | Used for |
  |---|---|---|
  | Date Time | `2026-08-25 14:02:11` | stored as `printedAt` |
  | File name | `AssignmentCover_EEE417_24702008_K7Q2M9.pdf` | **the join key** |
  | Cost | `2.0` | `actualCost` — cost of goods, never the student's price |
  | Total copies | `1` | sanity check |
  | No of Pages | `1` | sanity check |
  | Print Status | `Completed` | **the settle trigger** |
  | Device ID | `CU-KIOSK-1` | stored on the job; tells you which kiosk |

- `parsePrintHistory()` reads the `<thead>` and maps columns **by header text**, falling
  back to fixed indices. Column order is the sort of thing a vendor reorders without
  telling anyone, and a silent off-by-one here would charge the wrong amount.

### Why the filename is the join key

There is **no record-id column**. `recordId` — the handle used to mint and to delete a
job — does not appear in history at all, so the filename is the only thing linking a
history row back to the person who paid for it. That is why every job gets a
server-generated unique filename (`…_K7Q2M9.pdf`, six chars off the job id) and why
`/printIndex/{fileKey}` exists. The prototype's `AssignmentCover_EEE_417_24702008.pdf`
was reproducible by anyone holding that roll number: two students printing the same cover
on the same day would have been indistinguishable, and one would have paid for the
other's page.

Rows that cannot be attributed to a job land in `/admin/uprint/unmatchedPrints`. **That
counter is the leak detector and it must stay at zero** — a print we cannot attribute is
a page the institution paid for and nobody was charged for.

---

## 9. `GET /uprint/transaction_history/` — proof of the charge model

Not used in the runtime path; it is here because it is the evidence that the
reserve → settle design mirrors UprintBD's own behaviour rather than guessing at it.

A live 1-page mono job showed:

```
14:02:11   Print job Completed        print_history:  Cost 2.0
14:02:48   From Print   −2.0 Tk       transaction_history
```

UprintBD debited the institutional account **37 seconds after the print completed** — not
when the OTP was minted. Minting a code reserves nothing on their side and costs nothing
if it is never used. So charging a student at mint time would have made us stricter than
the vendor we sit on top of, and would have had us holding money for pages that were
never printed. The ledger's `reserve → settle → release` is the same shape, one level up.

---

## 10. Profile / wallet (JWT side — optional)

Separate from the session flow, the site exposes a JWT API used for the wallet balance:

```
POST /api/user/login/      {email, password}  → { success: { token: { access } } }
GET  /api/user/profile/    Authorization: Bearer <access>   → profile JSON
```
`UprintSession.getProfile()` uses this and backs `GET /api/profile` on the bridge. It is
**not** part of the OTP flow.

---

## 11. End-to-end summary

```
GET  /login/                          csrftoken cookie + form token
POST /login/                          302 /home/, sets sessionid
GET  /uprint/dashboard/               fresh csrfmiddlewaretoken
POST /uprint/uploader/  (multipart)   302 /uprint/set_options/<id>/     ← recordId
POST /uprint/accept_print_info/<id>/  200 {"status":"OK"}               ← mints OTP
GET  /uprint/dashboard/               scrape OTP anchored to seconds<id>
```

Return contract from `printAndGetOtp()`:
```json
{
  "ok": true, "otp": "902306", "recordId": "13694",
  "filename": "AssignmentCover_EEE-411_24702008_K7Q2M9.pdf",
  "pages": 1, "copies": 1, "color": false,
  "cost": 3, "currency": "BDT", "validForSeconds": 3600
}
```

`cost` here is the **declared** figure from §0 — what we told UprintBD. In production the
bridge does not show it to anyone: the API layer replaces it with the wallet `price` from
`/config/pricing`, and the reconciler later attaches the `actualCost` scraped from §8.

Then, one minute later (or sooner, if `/api/print` finds the reconciler stale):

```
GET  /uprint/print_history/?start_date=…   filename Completed → settle: charge `price`
GET  /uprint/dashboard/                    still queued? → leave the hold alone
GET  /uprint/delete_print_request/<id>/    lapsed → delete FIRST, then release the hold
```

Deleting before releasing closes the one real leak in the design: if the money went back
first and the code still worked, a student could print on a hold that no longer existed.

---

## 12. Why this is robust *and* honest

- It is **not** an exploit. It uses documented, ordinary web endpoints with valid
  credentials, in the same order and with the same payloads as the official UI.
- It is **contained**: if UprintBD changes their markup, only the two regexes and the
  payload in this one file need updating.
- It is **replaceable**: the moment an official API exists, this module's internals get
  swapped and the `{ otp, cost, … }` contract stays identical.

See [SECURITY.md](SECURITY.md) for the responsible-use posture and the "ask" to UprintBD
(a blessed institutional account + a traffic allow-list note).
