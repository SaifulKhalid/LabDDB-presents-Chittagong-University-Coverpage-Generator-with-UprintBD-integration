# Changelog

## 2.0.0 — Production Release

Production release freezing the complete, verified, and audited Chittagong University Cover Page Generator platform with automated UprintBD kiosk OTP bridge.

### Added
- **Double-Entry CAS Wallet Ledger:** Atomic Compare-And-Swap balance mutations on Firebase RTDB ETags (`if-match`), guaranteeing zero double-spends and zero negative balances under concurrency (`lib/domain/wallet.js`, `lib/services/ledger-service.js`).
- **Automated UprintBD Web Bridge:** Autonomous web session driver handling CSRF tokens, session cookies, multipart uploads, options configuration, and OTP extraction without official API dependencies (`lib/infrastructure/uprint/adapter.js`).
- **Autonomous Triple-Trigger Reconciliation:** Background cron engine (`* * * * *`) settling completed prints, releasing expired reservations, and deleting UprintBD kiosk records (`lib/services/reconcile-service.js`).
- **Zero-Dependency Firebase Auth & REST Client:** WebCrypto RS256 JWT signing and Google Identity Toolkit REST verification without bulky SDKs (`lib/infrastructure/firebase/`).
- **Enterprise Clean Architecture:** Modularization into `domain`, `infrastructure`, `services`, and `api` layers with full backward-compatible facade exports.
- **Relational Audit & Job Storage:** Cloudflare D1 integration (`schema.sql`) recording structured audit logs, user histories, and ledger statements.
- **Object Storage Archival:** Cloudflare R2 integration for archiving generated cover page PDFs.
- **Catalogue Selection & Recency Engine:** Shared catalogue layer (`LabDDB.catalogue`) auto-selecting the newest course/experiment while preserving user selections (`public/js/labddb-config.js`).
- **Server-Side Roll Persistence:** Remembers authenticated student roll numbers across devices via `/api/me/roll` while strictly keeping anonymous visitors in-memory.
- **Privileged Owner Console:** Dedicated administration portal (`console.html`) restricted exclusively to `htmlwithkhalid@gmail.com`.
- **Comprehensive Automated Audit Suites:** 15+ automated suites spanning unit tests (215+ assertions), live UprintBD integration, Puppeteer PDF/print audits, mobile viewports, concurrency, idempotency, and secret hygiene.

### Changed
- **Production Service Target:** Worker service renamed to `pitch`, deployed to `https://pitch.labddb.workers.dev`.
- **Three-Tier Authorization Model:** Clear separation of capabilities between Anonymous visitors, Signed-in Students, and Project Owner (`htmlwithkhalid@gmail.com`).
- **A4 Print Layout Geometry:** Uniform 12mm page margin layout with double-border inset and balanced vertical flex distribution.
- **Mobile-First Responsive UI:** Rebuilt styling around `--touch-target: 44px`, `--safe-top`, `100dvh`, and pure `min-width` media queries.

### Fixed
- **Single-Page Constraint:** Resolved vertical page spillovers across all 4 cover page generator types, ensuring strict 1-page A4 output.
- **Direct Print Distortions:** Fixed direct browser print clipping and missing borders during `window.print()`.
- **Mobile Access Gate & Touch Targets:** Corrected admin sign-in sheet z-index layering and 44px touch target compliance across mobile devices.
- **Wallet Race Protection:** Fixed race conditions in concurrent hold requests through CAS retry loops with exponential backoff.
- **Secret Hygiene Remediation:** Replaced mock RSA key strings in test suites to ensure 0 secret detector leaks.

### Security
- **Strict Zero-Write Client Rules:** Disabled client-side database writes across `labddb-pro.rules.json`; all financial mutations execute via privileged service account.
- **Authoritative Server RBAC:** Gatekeeping verifies Identity Toolkit email directly on every request rather than trusting client JWT claims.
- **INV-6 Reversal Invariant:** Pre-deletion at UprintBD before hold release prevents free-print race conditions.
- **Data Minimization:** Sanitized audit logging automatically strips OTPs, passwords, and tokens before persistence.
- **Tracked Secret Audit:** Enforced clean repository hygiene with automated detection of private keys, credentials, and session cookies.

### Infrastructure
- **Cloudflare Workers Deployment:** Edge deployment configuration with Node.js compatibility flags and cron triggers in `wrangler.toml`.
- **Cloudflare D1 & R2 Bindings:** Relational database (`labddb-uprint-db`) and object bucket (`labddb-covers`).
- **Repository Hygiene:** Updated `.gitignore` to strictly isolate `.env`, `.env.*`, service account JSON keys, Wrangler state, and temporary probe dumps.

---

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
