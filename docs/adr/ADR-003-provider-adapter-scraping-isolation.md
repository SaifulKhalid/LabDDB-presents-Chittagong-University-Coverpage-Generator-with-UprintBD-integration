# ADR-003: Provider Adapter Pattern & Web Scraping Isolation

## Status
**Accepted** (Implemented in `lib/domain/print-provider.js` and `lib/infrastructure/uprint/`)

## Context
UprintBD provides no documented public API. Integrating directly inside API handlers created tight coupling: web scraping logic, HTML regexes, Django CSRF token inputs, and session cookies leaked across the codebase. Any UI change by UprintBD risked breaking the entire server.

## Decision
1. **Formal Provider Interface**:
   - Define a domain interface `PrintProvider` with clear contracts:
     - `uploadAndQueue(pdfBytes, opts)` -> `{ otp, recordId, cost, validForSeconds }`
     - `getPrintHistory(opts)` -> `Array<{ dateTime, filename, status, cost, deviceId }>`
     - `getQueuedRecordIds()` -> `Set<string>`
     - `deletePrintRequest(recordId)` -> `boolean`
     - `getAccountBalance()` -> `number`
2. **Encapsulated Infrastructure Adapter**:
   - Confine all UprintBD-specific HTTP requests, form parameters (`scale: "false"`, `pagesPerSheet: 1`), and HTML parsing to `lib/infrastructure/uprint/`.
3. **Serialized Upload Execution (INV-13)**:
   - Use `SessionQueue` to serialize upload mutations, ensuring multiple concurrent requests do not corrupt state within the single institutional cookie jar.

## Consequences
- **Positive**: Complete decoupling; if UprintBD updates its markup, only `lib/infrastructure/uprint/` requires modification.
- **Positive**: The domain and application layers can be unit-tested using mock providers without network traffic.
- **Positive**: Alternative printing providers (e.g. CU campus print server) can be plugged in by creating a new adapter implementing `PrintProvider`.
