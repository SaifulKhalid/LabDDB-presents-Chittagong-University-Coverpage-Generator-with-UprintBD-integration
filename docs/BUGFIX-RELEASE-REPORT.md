# Production Bug-Fix Release Report

**Repository**: `LabDDB-presents-Chittagong-University-Coverpage-Generator-with-UprintBD-integration`  
**Target Environment**: Production (`https://pitch.labddb.workers.dev`)  
**Status**: Production Bug Fix Complete & Fully Verified  

---

## 1. Issue Analysis & Resolution Breakdown

### Issue 1 — Direct Browser Print Cuts Off Cover Page

* **Issue**:
  When users printed via the browser's direct print flow (`Preview → Print` / `window.print()`), the cover page borders, bottom margins, or student information were physically cut off or spilled onto a second page. The PDF generator worked properly, but direct printing clipped edges on standard hardware printers.
* **Root Cause**:
  1. `@media print` had `@page { size: A4 portrait; margin: 6mm; }` which conflicted with browser hardware printer non-printable margins.
  2. Inline scale and positioning styles (including negative margins and `794px` min-width) left on `.preview-scale-wrapper` by interactive zoom (`applyScale()`) were not cleanly overridden during print.
  3. The `.cover-page-a4` element had `width: 100% !important; height: auto !important; max-height: 280mm !important;`, causing unpredictable vertical expanding and outer border clipping on hardware printers with physical margins.
