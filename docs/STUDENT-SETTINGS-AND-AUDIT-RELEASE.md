# Student Settings, Authenticated Profile Persistence & Complete Activity Auditing

**Release Type**: Production Feature Change  
**Date**: 2026-09-03  
**Status**: ✅ FEATURE COMPLETE

---

## Scope

This release adds three production features to the LabDDB / UprintBD cover page platform:

1. **Student Settings Access** — Any signed-in student can mint a `lddb-demo` custom token and edit the course catalogue; anonymous visitors cannot.
2. **Authenticated Profile Persistence** — A student's roll number is persisted server-side at `users/<uid>/profile/roll` and **never** written to `localStorage` for anonymous sessions.
3. **Complete Activity Auditing** — All significant application events are logged to D1 (covers, catalogue, printing, auth, financial, admin, errors) with strict OTP minimization.

---

## Verification Matrix

| # | Test | Audit Script | Result |
|---|---|---|---|
| 1 | Anonymous `POST /api/cover-token` → 401 | `audit-auth-flow.js` | ✅ PASS |
| 2 | Expired/malformed token → 401 | `audit-auth-flow.js` | ✅ PASS |
| 3 | Authenticated student `POST /api/cover-token` → 200 + token | `audit-auth-flow.js` | ✅ PASS |
| 4 | Project admin `GET /api/me` → `projectAdmin: true, admin: true` | `audit-auth-flow.js` | ✅ PASS |
| 5 | Token verifier: missing, malformed, expired, disabled → 401/403 | `audit-security-auth.js` | ✅ PASS |
| 6 | `isProjectAdmin` email match + `emailVerified` enforcement | `audit-security-auth.js` | ✅ PASS |
| 7 | Student calling `/api/admin/overview` → 403 | `audit-security-auth.js` | ✅ PASS |
| 8 | Cross-tenant job cancellation (Student A on Student B job) → 404 | `audit-security-auth.js` | ✅ PASS |
| 9 | Anonymous `POST /api/cover-token` → 401 | `audit-student-settings-access.js` | ✅ PASS |
| 10 | Student `POST /api/cover-token` → 200 + `coverAdmin: true` token | `audit-student-settings-access.js` | ✅ PASS |
| 11 | Project admin `POST /api/cover-token` → 200 + `coverAdmin: true` token | `audit-student-settings-access.js` | ✅ PASS |
| 12 | `admin.js` has confirmation dialogs for course/experiment/assignment/student deletion | `audit-student-settings-access.js` | ✅ PASS |
| 13 | `admin.js` records `updatedBy` and calls `auditCatalogueAction` | `audit-student-settings-access.js` | ✅ PASS |
| 14 | Initial `GET /api/me` → `user.roll === ''` for new user | `audit-roll-persistence.js` | ✅ PASS |
| 15 | `POST /api/me/roll` persists roll to `users/<uid>/profile/roll` | `audit-roll-persistence.js` | ✅ PASS |
| 16 | Subsequent `GET /api/me` → `user.roll === '24702008'` | `audit-roll-persistence.js` | ✅ PASS |
| 17 | Anonymous `POST /api/me/roll` → 401 | `audit-roll-persistence.js` | ✅ PASS |
| 18 | `getRememberedRoll()` returns `''` when unauthenticated | `audit-roll-persistence.js` | ✅ PASS |
| 19 | Sign-out purges `labddb_remembered_roll` and dispatches empty `roll_changed` event | `audit-roll-persistence.js` | ✅ PASS |
| 20 | Form inputs cleared on sign-out in `app.js`, `experiment-cover.js`, `experiment-main-cover.js` | `audit-roll-persistence.js` | ✅ PASS |
| 21 | `sanitizeAuditData` strips OTP, password, token, secret (recursive) | `audit-activity-logging.js` | ✅ PASS |
| 22 | `matchesCategory` routes all event types to correct categories | `audit-activity-logging.js` | ✅ PASS |
| 23 | Anonymous `POST /api/activity` → 401 | `audit-activity-logging.js` | ✅ PASS |
| 24 | Authenticated `POST /api/activity { action: 'PDF_DOWNLOADED' }` → 200, logged | `audit-activity-logging.js` | ✅ PASS |
| 25 | Authenticated `POST /api/activity { action: 'COURSE_UPDATED' }` → 200, logged | `audit-activity-logging.js` | ✅ PASS |
| 26 | All 8 `/api/admin/*` endpoints reject anonymous with 401 | `audit-console-owner-only.js` | ✅ PASS |
| 27 | All 8 `/api/admin/*` endpoints reject regular student with 403 | `audit-console-owner-only.js` | ✅ PASS |
| 28 | Forged `admin: true` / `X-User-Role: admin` headers rejected with 403 | `audit-console-owner-only.js` | ✅ PASS |
| 29 | Owner `htmlwithkhalid@gmail.com` → 200 on `/api/admin/overview` | `audit-console-owner-only.js` | ✅ PASS |
| 30 | `npm test` — 130 ledger + 31 domain + 10 provider + 6 reconcile + 20 audit = **197 assertions** | `npm test` | ✅ PASS |

