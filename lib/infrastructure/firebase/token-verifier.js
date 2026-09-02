/**
 * lib/infrastructure/firebase/token-verifier.js — ID token verification via Identity Toolkit.
 * -----------------------------------------------------------------------------
 * Turn an incoming Firebase ID token into a trusted identity with in-memory caching.
 */

'use strict';

const { AuthError } = require('../../domain/errors.js');
const { decodeJwtPayload } = require('./service-account.js');

const LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // idToken -> { identity, expiresAt }

function bearerToken(request) {
  if (!request || !request.headers) return null;
  const raw =
    request.headers.get('authorization') ||
    request.headers.get('Authorization') ||
    '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function verifyIdToken(idToken, { apiKey, projectId } = {}) {
  if (!idToken) throw new AuthError('Sign in to continue.');
  if (!apiKey) throw new AuthError('Auth is not configured on the server.', 500);

  const hit = cache.get(idToken);
  if (hit && hit.expiresAt > Date.now()) return hit.identity;

  // Local pre-checks: reject junk and expired tokens fast
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

/**
 * INVARIANT INV-14: Project-admin gate = verified email match on every request.
 */
function isProjectAdmin(identity, adminEmail) {
  const allowed = String(adminEmail || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return false;
  if (!identity || !identity.email || !identity.emailVerified) return false;
  return allowed.includes(String(identity.email).trim().toLowerCase());
}

async function requireUser(request, opts) {
  return verifyIdToken(bearerToken(request), opts);
}

async function requireProjectAdmin(request, opts) {
  const identity = await requireUser(request, opts);
  if (!isProjectAdmin(identity, opts && opts.adminEmail)) {
    throw new AuthError('This area is restricted.', 403);
  }
  return identity;
}

module.exports = {
  bearerToken,
  verifyIdToken,
  isProjectAdmin,
  requireUser,
  requireProjectAdmin,
};
