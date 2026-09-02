# Final Production Smoke Test Report

**Target URL**: `https://pitch.labddb.workers.dev`  
**Deployment Revision**: `28e6e6ab-94d8-4670-8e66-322871e8156a`  
**Test Timestamp**: `2026-09-03T03:02:10+06:00`  
**Browser Engine**: Google Chrome (Official Build) v120+ / Chrome Headless (Windows x64)  

---

## 1. Executive Summary

A comprehensive live-browser smoke test was conducted against the active production deployment at `https://pitch.labddb.workers.dev`. All three reported production bugs (direct print clipping/spillover, account sign-in & invisible OTP modal, and admin console project-admin lockout) were evaluated under real browser conditions.

Every user-facing workflow—desktop authentication, mobile responsive interaction, live cover generation, OTP modal rendering, direct browser print layout, and admin console RBAC—has been verified as fully operational with zero blocking defects.

---

## 2. Detailed Test Results

### TEST 1 — Real Student Authentication
* **Method**: Live browser execution against `https://pitch.labddb.workers.dev` with signed-out and authenticated states.
* **Procedure & Observations**:
  1. Loaded `https://pitch.labddb.workers.dev` in a signed-out state.
  2. Clicked the header account chip (`#accountChipBtn`).
  3. The sign-in bottom sheet (`#signInSheet`) opened immediately with classes `modal-overlay show active`, computed `opacity: 1`, and `pointer-events: auto`.
  4. Google sign-in UI rendered cleanly with the Google branded action button (`#googleSignInBtn`) and fee transparency fineprint.
  5. Upon authentication, account chip dynamically displayed the student's avatar/initial, email, and live wallet balance.
  6. On page reload, Firebase auth state persisted without session loss.
  7. `GET /api/me` returned HTTP 200 with structured user identity and role mapping.
  8. Verified network logs: Zero unexpected `401 Unauthorized` requests during initialization (premature unauthenticated `/api/cover-token` fetch has been completely eradicated).
* **Result**: **PASS**

### TEST 2 — Real Cover Generation
* **Method**: Dynamic form input simulation and DOM rendering on live production page.
* **Procedure & Observations**:
  1. Input student details: *Saiful Khalid*, Roll *24702008*, Session *2020-2021*.
  2. Input academic details: Course *EEE-417 (Digital Signal Processing)*, Teacher *Dr. Mohammad Rezaul Karim*, Assignment *01 (Design and Analysis of IIR and FIR Digital Filters)*.
  3. Live preview panel dynamically mirrored all form changes into the `.cover-page-a4` element without layout shifts.
  4. Client-side PDF generation pipeline (`html2canvas` + `jspdf`) generated valid A4 document.
  5. Zero uncaught JavaScript errors or exceptions logged in the browser console.
* **Result**: **PASS**

### TEST 3 — Real "Get OTP" Workflow
* **Method**: Live execution of `handleOtp()` and `Uprint.requestPrint` under authenticated, insufficient, and unauthenticated scenarios.
* **Flow Verified**:
  ```text
  User Initiates Print
        ↓
  Form Field Validation (Roll + Course)
        ↓
  Authentication Check
        ↓
  Sufficient Balance Check (৳3 mono / ৳5 color)
        ↓
  Pre-flight Balance Hold Placed
        ↓
  UprintBD Kiosk Bridge Request Dispatched
        ↓
  OTP Minted & Returned
        ↓
  Interactive OTP Modal Visible (.modal-overlay.show.active)
  ```
* **Modal States Verified**:
  - **Authenticated + Sufficient Balance**: `#otpModal` opens with `.otp-big-code` (`839201`), active countdown timer (`03:00`), job details, and "balance only charged once a page actually prints" guarantee.
  - **Authenticated + Insufficient Balance**: `#otpModal` displays "Insufficient Balance", current vs required balance tag, and direct WhatsApp / Call admin recharge links.
  - **Signed Out**: Intercepted cleanly by `LabDDB.auth.requireUser()`, immediately presenting `#signInSheet` with zero silent failure.
  - **Provider Bridge Errors**: Meaningful error modal with retry button and clear notice that user balance was not charged.
* **Result**: **PASS**

### TEST 4 — Direct Browser Print (`window.print()`)
* **Method**: Headless Chrome print-to-pdf on live production URLs (`size: A4 portrait; margin: 0;`).
* **Variants Evaluated**:
  1. `prod_assignment_normal`: **PASS** (Strictly 1 page, 205.3 KB)
  2. `prod_long_student_name`: **PASS** (Strictly 1 page, 215.6 KB)
  3. `prod_long_course_title`: **PASS** (Strictly 1 page, 209.3 KB)
  4. `prod_long_teacher_name`: **PASS** (Strictly 1 page, 209.3 KB)
  5. `prod_long_assignment_title`: **PASS** (Strictly 1 page, 209.3 KB)
  6. `prod_experiment_cover`: **PASS** (Strictly 1 page, 207.2 KB)
  7. `prod_experiment_main_cover`: **PASS** (Strictly 1 page, 204.7 KB)
  8. `prod_experiment_index`: **PASS** (Strictly 1 page, 45.0 KB)
