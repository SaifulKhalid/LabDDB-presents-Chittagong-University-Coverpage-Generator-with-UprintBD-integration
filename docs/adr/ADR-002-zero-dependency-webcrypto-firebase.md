# ADR-002: Zero-Dependency WebCrypto & Native REST for Firebase

## Status
**Accepted** (Implemented in `lib/infrastructure/firebase/`)

## Context
Standard Firebase integrations in Node.js rely on the `firebase-admin` package. This package:
- Exceeds 50MB of transitive dependencies.
- Relies heavily on Node.js-specific native bindings (gRPC, OpenSSL bindings) that fail or bloat Cloudflare Workers bundle sizes.
- Slows down worker startup time and causes cold-start latency.

## Decision
1. **Zero External NPM Dependencies**:
   - Implement Firebase authentication and database operations entirely using standards-compliant Web APIs: `fetch()`, `crypto.subtle`, `Headers`, and `FormData`.
2. **WebCrypto RS256 JWT Signing**:
   - Import PKCS#8 private keys using `crypto.subtle.importKey('pkcs8', ...)`.
   - Sign OAuth2 assertions using native `crypto.subtle.sign('RSASSA-PKCS1-v1_5', ...)`.
   - Exchange assertions for Google OAuth access tokens cached in-isolate with a 5-minute safety margin.
3. **Native RTDB REST Client**:
   - Issue standard HTTPS GET, PUT, PATCH, and DELETE requests directly to Firebase RTDB REST endpoints with ETag precondition headers.

## Consequences
- **Positive**: Zero npm packages to audit, update, or package; zero supply-chain vulnerability risk.
- **Positive**: Worker deployment bundle size is miniscule (<150KB), resulting in instantaneous sub-millisecond cold starts.
- **Positive**: Complete portability between Node.js >= 20 and Cloudflare Workers without code modification.
