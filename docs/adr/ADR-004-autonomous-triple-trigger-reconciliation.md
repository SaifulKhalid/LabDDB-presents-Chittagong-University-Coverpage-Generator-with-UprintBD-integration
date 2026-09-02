# ADR-004: Autonomous Triple-Trigger Reconciliation Architecture

## Status
**Accepted** (Implemented in `lib/services/reconcile-service.js`)

## Context
Because students may mint a code, walk away, or turn off their device, settling physical prints and expiring stale holds cannot depend on the client browser making another HTTP call.
The server must proactively reconcile completed physical prints with held balances.

## Decision
1. **Multi-Trigger Redundancy**:
   - **Trigger A (Production Cron)**: Cloudflare Worker Cron Trigger fires every minute (`* * * * *`).
   - **Trigger B (Local Daemon)**: Node.js `setInterval` fires every 60 seconds in `server.js`.
   - **Trigger C (Lazy Fallback)**: Incoming `POST /api/print` calls trigger an asynchronous lazy check if `lastReconcileAt` is older than 3 minutes.
   - **Trigger D (Manual Override)**: Administrator forced trigger via `POST /api/admin/reconcile`.
2. **Distributed CAS Locking**:
   - Competing triggers attempt to claim an atomic lock at `/admin/uprint/lock` with a 90-second TTL.
   - If held, subsequent triggers skip execution gracefully (`skipped: true`).
3. **Invariants Priority**:
   - **Settle Before Expire**: Completed prints in history are settled first, preventing accidental release of printed jobs.
   - **Delete Before Release (INV-6)**: UprintBD queued records are deleted *before* held funds are returned to the student.
   - **Bailout on Error (INV-7)**: If UprintBD history cannot be retrieved, all holds remain untouched.

## Consequences
- **Positive**: Complete autonomy; students are charged or refunded accurately without user intervention.
- **Positive**: Zero risk of split-brain double-execution due to distributed locking.
- **Negative**: Adds periodic background traffic to UprintBD's dashboard; mitigated by lock TTL and history caching.
