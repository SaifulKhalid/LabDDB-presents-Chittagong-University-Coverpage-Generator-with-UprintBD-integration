# ADR-005: Hybrid Storage Strategy (RTDB + Cloudflare D1 + Cloudflare R2)

## Status
**Accepted** (Implemented across `lib/services/wallet-service.js` and `lib/services/audit-service.js`)

## Context
A high-throughput student portal requires:
1. Ultra-fast real-time mutations with atomic Compare-And-Swap (wallets and locks).
2. Complex multi-table querying, search, pagination, and margin analytics for admin reports.
3. Long-term binary storage of generated student cover page PDFs for dispute resolution and auditing.

Relying solely on Firebase RTDB for analytical search causes excessive JSON serialization and costly bandwidth, while storing raw PDFs in database nodes bloats memory.

## Decision
Adopt a 3-tier partitioned hybrid storage architecture:

1. **Firebase RTDB (`labddb-pro`) — Operational Authoritative State**:
   - Stores user wallets, open holds, and system configuration.
   - Optimized for single-key lookups and atomic ETag writes.
2. **Cloudflare D1 (Serverless SQLite) — Immutable Audit & Reporting**:
   - Stores append-only audit logs, user login history, print job archives, and ledger archives.
   - Provides indexed SQL queries (`SELECT`, `SUM`, `WHERE`, `GROUP BY`) for admin dashboards and analytics.
   - Writes are executed non-blocking via `workerCtx.waitUntil()`.
3. **Cloudflare R2 — Document Object Storage (`labddb-covers`)**:
   - Stores raw PDF documents under key `covers/<uid>/<jobId>_<filename>.pdf`.
   - Attaches custom metadata headers (`roll`, `courseCode`, `jobId`).
   - Free from egress fees and scalable to millions of documents.

## Consequences
- **Positive**: Clear separation of operational concerns vs. audit analysis.
- **Positive**: RTDB memory stays small, responsive, and cost-effective.
- **Positive**: Full historical reporting without risk of impacting live print latency.
- **Positive**: Graceful degradation: if D1 or R2 bindings are absent (e.g. in local development), the system continues operating normally.
