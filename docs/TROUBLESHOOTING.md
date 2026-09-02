# Operational Troubleshooting Guide

## 1. Quick Diagnostic Checklist

When investigating an issue in production or development:

1. **Check System Health**:
   ```bash
   curl -s http://localhost:3000/api/health
   # or https://your-worker.workers.dev/api/health
   ```
   *Expected*: `{"ok":true,"configured":true,"missing":[]}`.
   If `configured: false`, examine the `missing` array for unconfigured credentials.

2. **Run Test Suites**:
   ```bash
   npm test
   npm run verify
   ```

3. **Check Cloudflare Worker Logs**:
   ```bash
   npx wrangler tail
   ```

---

## 2. Common HTTP Errors & Remediation

### HTTP 401 Unauthorized
- **Symptom**: `{"ok": false, "error": "Sign in to continue."}`
- **Cause**: Client did not send `Authorization: Bearer <token>` or the Firebase ID token is expired (>1 hour).
- **Remediation**: Refresh token in frontend via `firebase.auth().currentUser.getIdToken(true)`.

### HTTP 402 Payment Required
- **Symptom**: `{"ok": false, "error": "Not enough balance...", "required": 6, "available": 3}`
- **Cause**: The student's `available` balance is lower than the job quote. Remember: `available = balance - reserved`. Active unprinted OTPs hold money.
- **Remediation**: The student can either top up their balance via bKash or cancel an existing unused OTP at `/api/cancel`.

### HTTP 409 Conflict
- **Symptom**: `{"ok": false, "error": "This document was already submitted...", "jobId": "job_..."}`
- **Cause**: INVARIANT INV-4 duplicate protection triggered: `clientJobId` matches an existing job created within the last 10 minutes.
- **Remediation**: The frontend should display the existing job's OTP rather than charging a new hold.

### HTTP 412 Precondition Failed / CAS Conflict
- **Symptom**: Internal retry log `ConflictError: 412 Precondition Failed`.
- **Cause**: Two processes modified the same user's wallet simultaneously.
- **Resolution**: `WalletService.applyToWallet` automatically retries up to 6 times with exponential backoff and jitter. If all 6 retries fail, it throws a safe error asking the user to try again.

### HTTP 429 Too Many Requests (Rate Limits)
- **Symptom**: `{"ok": false, "error": "You already have 3 unprinted codes active...", "code": "TOO_MANY_HOLDS"}`
- **Cause**: Student reached `maxOpenHolds` limit (default 3 concurrent unprinted codes).
- **Remediation**: Student must either print or cancel active codes before minting more.

### HTTP 502 Bad Gateway (Provider Errors)
- **Symptom**: `{"ok": false, "error": "The kiosk service could not create an OTP right now. Your balance was not touched."}`
- **Cause**: UprintBD website is down, session expired, or institutional wallet is out of credits.
- **Verification**: Check institutional balance via `GET /api/admin/uprint`. If out of credit, top up institutional UprintBD account.
- **Guarantee**: Held funds are immediately released back to the student (INV-16).

---

## 3. Investigating Reconciliation Issues

### Locked Reconciler Pass (`skipped: true`)
- If `admin/uprint/lastRun` reports `skipped: true` for multiple minutes:
  - Check `admin/uprint/lock` in RTDB.
  - The lock automatically expires after 90 seconds. If an isolate crashed mid-run, wait 90s or force run via `POST /api/admin/reconcile { "force": true }`.

### Unmatched Prints (`admin/uprint/unmatched`)
- If rows appear in `admin/uprint/unmatched`:
  - A physical document printed with a filename not matching any internal job.
  - This indicates either direct manual uploads through UprintBD's web portal or external usage of the institutional account credentials.
  - Inspect rows and clear via `POST /api/admin/unmatched { "key": "<fileKey>" }`.
