# ADR-001: Double-Entry Two-Phase Compare-And-Swap (CAS) Wallet Architecture

## Status
**Accepted** (Implemented in `lib/domain/wallet.js` and `lib/services/wallet-service.js`)

## Context
In student printing platforms, a common failure mode is charging students when a kiosk code is generated, forcing manual customer support refunds when the student fails to print or walks away.
Furthermore, serverless platforms (like Cloudflare Workers) communicate with Firebase Realtime Database over HTTP REST, lacking multi-document cross-database transactions. A naive two-step mutation (e.g. updating balance first, then writing a ledger row) introduces crash windows where process termination results in either stolen money or unrecorded prints.

## Decision
1. **Two-Phase Reservation Pattern**:
   - `Hold`: Reserving money locks it into `reserved` without touching `balance`. `available = balance - reserved` decreases.
   - `Settle`: Confirmed physical print debits `balance` and `reserved` together, appending a ledger charge row.
   - `Release`: Expired or cancelled reservation clears `reserved` with zero balance mutation and no ledger entry.
2. **Colocated Idempotency Key**:
   - Every mutation incorporates an `opId` into `wallet.applied` in the *exact same atomic Compare-And-Swap write* as the balance and reservation.
   - Concurrency conflicts are detected via HTTP `ETag` (`If-Match`), retrying up to 6 times with exponential backoff.
   - Replays due to network dropouts are recognized as no-ops, ensuring strict exactly-once execution.

## Consequences
- **Positive**: Zero risk of double-charging; students never pay for unprinted documents.
- **Positive**: Complete fault tolerance against network timeouts and runtime crashes.
- **Negative**: High concurrency on a single student's wallet causes CAS retries (mitigated by jittered backoff and the reality of single-user document submission).
