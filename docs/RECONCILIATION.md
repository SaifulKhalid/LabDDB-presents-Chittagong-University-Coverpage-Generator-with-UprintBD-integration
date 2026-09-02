# Autonomous Reconciliation Engine

## 1. Objective & Philosophy

Reconciliation is the autonomous background service that decides who actually printed and charges or releases held balances accordingly.

It relies on a single undeniable ground truth: **UprintBD's own `/uprint/print_history/` log**.
- If a row reads `Print Status: Completed`, paper emerged from the kiosk; the student is charged.
- If an OTP expires without appearing as Completed in history, the code is deleted from UprintBD and the reservation is released. The student pays nothing.

---

## 2. Triple Trigger Mechanism

Reconciliation runs automatically without requiring the user to keep the tab open or return to the site:

1. **Cloudflare Worker Cron Trigger (Production)**:
   - Configured in `wrangler.toml`:
     ```toml
     [triggers]
     crons = ["* * * * *"] # Every minute
     ```
   - Executes `export default { scheduled(event, env, ctx) { ... } }`.
2. **Node.js Local Interval (Development)**:
   - Configured in `server.js`:
     ```javascript
     setInterval(() => reconcile(ctx, { reason: 'interval' }), 60 * 1000);
     ```
3. **Lazy Stale Fallback on `/api/print`**:
   - Before processing a new print request, if `Date.now() - lastReconcileAt > 180000` (3 minutes), a non-blocking lazy pass is triggered immediately to ensure students have their available balance up to date.
4. **Administrative Manual Force**:
   - `POST /api/admin/reconcile` with `{ force: true }` bypasses locks and executes immediately.

---

## 3. Distributed Lock Protocol

To prevent two concurrent instances (e.g. Cron trigger overlapping with an admin forced pass) from racing:
- A lock node `/admin/uprint/lock` is maintained in RTDB:
  ```json
  { "at": 1725321600000, "owner": "cron" }
  ```
- Acquire uses RTDB `transaction()` with a 90-second TTL.
- If lock is held and `Date.now() - lock.at < 90000`, the pass skips execution gracefully (`skipped: true`).
- Released in `finally` block upon completion.

---

## 4. Reconciliation Algorithm & Flow

```mermaid
flowchart TD
    Start([Reconciliation Trigger]) --> Lock{Acquire Lock?}
    Lock -- No --> Skip([Skip Pass: Lock Active])
    Lock -- Yes --> GetOpen[Read /openJobs]
    GetOpen --> CheckEmpty{openJobs Empty?}
    CheckEmpty -- Yes --> UpdateState[Update lastReconcileAt & Exit]
    CheckEmpty -- No --> FetchHist[Fetch /uprint/print_history/]
    FetchHist -- Error --> Bailout[INV-7: Record Error, Leave Holds Untouched & Exit]
    FetchHist -- Success --> MapHist[Map Completed Rows by Normalized Filename]
    MapHist --> Loop[For Each Open Job]
    
    Loop --> MatchHist{Filename in Completed Map?}
    MatchHist -- Yes --> Settle[INV-1: Settle Job, Debit Balance, Clear Hold]
    Settle --> NextJob[Next Job]
    
    MatchHist -- No --> HasRecord{Has recordId?}
    HasRecord -- No --> CheckOld{Age > 3min?}
    CheckOld -- Yes --> RelUnissued[Release Failed Mint (No OTP)]
    CheckOld -- No --> NextJob
    RelUnissued --> NextJob
    
    HasRecord -- Yes --> CheckExp{Age > expiresAt + grace?}
    CheckExp -- No --> NextJob
    CheckExp -- Yes --> DelProv[INV-6: Delete at UprintBD]
    DelProv -- Delete Failed --> KeepHold[Keep Hold for Next Pass]
    DelProv -- Delete OK --> RelExp[Release Expired Hold to Student]
    KeepHold --> NextJob
    RelExp --> NextJob
    
    NextJob --> Loop
    Loop -- Done --> LeakDet[INV-17: Scan History for Unmatched Completed Prints]
    LeakDet --> ReleaseLock[Release Lock & Write State]
    ReleaseLock --> End([Finish Pass])
```

---

## 5. Critical Invariants Enforced

### INV-6: Delete Before Release
If an OTP expires, the system **must** successfully delete the print request from UprintBD before freeing the money. If the deletion call fails (e.g. network timeout), the hold is left locked (`failedDeletes++`) and re-attempted in the next pass. This prevents a race where a student could rush to a kiosk, enter the code, and print for free.

### INV-7: Bailout on Provider Error
If UprintBD is temporarily down or returning errors on `getPrintHistory()`, the engine stops immediately. Holds remain safely quarantined until history can be verified.

### INV-17: Unmatched Completed Prints Leak Detector
If physical paper emerged from a printer whose filename cannot be matched to any internal job in `printIndex`, it is recorded into `admin/uprint/unmatched/<key>` so administrators can inspect institutional balance leakage.

---

## 6. Audit Context Scope Bug Fix

In earlier versions of `reconcile.js`, lines calling `auditLogger.scheduleTask(deps, ...)` failed silently with `ReferenceError: deps is not defined`.

In the modern `ReconcileService` (`lib/services/reconcile-service.js`), the execution context `ctx` (containing `rtdb`, `session`, `env`, and `workerCtx`) is passed cleanly to all asynchronous audit scheduling routines.
