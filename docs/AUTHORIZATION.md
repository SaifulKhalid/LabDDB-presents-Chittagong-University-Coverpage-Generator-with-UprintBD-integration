# Authorization & Role-Based Access Control (RBAC)

## 1. Role Hierarchy

The platform implements 4 distinct privilege levels:

| Role | Target Users | Endpoints Permitted | Enforcing Mechanism |
| :--- | :--- | :--- | :--- |
| **Anonymous** | Visitors, public health monitors | `GET /api/health`<br>`GET /api/config` | Public router paths; no auth header required. |
| **Authenticated Student** | Signed-in students with CU / Google account | `GET /api/me`<br>`POST /api/print`<br>`GET /api/jobs`<br>`POST /api/cancel` | `requireUser()` verifies valid ID token; user must not be disabled. |
| **Catalogue Admin** | Department heads, course coordinators | `POST /api/cover-token`<br>`admin.html` | Checked against `roles/<uid>/coverAdmin === true` or Project Admin. |
| **Project Admin** | System owner / institution administrator | `GET/POST /api/admin/*`<br>`console.html` | Hardcoded email match against `ADMIN_EMAIL` (default `htmlwithkhalid@gmail.com`). |

---

## 2. Invariant INV-14: Administrative Email Authorization

Administrative routes under `/api/admin/*` cannot be accessed via role database flags alone. This prevents privilege escalation even if the database permissions were misconfigured.

- The system verifies the authenticated token's `identity.email`.
- Compares case-insensitively with `env.ADMIN_EMAIL`.
- Only exact email matches are granted administrative access.
- Any mismatch yields `403 Forbidden` (`"This area is restricted."`).

```javascript
function isProjectAdmin(identity, adminEmail) {
  if (!identity || !identity.email || !adminEmail) return false;
  return identity.email.toLowerCase() === adminEmail.toLowerCase();
}
```

---

## 3. Account Disabling & Ban Policy

If an account is flagged for abuse (e.g. attempting to submit malformed PDFs or spamming requests):

1. An administrator toggles the user's disabled flag:
   ```http
   POST /api/admin/users/flags
   Content-Type: application/json

   { "uid": "user_123", "disabled": true }
   ```
2. The mutation records `disabled: true`, `disabledBy: admin.uid`, and `disabledAt: Date.now()`.
3. Every subsequent call to `POST /api/print` checks `user.disabled` and rejects immediately with `403 Forbidden`:
   `"This account has been disabled. Please contact the administrator."`
4. Active holds for a disabled user remain locked until expired or settled to preserve double-entry accounting integrity.

---

## 4. Catalogue Token Minting Authorization (Resolving Discrepancy #1)

In prior legacy code, `POST /api/cover-token` was open to anonymous visitors. In the rebuilt platform:

- The endpoint checks the caller's identity.
- Allowed only if:
  1. Caller is Project Admin (`isProjectAdmin === true`), OR
  2. Caller has database flag `roles/<uid>/coverAdmin === true`, OR
  3. Server environment explicitly sets `ALLOW_PUBLIC_CATALOGUE_EDIT=true` (for staging or demo environments).
- Unauthenticated or unauthorized callers receive `401 Unauthorized` or `403 Forbidden`.
