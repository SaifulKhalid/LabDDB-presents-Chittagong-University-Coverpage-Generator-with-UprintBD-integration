/**
 * auth-verify.js — turn a browser's Firebase ID token into a trusted identity.
 * -----------------------------------------------------------------------------
 * Every request that can move money carries `Authorization: Bearer <idToken>`
 * minted by Firebase Auth in the user's browser. We must not trust its contents
 * without checking the signature, and we cannot use `firebase-admin` (Node-only)
 * on Workers.
 *
 * Two options exist without that SDK: fetch Google's public JWKs and verify
 * RS256 locally, or ask Identity Toolkit to do it. We use the second —
 * `accounts:lookup` with the project's Web API key — because:
 *
 *   - It is scoped to one project. A token minted by any other Firebase project
 *     is rejected by Google, not by our own `aud` check.
 *   - It reflects state, not just signature: a disabled or deleted account stops
 *     working immediately, whereas a locally-verified JWT stays valid for an hour.
 *   - It returns the fresh profile (email, verified flag, display name, photo),
 *     which is exactly what we store on /users/{uid}.
 *
 * The cost is one extra network hop, so verified identities are cached briefly in
 * the isolate, keyed by the token itself.
 */

'use strict';

const { decodeJwtPayload } = require('./firebase-rest.js');

const LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

// Cache verified identities in-isolate. Short, because the whole point of the
// remote check is to notice disabled accounts quickly.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // idToken -> { identity, expiresAt }

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Pull the bearer token out of a Request, or null. */
function bearerToken(request) {
  const raw = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Verify a Firebase ID token.
 *
 * @param {string} idToken
 * @param {object} opts { apiKey, projectId }
 * @returns {Promise<{uid,email,emailVerified,displayName,photoURL,provider}>}
 */
async function verifyIdToken(idToken, { apiKey, projectId } = {}) {
  if (!idToken) throw new AuthError('Sign in to continue.');
  if (!apiKey) throw new AuthError('Auth is not configured on the server.', 500);

  const hit = cache.get(idToken);
  if (hit && hit.expiresAt > Date.now()) return hit.identity;

  // Cheap local pre-checks: reject junk and already-expired tokens without
  // spending a network round trip, and fail fast on a token from the wrong
  // Firebase project.
  const claims = decodeJwtPayload(idToken);
  if (!claims) throw new AuthError('Malformed sign-in token. Please sign in again.');
  if (claims.exp && claims.exp * 1000 <= Date.now()) {
    throw new AuthError('Your session expired. Please sign in again.');
  }
  if (projectId && claims.aud && claims.aud !== projectId) {
    throw new AuthError('Sign-in token was issued for a different app.', 403);
  }

  const res = await fetch(`${LOOKUP_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const code = data && data.error && data.error.message;
    if (code === 'INVALID_ID_TOKEN' || code === 'TOKEN_EXPIRED' || code === 'USER_NOT_FOUND') {
      throw new AuthError('Your session expired. Please sign in again.');
    }
    throw new AuthError(`Could not verify sign-in${code ? ' (' + code + ')' : ''}.`, 401);
  }

  const user = data && Array.isArray(data.users) ? data.users[0] : null;
  if (!user || !user.localId) throw new AuthError('Sign-in could not be verified.');
  if (user.disabled) throw new AuthError('This account has been disabled.', 403);

  const identity = {
    uid: user.localId,
    email: (user.email || '').toLowerCase(),
    emailVerified: !!user.emailVerified,
    displayName: user.displayName || '',
    photoURL: user.photoUrl || '',
    provider:
      (user.providerUserInfo && user.providerUserInfo[0] && user.providerUserInfo[0].providerId) ||
      'unknown',
  };

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(idToken, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
  return identity;
}

/** Verify straight off a Request. Throws AuthError when there is no token. */
async function requireUser(request, opts) {
  return verifyIdToken(bearerToken(request), opts);
}

/**
 * The project admin is a single hard-coded email (htmlwithkhalid@gmail.com by
 * default, overridable per-environment). It is checked against the *verified*
 * identity, never against anything the client sends, and the console URL being
 * unlisted is convenience — this is the actual control.
 *
 * `emailVerified` is required, not decorative. The whole gate is an email
 * comparison, so an account holding that address without having proven it owns
 * it would be the admin. Google sign-in — the only enabled provider — always
 * returns a verified address, so this costs a legitimate admin nothing and
 * removes the one way the comparison could be fooled.
 */
function isProjectAdmin(identity, adminEmail) {
  const allowed = String(adminEmail || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return false;
  if (!identity || !identity.email || !identity.emailVerified) return false;
  return allowed.includes(identity.email);
}

/** Verify, then insist the caller is the project admin. */
async function requireProjectAdmin(request, opts) {
  const identity = await requireUser(request, opts);
  if (!isProjectAdmin(identity, opts && opts.adminEmail)) {
    throw new AuthError('This area is restricted.', 403);
  }
  return identity;
}

module.exports = {
  AuthError,
  bearerToken,
  verifyIdToken,
  requireUser,
  requireProjectAdmin,
  isProjectAdmin,
};
