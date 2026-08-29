# Production setup

Everything needed to take this from a working prototype to a service students use, in the
order it has to happen. Budget about an hour for the first pass, most of it in the Firebase
console.

Two things are worth knowing before you start:

1. **The whole point of the design is that nobody is charged unless a page printed.** That
   property comes from a Cron Trigger reading UprintBD's own print history. If you skip
   the cron step, holds are never settled and nobody's balance ever changes. It is not an
   optimisation; it is the mechanism.
2. **Money moves only on the server.** Every `.write` in `firebase/labddb-pro.rules.json`
   is `false`. The Worker writes with a service account, which bypasses rules. So the two
   service-account keys are the crown jewels — everything else can be public.

---

## 0. What you need in hand

| Thing | Where it comes from |
|---|---|
| A Firebase project named **LabDDB-Pro** | create it; Auth + wallet live here |
| The existing **lddb-demo** project | already live; courses and students |
| A funded **UprintBD institutional account** | email + password, topped up via bKash |
| A Cloudflare account | free tier works; see the CPU note in §7 |
| Node ≥ 20 | for local dev and the tests |

---

## 1. LabDDB-Pro: create the project

Firebase console → **Add project** → name it `LabDDB-Pro`. Google Analytics is not needed.

Then:

1. **Build → Authentication → Get started → Google.** Enable it. Set the public-facing
   name and a support email.
2. **Authentication → Settings → Authorized domains.** Add your production domain (e.g.
   `pitch.labddb.workers.dev` [formerly `labddb-uprint-pitch.<subdomain>.workers.dev`], plus any custom domain). Sign-in fails
   with `auth/unauthorized-domain` until this is done, and the error surfaces in the
   sign-in sheet — so if the button does nothing, check here first.
3. **Build → Realtime Database → Create database.** Pick the region closest to Dhaka
   (`asia-southeast1`). Start in **locked mode** — the rules file replaces whatever you
   pick anyway.
4. **Project settings → General → Your apps → Add app → Web.** Copy the config object.

### The browser config is already filled in

`public/js/labddb-config.js` carries the live LabDDB-Pro values:

```js
authConfig: {
  apiKey: 'AIzaSyCiIoMvVrLEjfhDiQM24n_Z8tzmrZhV7Y4',
  authDomain: 'labddb-pro.firebaseapp.com',
  databaseURL: 'https://labddb-pro-default-rtdb.firebaseio.com',   // ← verify this one
  projectId: 'labddb-pro',
  storageBucket: 'labddb-pro.firebasestorage.app',
  messagingSenderId: '145808196263',
  appId: '1:145808196263:web:cad2016a87acaf44381182',
},
```

**`databaseURL` is the one field to check**, because the console's config snippet does not
include it and its host depends on the region you chose in step 3:

| Region | Instance URL |
|---|---|
| `us-central1` | `https://labddb-pro-default-rtdb.firebaseio.com` |
| anything else, e.g. `asia-southeast1` | `https://labddb-pro-default-rtdb.asia-southeast1.firebasedatabase.app` |

Copy the exact string printed above the tree on **Realtime Database → Data**, and use the
*same* value for the `LABDDB_DATABASE_URL` secret. If the browser and the bridge point at
different databases, sign-in still works and the wallet chip just sits at ৳0 while the real
balance moves somewhere else — a confusing failure, so it is worth one look now.

If your project id is not literally `labddb-pro`, fix `authDomain`, `databaseURL`,
`projectId` and `storageBucket` to match what the console gave you.

These values are **not secrets** — every Firebase web app ships them in plain JavaScript.
They identify the project; they authorise nothing. The rules file is what protects data.

`LabDDB.isAuthConfigured()` returns false while `apiKey` still starts with `REPLACE_WITH`,
and every page degrades honestly while it does: the generators keep working and the Get Kiosk
OTP button explains that sign-in is not configured yet rather than failing silently. With the
values above in place it returns true, so that button now gates on Google sign-in — which
means enabling the provider in step 1 is no longer optional.

---

## 2. Deploy the security rules

Both projects. This is the step that actually enforces everything above, and one of them
closes a live hole.

```bash
firebase deploy --only database --project labddb-pro    # firebase/labddb-pro.rules.json
firebase deploy --only database --project lddb-demo     # firebase/lddb-demo.rules.json
```

Or paste each file into **Realtime Database → Rules** in the respective console. The
`"//"` keys are comments; Firebase ignores them, and they explain each decision in place.

> **lddb-demo is currently wide open.** Anyone who views the page source today can rewrite
> every course, faculty name and student record. Deploy that file even if you do nothing
> else on this page.

What the two files do differently, and why:

- **labddb-pro** — `.write: false` everywhere. Reads are scoped to the owner
  (`auth.uid === $uid`), except `/config` which is world-readable so the cost calculator
  can quote a price before anyone signs in.