---

## Summary of Changes

### Backend

| File | Change |
|---|---|
| `lib/services/catalogue-service.js` | `mintCoverToken` grants token to any authenticated identity; anonymous → 401 |
| `lib/services/auth-service.js` | `updateUserRoll(uid, roll)` and `getUserRoll(uid)` for server-side roll at `users/<uid>/profile/roll` |
| `lib/api/handlers/user.js` | `handleMe` exposes `roll` and `roles.coverAdmin: true`; added `handleUpdateRoll` for `POST /api/me/roll` |
| `lib/api/handlers/activity.js` | New handler: `handleActivity` — validates action, logs via `auditLogger.logEvent` |
| `lib/api/router.js` | Mounted `POST /api/me/roll` and `POST /api/activity` |
| `lib/services/audit-service.js` | `sanitizeAuditData`, `matchesCategory`, `buildCategorySql`, `logEvent` — now exported; `matchesCategory` and `buildCategorySql` exported for test use |
| `lib/services/print-service.js` | `PRINT_REQUESTED`, `PRINT_OTP_CREATED` (no OTP in metadata), `PRINT_FAILED`, `PRINT_CANCELLED` audit events |
| `lib/services/reconcile-service.js` | `PRINT_COMPLETED`, `PRINT_EXPIRED`, `PRINT_FAILED` audit events |

### Frontend

| File | Change |
|---|---|
| `public/js/labddb-auth.js` | Removed anonymous roll localStorage; server-authoritative roll on sign-in; `logActivity` method; `labddb:roll_changed` event |
| `public/js/app.js` | Removed roll localStorage fallback; sign-out roll wipe; `PDF_DOWNLOADED` and `DIRECT_PRINT_INITIATED` auditing |
| `public/js/experiment-cover.js` | Same as `app.js` |
| `public/js/experiment-main-cover.js` | Same as `app.js` |
| `public/js/experiment-index.js` | Activity auditing for PDF downloads |
| `public/js/admin.js` | Lockscreen for anonymous users; confirmation dialogs for all destructive mutations; `updatedBy` tagging; catalogue mutations audited |
| `public/console.html` | Category filter dropdown; User Activity Timeline Inspector card |
| `public/js/console.js` | Category filtering; OTP masking as `[MASKED]`; `loadUserTimeline(uid)`; Activity jump button in Users table |

### Audit Scripts

| Script | Purpose |
|---|---|
| `scripts/audit-auth-flow.js` | Updated: student now expects 200 on cover-token |
| `scripts/audit-security-auth.js` | Verified: unchanged, all pass |
| `scripts/audit-student-settings-access.js` | **New**: student catalogue access and confirmation dialogs |
| `scripts/audit-roll-persistence.js` | **New**: server roll persistence and anonymous rejection |
| `scripts/audit-activity-logging.js` | **New**: activity API, OTP masking, category routing |
| `scripts/audit-console-owner-only.js` | **New**: admin endpoint RBAC and forged claim rejection |

### Documentation

| File | Status |
|---|---|
| `docs/AUTHORIZATION.md` | ✅ Updated — complete 3-level access model |
| `docs/STUDENT-SETTINGS-AND-AUDIT-RELEASE.md` | ✅ This document |

---

## Security Invariants Preserved

- **No OTP in audit logs**: `sanitizeAuditData` strips `otp`, `password`, `token`, `secret` recursively at the service layer before any D1 write.
- **No role trust from client**: `requireProjectAdmin` always re-resolves identity from Firebase Identity Toolkit; JWT claims injected by client are not used for authorization decisions.
- **No anonymous roll persistence**: `getRememberedRoll()` returns `''` when `state.user` is null; no `localStorage.setItem` call is made for roll data in any unauthenticated code path.
- **Cross-tenant isolation preserved**: Print jobs remain scoped to `jobs/<uid>/`; Student A cannot see or cancel Student B's job (404).
- **Financial invariants untouched**: All 130 ledger assertions pass; wallet, hold, settle, release, top-up, adjustment, and concurrency tests unchanged.

---

## FEATURE COMPLETE
