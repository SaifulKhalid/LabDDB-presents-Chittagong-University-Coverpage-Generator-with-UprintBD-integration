/**
 * firebase-rest.js — dependency-free Firebase admin access for Workers and Node.
 * -----------------------------------------------------------------------------
 * The bridge has to write money (wallet balances, ledger entries) with privileges
 * no browser may have. `firebase-admin` is a Node-only package that will not run
 * on Cloudflare Workers, so this module does the three things we actually need,
 * using only WebCrypto + fetch (both present in Workers and Node >= 20):
 *
 *   1. Sign a service-account JWT (RS256) and exchange it for an OAuth2 access
 *      token, cached in the isolate until shortly before it expires.
 *   2. Talk to the Realtime Database REST API — including **compare-and-swap**
 *      via `X-Firebase-ETag` / `if-match`, which is what makes concurrent wallet
 *      updates safe without a transaction server.
 *   3. Mint Firebase **custom tokens**, used to hand the coverpage admin scoped
 *      write access to the separate `lddb-demo` project off a single Google
 *      sign-in on LabDDB-Pro.
 *
 * Nothing here is specific to our schema — see lib/ledger.js for that.
 */

'use strict';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');
const IDENTITY_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

// Refresh the access token this many ms before it actually expires.
const TOKEN_SKEW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// base64url helpers (btoa/atob exist in both Workers and Node >= 18)
// ---------------------------------------------------------------------------
function b64urlFromBytes(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function bytesFromB64(b64) {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a JWT payload without verifying it. For cheap pre-checks only. */
function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytesFromB64(parts[1])));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service account: JWT signing, OAuth2 token, custom tokens
// ---------------------------------------------------------------------------
class ServiceAccount {
  /** @param {string|object} json the service-account key JSON (string or parsed) */
  constructor(json) {
    let sa = json;
    if (typeof sa === 'string') {
      try {
        sa = JSON.parse(sa);
      } catch (e) {
        throw new Error('Service account is not valid JSON.');
      }
    }
    if (!sa || !sa.client_email || !sa.private_key) {
      throw new Error('Service account JSON must contain client_email and private_key.');
    }
    this.clientEmail = sa.client_email;
    this.projectId = sa.project_id || null;
    this.privateKeyPem = sa.private_key;
    this._key = null;
    this._token = null; // { value, expiresAt }
  }

  async cryptoKey() {
    if (this._key) return this._key;
    // Secrets pasted through a shell or a dashboard often arrive with literal \n.
    const pem = this.privateKeyPem.replace(/\\n/g, '\n');
    const body = pem
      .replace(/-----BEGIN [^-]+-----/, '')
      .replace(/-----END [^-]+-----/, '')
      .replace(/\s+/g, '');
    if (!body) throw new Error('Service account private_key is empty or malformed.');
    this._key = await crypto.subtle.importKey(
      'pkcs8',
      bytesFromB64(body),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return this._key;
  }

  /** Sign an arbitrary claim set as a compact RS256 JWT. */
  async signJwt(claims) {
    const signingInput =
      b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
      '.' +
      b64urlFromString(JSON.stringify(claims));
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      await this.cryptoKey(),
      new TextEncoder().encode(signingInput)
    );
    return signingInput + '.' + b64urlFromBytes(new Uint8Array(sig));
  }