* **Files Changed**:
  - [`public/css/styles.css`](file:///f:/Territory/MissionUprint/Pitch/public/css/styles.css)
* **Exact Fix**:
  - Configured `@page { size: A4 portrait; margin: 0; }` to establish exact 210mm × 297mm physical A4 boundaries.
  - Formatted `.cover-page-a4` and `.index-page-a4` to a standardized printable viewport matching the PDF generator: `width: 198mm !important; height: 280mm !important; margin: 8.5mm auto !important; box-sizing: border-box !important; border: 2px solid #003366 !important;` with inner border at `5px` inset.
  - Reset `.preview-scale-wrapper`, `.preview-canvas-viewport`, `.preview-panel`, and `.app-layout` during print (`width: 210mm; height: 297mm; transform: none; min-width: 0; margin: 0; padding: 0; overflow: hidden;`).
  - Added strict print typography and table constraints (`cover-header`, `cu-crest`, `cover-title`, `cover-table`, `faculty-block`, `student-info`) with `break-inside: avoid; page-break-inside: avoid;` to prevent text spillover.
* **Tests Performed**:
  - `node scripts/audit-print-layout.js` (7 test cases: normal assignment, long student name, long course title, long teacher name, long assignment title, experiment cover, experiment main cover).
  - `node scripts/audit-pdf-visual.js` (visual dimension checks).
* **Before**:
  Outer borders clipped by printer hardware margins; long student names or multi-line course titles spilled over onto a blank second page.
* **After**:
  All 7 cover variants print on strictly 1 A4 page with safe margins (6mm horizontal, 8.5mm vertical), intact double borders, centered crest, and zero clipping or spillover.
* **Regression Status**: PASS (Zero regressions; all existing PDF generation and responsive layouts intact).

---

### Issue 2 — Student Sign-in, Cover Token & Get OTP Do Nothing

* **Issue**:
  1. Console error on page load: `admin.js:1301 POST https://pitch.labddb.workers.dev/api/cover-token 401 (Unauthorized)`.
  2. Account chip in header did not open sign-in or account sheets on desktop or mobile.
  3. Clicking "Get OTP" or "Get Kiosk OTP" appeared to do nothing in the UI.
* **Root Cause**:
  1. **Premature Unauthenticated Fetch**: `admin.js` unconditionally ran `signInToDataApp()` on `boot()` on page load without an `Authorization` header. On the server, `mintCoverToken` properly rejected unauthenticated requests with 401. `admin.js` also had a `lockScreen()` helper that was never wired to `LabDDB.auth`.
  2. **Modal Invisibility Bug**: In [`public/css/styles.css`](file:///f:/Territory/MissionUprint/Pitch/public/css/styles.css), the visibility rule was `.modal-overlay.active`, `.drawer-backdrop.active`, and `.history-drawer.active`. However, [`public/js/labddb-auth.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/labddb-auth.js), [`public/js/uprint.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/uprint.js), and [`public/js/console.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/console.js) toggled `.classList.add('show')` and `.classList.remove('show')`. Because `.modal-overlay.show` was missing from CSS, the sign-in modal, OTP modal, insufficient balance modal, and history drawer opened in the DOM but remained at `opacity: 0; pointer-events: none`. To users, clicking the account icon or "Get OTP" appeared to do nothing.
  3. **Button Disabling**: `handleOtp` in generator scripts disabled `#otpBtn` without handling mobile `#floatOtpBtn` and lacked `.catch()` handlers, leaving buttons permanently disabled if unhandled rejections occurred.
* **Files Changed**:
  - [`public/css/styles.css`](file:///f:/Territory/MissionUprint/Pitch/public/css/styles.css)
  - [`public/js/uprint.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/uprint.js)
  - [`public/js/labddb-auth.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/labddb-auth.js)
  - [`public/admin.html`](file:///f:/Territory/MissionUprint/Pitch/public/admin.html)
  - [`public/js/admin.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/admin.js)
  - [`public/js/app.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/app.js)
  - [`public/js/experiment-cover.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/experiment-cover.js)
  - [`public/js/experiment-main-cover.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/experiment-main-cover.js)
  - [`public/js/experiment-index.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/experiment-index.js)
* **Exact Fix**:
  - Added `.modal-overlay.show`, `.drawer-backdrop.show`, and `.history-drawer.show` rules in `styles.css` so modals and drawers become immediately visible (`opacity: 1; pointer-events: auto;`).
  - Synchronized JavaScript classes in `uprint.js` and `labddb-auth.js` to add/remove both `show` and `active` (`overlay.classList.add('show', 'active')`).
  - Added structured API response handling in `uprint.js` for 200, 400, 401, 402, 403, 409, 429, 500, 502, 503 without silent catches or unhandled rejections.
  - Added `<div class="admin-lock" id="adminLock" hidden></div>` to `admin.html`.
  - Replaced unauthenticated `signInToDataApp()` in `admin.js` with `checkCatalogueAuth()`: gates on `LabDDB.auth.whenReady()`, shows `lockScreen` when signed out, requests `/api/cover-token` with Bearer token only when authenticated, and unlocks catalogue upon successful authorization.
  - Updated `handleOtp()` across all 4 generator scripts (`app.js`, `experiment-cover.js`, `experiment-main-cover.js`, `experiment-index.js`) to disable and re-enable both `#otpBtn` and `#floatOtpBtn`, with `.catch()` logging and recovery.
* **Tests Performed**:
  - `node scripts/audit-auth-flow.js`
  - `node scripts/audit-otp-ui.js`
  - `node scripts/mobile-verify.js`
* **Before**:
  `POST /api/cover-token 401` logged on page load; clicking account chip or "Get OTP" displayed nothing on screen due to missing CSS selector.
* **After**:
  Zero unauthenticated network calls on page load; catalogue admin displays sign-in lock screen; tapping account chip opens Google sign-in sheet; "Get OTP" displays interactive OTP countdown modal or recharge state immediately.
* **Regression Status**: PASS (Zero regressions).

---

### Issue 3 — Admin Console Says "Not This Account"

* **Issue**:
  When signing in to `console.html` with Google identity `htmlwithkhalid@gmail.com`, the console displayed:
  > *"Not this account. htmlwithkhalid@gmail.com is signed in, but the console is restricted to a single project admin account. Nothing here is available to other users."*
  Browser console also logged:
  `popup.ts:277 Cross-Origin-Opener-Policy policy would block the window.closed call.`
* **Root Cause**:
  1. **Role Key Mismatch**: `lib/api/handlers/user.js` in `handleMe` returned `roles: { admin: ctx.authService.isProjectAdmin(identity) }`. But `console.js` checked `if (!auth.roles.projectAdmin)`. Because `/api/me` returned key `admin` instead of `projectAdmin`, `auth.roles.projectAdmin` was `undefined` (falsy) on the client, triggering the lock screen.
  2. **Email Casing Sensitivity**: In `lib/infrastructure/firebase/token-verifier.js`, `allowed.includes(identity.email)` compared the lowercase allowlist against `identity.email` without calling `.toLowerCase()`.
  3. **COOP Informational Warning**: Standard Chromium warning when Firebase Auth SDK v9 compat polls `popup.closed` across cross-origin boundaries; non-blocking and harmless.
* **Files Changed**:
  - [`lib/api/handlers/user.js`](file:///f:/Territory/MissionUprint/Pitch/lib/api/handlers/user.js)
  - [`lib/infrastructure/firebase/token-verifier.js`](file:///f:/Territory/MissionUprint/Pitch/lib/infrastructure/firebase/token-verifier.js)
  - [`public/js/labddb-auth.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/labddb-auth.js)
  - [`public/js/console.js`](file:///f:/Territory/MissionUprint/Pitch/public/js/console.js)
* **Exact Fix**:
  - Updated `handleMe` in `lib/api/handlers/user.js` to return both `projectAdmin` and `admin` in `roles`:
    ```javascript
    roles: {
      admin: ctx.authService.isProjectAdmin(identity),
      projectAdmin: ctx.authService.isProjectAdmin(identity),
      coverAdmin: !!user.coverAdmin,
      disabled: !!user.disabled,
    }
    ```
  - Normalized `identity.email.toLowerCase().trim()` in `isProjectAdmin()` in `token-verifier.js`.
  - Updated `refreshProfile()` in `labddb-auth.js` to populate `projectAdmin: !!(roles.projectAdmin || roles.admin)`.
  - Updated `console.js` gate check to accept `auth.roles.projectAdmin || auth.roles.admin`.
* **Tests Performed**:
  - `node scripts/audit-security-auth.js`
  - `node scripts/audit-auth-flow.js`
* **Before**:
  `htmlwithkhalid@gmail.com` locked out of `console.html` with "Not this account".
* **After**:
  `htmlwithkhalid@gmail.com` recognized as verified project admin; console unlocks with full administrative access.
* **Regression Status**: PASS (Zero regressions; strict server-side authorization preserved).

---

## 2. Release Checklist

| Checkpoint | Result | Verification Method |
| :--- | :---: | :--- |
| **PRINT DIRECT** | **PASS** | `scripts/audit-print-layout.js` (7/7 cases strictly 1 A4 page, no clipping) |
| **MOBILE SIGN-IN** | **PASS** | `scripts/mobile-verify.js` & `scripts/audit-otp-ui.js` |
| **DESKTOP SIGN-IN** | **PASS** | `scripts/audit-auth-flow.js` |
| **COVER TOKEN** | **PASS** | `scripts/audit-auth-flow.js` (401 unauthenticated, 403 student, 200 admin) |
| **GET OTP** | **PASS** | `scripts/audit-otp-ui.js` & `scripts/audit-financial-live-safe.js` |
| **OTP MODAL** | **PASS** | `scripts/audit-otp-ui.js` (visible, countdown, code displayed) |
| **INSUFFICIENT BALANCE UI** | **PASS** | `scripts/audit-otp-ui.js` (visible, balance tag, WhatsApp/Call admin links) |
| **ADMIN CONSOLE** | **PASS** | `scripts/audit-security-auth.js` & `scripts/audit-auth-flow.js` |
| **GOOGLE POPUP** | **NON-BLOCKING WARNING** | Chrome COOP warning verified as non-blocking telemetry |
| **REGRESSION SUITE** | **PASS** | `scripts/test-all.js` (130 ledger, 31 domain, 10 provider, 6 reconcile, 20 audit) |

---

## 3. Final Indicator

**BUGFIX COMPLETE**