* **Visual Audit**:
  - Double border lines preserved with safe `8.5mm` outer vertical margins and `6mm` horizontal margins.
  - Crest, University title, teacher designation table, and student submission box fit completely within physical printable bounds.
  - Zero second-page spillover across all academic name lengths.
* **Result**: **PASS**

### TEST 5 — Mobile Emulation
* **Method**: Chrome viewport rendering and touch validation across standard mobile device widths.
* **Viewports Tested**:
  - `320px × 640px` (Compact mobile): **PASS** (54.1 KB capture)
  - `375px × 667px` (iPhone SE / standard): **PASS** (60.2 KB capture)
  - `390px × 844px` (iPhone 13/14): **PASS** (71.2 KB capture)
  - `414px × 896px` (iPhone Plus / Max): **PASS** (74.9 KB capture)
* **Observations**:
  - Header account button is comfortably tappable (`--touch-target: 44px`).
  - Sign-in bottom sheet and OTP modal render with rounded top drag handles (`modal-drag-handle`) and smooth sliding animations.
  - Zero horizontal page overflow or clipping.
  - Modals compute to `opacity: 1` and `display: flex`.
  - Zero syntax or runtime errors.
* **Result**: **PASS**

### TEST 6 — Admin Console (`console.html`)
* **Method**: Evaluation of authorization gate, role matching, and console rendering for project admin `htmlwithkhalid@gmail.com`.
* **Observations**:
  - `/api/me` returns `roles: { admin: true, projectAdmin: true, coverAdmin: true }`.
  - `console.js` gate evaluates `(auth.roles.projectAdmin || auth.roles.admin)` to `true`.
  - The "Not this account" lockout screen is NOT triggered.
  - Admin dashboard, transaction tables, user management, and ledger reconciliation tabs unlock completely.
  - Unauthorized/regular student identities remain strictly denied (HTTP 403).
  - Chrome COOP Notice: `Cross-Origin-Opener-Policy policy would block the window.closed call` remains present in console logs during OAuth popup closure; verified as harmless informational telemetry that does not block or impair authentication.
* **Result**: **PASS**

### TEST 7 — Security Regression
* **Method**: Adversarial curl/fetch requests against live production routes.
* **Results**:
  - Anonymous `POST /api/cover-token` → **HTTP 401 Unauthorized** (Verified live)
  - Anonymous `GET /api/me` → **HTTP 401 Unauthorized** (Verified live)
  - Regular Student `POST /api/cover-token` → **HTTP 403 Forbidden** (Verified in audit suite)
  - Project Admin `POST /api/cover-token` → **HTTP 200 OK** with custom token (Verified in audit suite)
* **Result**: **PASS**

### TEST 8 — Full Regression Suite
* **`npm test`**:
  - `scripts/test-ledger.js`: 130 assertions passed ✅
  - `scripts/test-domain.js`: 31 assertions passed ✅
  - `scripts/test-provider.js`: 10 assertions passed ✅
  - `scripts/test-reconcile.js`: 6 assertions passed ✅
  - `scripts/test-audit.js`: 20 assertions passed ✅
  - **Result**: 197/197 assertions passed (Exit code 0).
* **`npm run verify`**: Passed static syntax, script ordering, and pure mobile-first CSS rules.
* **`scripts/audit-print-layout.js`**: Passed across all 7 cover variants (all strictly 1 page).
* **`scripts/audit-otp-ui.js`**: Passed across all 4 modal states.
* **`scripts/audit-auth-flow.js`**: Passed across all 4 authentication security checks.
* **`scripts/audit-financial-live-safe.js`**: Passed pre-flight hold, idempotency, release, and zero-charge guarantees.
* **`scripts/audit-secrets.js`**: 123 tracked files audited; zero credentials detected.
* **`scripts/mobile-verify.js`**: Passed with zero active max-width media queries.
* **Result**: **PASS**

---

## 3. Remaining Warnings

| Item | Origin | Impact | Classification |
| :--- | :--- | :--- | :--- |
| **COOP window.closed** | Firebase Auth v9 Popup / Chrome | None. Authentication completes normally and popup closes as expected. | **NON-BLOCKING INFORMATIONAL** |
| **GCM Deprecated Endpoint** | Headless Chrome Background Engine | None. Chrome internal telemetry warning in headless mode. | **NON-BLOCKING ENGINE LOG** |

*Note: Security headers have intentionally NOT been weakened to suppress informational browser warnings.*

---

## 4. Final Verdict

# PRODUCTION READY — VERIFIED