  /** OAuth2 access token for the RTDB REST API, cached in-isolate. */
  async accessToken() {
    if (this._token && this._token.expiresAt - TOKEN_SKEW_MS > Date.now()) {
      return this._token.value;
    }
    const now = Math.floor(Date.now() / 1000);
    const assertion = await this.signJwt({
      iss: this.clientEmail,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
      const detail = data && (data.error_description || data.error);
      throw new Error(
        `Could not obtain Google access token (HTTP ${res.status})${detail ? ': ' + detail : ''}.`
      );
    }
    this._token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return this._token.value;
  }

  /**
   * Mint a Firebase custom token. Used to grant the coverpage admin a scoped
   * `coverAdmin` claim on the lddb-demo project without a second Google login.
   */
  async createCustomToken(uid, claims = {}, ttlSeconds = 3600) {
    if (!uid) throw new Error('createCustomToken requires a uid.');
    const now = Math.floor(Date.now() / 1000);
    return this.signJwt({
      iss: this.clientEmail,
      sub: this.clientEmail,
      aud: IDENTITY_AUD,
      uid: String(uid),
      claims,
      iat: now,
      exp: now + Math.min(3600, Math.max(60, ttlSeconds)),
    });
  }
}

// ---------------------------------------------------------------------------
// Realtime Database REST client
// ---------------------------------------------------------------------------
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

class Rtdb {
  /**
   * @param {object} opts
   * @param {string} opts.databaseURL e.g. https://labddb-pro-default-rtdb.firebaseio.com
   * @param {ServiceAccount} opts.serviceAccount
   */
  constructor({ databaseURL, serviceAccount }) {
    if (!databaseURL) throw new Error('Rtdb requires a databaseURL.');
    if (!serviceAccount) throw new Error('Rtdb requires a serviceAccount.');
    this.databaseURL = String(databaseURL).replace(/\/$/, '');
    this.sa = serviceAccount;
  }

  url(path, query) {
    const clean = String(path).replace(/^\/+|\/+$/g, '');
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return `${this.databaseURL}/${clean}.json${qs}`;
  }

  async request(method, path, { body, query, etag, wantEtag } = {}) {
    const headers = { Authorization: `Bearer ${await this.sa.accessToken()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (wantEtag) headers['X-Firebase-ETag'] = 'true';
    if (etag) headers['if-match'] = etag;

    const res = await fetch(this.url(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 412) {
      throw new ConflictError(`ETag mismatch writing ${path}.`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `RTDB ${method} ${path} failed (HTTP ${res.status})${text ? ': ' + text.slice(0, 200) : ''}`
      );
    }

    const text = await res.text();
    let value = null;
    if (text && text !== 'null') {
      try {
        value = JSON.parse(text);
      } catch (_) {
        value = null;
      }
    }
    return { value, etag: res.headers.get('ETag') };
  }

  async get(path, query) {
    return (await this.request('GET', path, { query })).value;
  }

  async getWithEtag(path) {
    return this.request('GET', path, { wantEtag: true });
  }

  async put(path, value, opts = {}) {
    return (await this.request('PUT', path, { body: value, ...opts })).value;
  }

  async patch(path, value) {
    return (await this.request('PATCH', path, { body: value })).value;
  }

  /** POST — server-generated push key. Returns the new key. */
  async push(path, value) {
    const out = (await this.request('POST', path, { body: value })).value;
    return out && out.name ? out.name : null;
  }

  async remove(path) {
    await this.request('DELETE', path, {});
    return true;
  }

  /**
   * Compare-and-swap a node. `mutator(current)` returns the new value, or
   * `undefined` to abort without writing. Retries on ETag conflict, which is
   * how two simultaneous holds on the same wallet stay correct.
   *
   * @returns {Promise<{committed: boolean, value: any}>}
   */
  async transaction(path, mutator, { retries = 6 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { value: current, etag } = await this.getWithEtag(path);
      const next = await mutator(current);
      if (next === undefined) return { committed: false, value: current };
      try {
        await this.put(path, next, { etag: etag || undefined });
        return { committed: true, value: next };
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        lastErr = err;
        // Exponential-ish backoff with a small deterministic jitter by attempt.
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + attempt * 7));
      }
    }
    throw lastErr || new Error(`Could not commit ${path} after ${retries} retries.`);
  }

  /** Server-side timestamp sentinel. */
  static get TIMESTAMP() {
    return { '.sv': 'timestamp' };
  }
}

module.exports = {
  ServiceAccount,
  Rtdb,
  ConflictError,
  decodeJwtPayload,
  b64urlFromBytes,
  b64urlFromString,
  bytesFromB64,
};
