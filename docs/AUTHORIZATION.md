# Authorization Model

> **Authoritative reference for access control policy.**  
> Last updated: 2026-09-03

---

## Three Effective Access Levels

The system implements exactly three effective access levels. Authorization is **always resolved server-side**. Client-provided role flags, custom headers, or forged JWT claims are explicitly disregarded.

| Level | Identity | Capabilities |
|---|---|---|
| `ANONYMOUS` | Unauthenticated visitor | Browse public catalogue, generate cover previews, download PDF (roll NOT persisted across sessions) |
| `SIGNED_IN_STUDENT` | Any verified Google account | All anonymous capabilities + server-side roll persistence, mint `lddb-demo` custom token, edit the course catalogue |
| `PROJECT_ADMIN` | `htmlwithkhalid@gmail.com` only | All student capabilities + exclusive access to `/api/admin/*` and the privileged Console |

---

## Project Administrator

The project administrator is statically configured via the `ADMIN_EMAIL` server-side environment variable:

```
htmlwithkhalid@gmail.com
```

> **This account is the only account with access to the privileged Owner Console and all `/api/admin/*` endpoints.**

The check is performed server-side in [`token-verifier.js`](../lib/infrastructure/firebase/token-verifier.js) by `requireProjectAdmin()` and `isProjectAdmin()`:

- The resolved identity email must **exactly match** `ADMIN_EMAIL` (case-insensitive).
- The Firebase account must have `emailVerified: true`.
- A disabled account is rejected with `403 Forbidden`.
- Client tokens with forged `admin: true` / `projectAdmin: true` / `roles.admin: true` fields are rejected — server identity is always freshly resolved from the Firebase Identity Toolkit.

---

## Anonymous (`ANONYMOUS`)

An anonymous visitor may:

- Browse the public cover generator at `index.html`, `experiment-cover.html`, `experiment-main-cover.html`
- Load and read the public course catalogue from `lddb-demo`
- Enter a roll number into the generator form (held **in-memory only** for the session)
- Download a PDF cover

An anonymous visitor may **not**:

- Persist their roll number across sessions (no `localStorage`, no server write)
- Call `POST /api/cover-token` — returns **401 Unauthorized**
- Call `POST /api/me/roll` — returns **401 Unauthorized**
- Call `POST /api/activity` — returns **401 Unauthorized**
- Access any authenticated endpoint

---

## Signed-in Student (`SIGNED_IN_STUDENT`)

Any Google account that signs in via Firebase Authentication becomes a `SIGNED_IN_STUDENT`. There is no allowlist — any verified Google account is a valid student.

A signed-in student may:

- Persist their roll number on the server at `users/<uid>/profile/roll` via `POST /api/me/roll`
- Retrieve their persisted roll on `GET /api/me` (returned as `user.roll`)
- Mint a `lddb-demo` custom token with `coverAdmin: true` claim via `POST /api/cover-token`
- Edit the course catalogue in `admin.html` (create, update, and delete courses, experiments, assignments, students)
- View their wallet balance, print history, and open jobs
- Request print OTPs via `POST /api/print`

A signed-in student may **not**:

- Access `/api/admin/*` endpoints — returns **403 Forbidden**
- View the Owner Console (`console.html`)
- Perform financial operations (top-up, adjustment) on other accounts

---

## Project Admin (`PROJECT_ADMIN`)

The project admin has all student capabilities, plus:

- Exclusive access to all `/api/admin/*` endpoints
- Exclusive access to `console.html` (Owner Console)
- Top-up and adjust any user's wallet
- Manage print jobs (force-settle, force-expire)
- View all audit logs and user activity timelines
- Configure print pricing and limits

---

## Custom Token Minting (`POST /api/cover-token`)

The `lddb-demo` Firebase Realtime Database uses Firebase Security Rules that require the caller to hold a custom token with the `coverAdmin: true` claim to perform writes.

| Caller | Result |
|---|---|
| Anonymous (no token) | `401 Unauthorized` |
| Authenticated student | `200 OK` — custom token with `coverAdmin: true` |
| Project admin | `200 OK` — custom token with `coverAdmin: true` |

The custom token is minted server-side by `CatalogueService.mintCoverToken()` in [`catalogue-service.js`](../lib/services/catalogue-service.js) using the `LDDB_DEMO_SERVICE_ACCOUNT` service account.

---

## Server-side Roll Persistence

| Scenario | Behavior |
|---|---|
| Anonymous visitor enters roll | In-memory only for the session; never written to localStorage or server |
| User signs out | `labddb_remembered_roll` localStorage key is explicitly purged; `labddb:roll_changed` event dispatched with `{ roll: '' }`; form inputs and previews cleared |
| User signs in | `GET /api/me` returns `user.roll` from `users/<uid>/profile/roll` |
| User saves roll while signed in | `POST /api/me/roll` writes to `users/<uid>/profile/roll` and `users/<uid>/roll`; `labddb:roll_changed` dispatched with the new roll |

---

## Audit Script References

| Script | What It Verifies |
|---|---|
| [`audit-auth-flow.js`](../scripts/audit-auth-flow.js) | Anonymous 401, expired/malformed token 401, student 200 on cover-token, admin 200 with project admin flag |
| [`audit-security-auth.js`](../scripts/audit-security-auth.js) | Token verifier edge cases, disabled account handling, RBAC gatekeeping, cross-tenant isolation |
| [`audit-student-settings-access.js`](../scripts/audit-student-settings-access.js) | Student catalogue access, anonymous rejection, confirmation dialogs, audit hooks |
| [`audit-roll-persistence.js`](../scripts/audit-roll-persistence.js) | Server-side roll persistence, anonymous rejection, sign-out wipe |
| [`audit-activity-logging.js`](../scripts/audit-activity-logging.js) | Activity logging, OTP masking, category filtering |
| [`audit-console-owner-only.js`](../scripts/audit-console-owner-only.js) | Admin endpoint rejection for anonymous/student, forged claim rejection, owner access |