- **lddb-demo** — public **read** (anonymous browsing and PDF download are deliberate
  features), writes gated on `auth.token.coverAdmin === true`. Students never sign in to
  this project at all, so a plain `auth != null` check would have been meaningless here.
  The claim arrives via a one-hour custom token from `POST /api/cover-token`.

---

## 3. Service accounts

Two keys, one per project.

**LabDDB-Pro** — Project settings → **Service accounts** → Generate new private key.
This credential writes every wallet, job and ledger row.

**lddb-demo** — same place, same project settings but for lddb-demo. This one is used for
exactly one thing: minting the `coverAdmin` custom token. Omit it and coverpage admin
reports itself as unconfigured; everything else keeps working.

Both go in as **one line each**. To flatten a downloaded key without mangling the `\n`
escapes inside `private_key`:

```bash
node -e "console.log(JSON.stringify(require('./labddb-pro-key.json')))"
```

> These keys bypass the rules files you just deployed. Treat them like the UprintBD
> password. If one leaks, revoke it in Google Cloud console → IAM & Admin → Service
> accounts → Keys, and generate a replacement.

---

## 4. Secrets

### Cloudflare (production)

```bash
wrangler secret put UPRINT_EMAIL              # institutional UprintBD login
wrangler secret put UPRINT_PASSWORD
wrangler secret put FIREBASE_API_KEY          # LabDDB-Pro web API key
wrangler secret put LABDDB_PROJECT_ID         # labddb-pro
wrangler secret put LABDDB_DATABASE_URL       # https://labddb-pro-default-rtdb.firebaseio.com
wrangler secret put LABDDB_SERVICE_ACCOUNT    # the flattened JSON from §3
wrangler secret put LDDB_DEMO_SERVICE_ACCOUNT # the other flattened JSON
wrangler secret put ADMIN_EMAIL               # htmlwithkhalid@gmail.com
```

`FIREBASE_API_KEY` is the same public web API key from §1. It is a secret here only for
tidiness — it is used to call `identitytoolkit accounts:lookup` when verifying ID tokens.

### Local (`node server.js`)

Copy `.env.example` to `.env` and fill in the same eight values. `.env` is gitignored and
should stay that way.

---

## 5. Deploy

```bash
npm run deploy          # npx wrangler deploy
```

> [!NOTE]
> **Worker Rename & Propagation**: The Cloudflare Worker has been renamed from `labddb-uprint-pitch` to `pitch` (live at `https://pitch.labddb.workers.dev`).
> Note that it may take a few minutes for `pitch.labddb.workers.dev` edge routing to propagate and accept incoming requests after renaming/deploying.

`wrangler.toml` already carries the cron trigger:

```toml
[triggers]
crons = ["* * * * *"]
```

**Verify it landed.** Cloudflare dashboard → Workers & Pages → your worker → Settings →
Triggers → Cron Triggers should list one entry. If it is missing, holds are never settled
and every balance freezes. `/api/print` reconciles inline when the last run looks stale,
so an outage degrades to "settlement is late" rather than "money is stuck" — but that is a
safety net, not a substitute.

Check it is alive:

```bash
curl https://pitch.labddb.workers.dev/api/health
curl https://pitch.labddb.workers.dev/api/config     # should show pricing 3 / 5
```

`/config/pricing` and `/config/limits` do not need seeding: `loadPricing()` and
`loadLimits()` fall back to the defaults (3 mono, 5 colour, 3 open holds, 20 jobs/hour,
20 pages/job) until you save something in the console.

---

## 6. First sign-in and the admin bootstrap

Order matters slightly here, because a user record is created by the user, not the admin.

1. **Sign in yourself, on a normal page.** Open the generator, click **Get Kiosk OTP**,
   and sign in with Google as `ADMIN_EMAIL`. The browser calls `GET /api/me`, which creates
   `/users/{uid}` and an empty wallet. You can cancel out of the print.
2. **Open `/console.html`.** It is not linked from anywhere — type the URL. It checks your
   verified email against `ADMIN_EMAIL` server-side on every request; the hidden URL is
   convenience, not security. Any other account gets a locked screen naming itself.
3. **Users tab.** You should see yourself. Top yourself up 10 Tk to run the test in §8.

A student who has never signed in does not appear in the Users tab, because no record
exists yet. That is not a bug to work around: ask them to sign in once, then top them up.

### Granting coverpage admin

The catalogue admin (`/admin.html`) is a **separate** role from the project admin. Grant
it in the console: Users tab → the row → **Role** → enable coverpage admin. That writes
`/roles/{uid}/coverAdmin`, and `POST /api/cover-token` will then mint them an lddb-demo
custom token good for an hour.

Holding one role grants nothing on the other surface. The project admin can reach both;
a coverpage admin can never see a balance.

---

## 7. Free tier vs paid

RSA-signing a service-account JWT and base64-decoding an uploaded PDF in the same request
is tight against the free tier's **10 ms CPU** ceiling. The OAuth token is cached across
requests, so a warm isolate is usually fine, and a cold start usually is too — but "usually"
here means a student standing at a kiosk with no code.

The Workers Paid plan ($5/mo) removes the cliff. For a service that spends real money on
every request, it is the cheaper mistake.

The free tier's **50-subrequest** cap is a harder constraint and the code already respects
it: the admin endpoints do constant-cost reads (three RTDB calls for the whole jobs table,
not one per job) specifically so a busy day cannot break the console.

---

## 8. The headline test

Do this at a real kiosk, once, before telling anyone the service exists. It is the only
way to prove the guarantee, because it is the only way to observe a real print.

Top yourself up **10 Tk** from the console, then:

### Round one — mint a code and walk away

1. Generate a cover page and tap **Get Kiosk OTP**. You get a code.
2. The header chip should read **`৳7 available`** with 3 Tk reserved. The balance itself is
   still 10 — a hold is not a charge.
3. Do not print. Wait for the code to lapse (~1 hour, plus a 5-minute grace).
4. Within a minute of the grace expiring: the UprintBD record is deleted, the chip returns
   to **`৳10 available`**, and the wallet statement is **empty** — no charge, no refund.
   A print that never happened leaves no trace.

### Round two — mint a code and print it

1. Generate again, get a code, and actually print at the kiosk.
2. Within ~60 s the balance reads **`৳7`**, the statement shows one **charge of 3**, and
   the job reads **Printed** with `actualCost 2.0` and the kiosk's device id.
3. Console → Overview → **`unmatchedPrints` must still be 0.**

That last number is the leak detector. A print that cannot be attributed to a job is a
page the institution paid for and nobody was charged for, so it is surfaced on the
overview rather than logged and forgotten. If it is ever non-zero, the Reconcile tab lists
the offending history rows.

### The rest of the checks

- **Anonymous browser.** Generate a cover page and download the PDF with no account. It
  should work. Tapping Get Kiosk OTP should open the sign-in sheet, not an error.
- **Zero balance.** Sign in as a fresh account with no top-up and try to print: `402`,
  rendered as top-up instructions rather than a stack trace.
- **Access control.** Call `/api/admin/overview` with a non-admin token → `403`. Open
  `/admin.html` without the `coverAdmin` role → locked state. Try writing
  `/wallets/{uid}` from the browser console against LabDDB-Pro → permission denied.

Before any of that, the ledger logic itself:

```bash
npm test        # node scripts/test-ledger.js
```

No credentials, no network. It runs hold → settle → release against an in-memory database
that reproduces RTDB's ETag compare-and-swap, including a **forced** race — two holds on
one wallet inside a single tick — so the retry path is genuinely exercised rather than
assumed.

---

## 9. Running it

Day to day there is almost nothing to do. The cron settles prints; the console is for
top-ups.

**When a student pays by bKash:** take the payment first, then Users → **Top up**, and
paste the bKash transaction ID into the note. That ID is the only link between the money
that arrived and the balance you created — the ledger row is your reconciliation trail, so
it is worth typing.

**When a student says their code did not work:** Jobs tab → Open holds. It shows the code
itself, the filename and the age. If they never printed, let it expire; the money comes
back on its own. If UprintBD printed it but history has not caught up, **Force settle** is
safe to click twice — the ledger will not charge the same job again.

**Watch two numbers on the overview:**

- **UprintBD account balance.** When it runs dry nobody can print, however much DDB
  balance students are holding. It leads the overview for that reason.
- **`unmatchedPrints`.** Should be 0, always.

And keep in mind what the student-balance total means: it is a **liability, not income**.
Every taka there is a page someone has already paid for and has not printed yet.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in button does nothing | Production domain missing from Authorized domains (§1.2), or the Google provider was never enabled (§1.1) |
| "Console unavailable — set the LabDDB-Pro keys" | `labddb-config.js` `authConfig.apiKey` was reverted to a `REPLACE_WITH_…` placeholder (§1) |
| Wallet chip stuck at ৳0 while the ledger moves | `databaseURL` in `labddb-config.js` and the `LABDDB_DATABASE_URL` secret point at different instances — usually a region mismatch (§1) |
| Balances never change after a print | Cron trigger not deployed (§5) |
| `403` on every admin call | `ADMIN_EMAIL` secret does not match your Google account, or the account's email is not verified |
| Coverpage admin locked despite the role | `LDDB_DEMO_SERVICE_ACCOUNT` not set (§3) |
| `400 … index not defined` in logs | `labddb-pro.rules.json` not deployed; `recentJobs()` falls back to a full read, so printing still works |
| Print history parses but nothing settles | Filenames collide or predate the unique-suffix change — check `/printIndex` |

---

See also: [SECURITY.md](SECURITY.md) for the threat model,
[UPRINT-PROTOCOL.md](UPRINT-PROTOCOL.md) §8–9 for how settlement reads UprintBD's own
history, and [ARCHITECTURE.md](ARCHITECTURE.md) for where each piece lives.
