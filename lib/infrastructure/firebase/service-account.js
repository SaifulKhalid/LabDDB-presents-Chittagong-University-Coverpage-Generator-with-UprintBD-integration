/**
 * lib/infrastructure/firebase/service-account.js — RS256 JWT signing & OAuth2 token exchange.
 * -----------------------------------------------------------------------------
 * Operates with zero npm dependencies across Node >= 20 and Cloudflare Workers
 * using WebCrypto (crypto.subtle).
 */

'use strict';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');
const IDENTITY_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

const TOKEN_SKEW_MS = 60 * 1000;

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

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytesFromB64(parts[1])));
  } catch (_) {
    return null;
  }
}

class ServiceAccount {
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
    this._token = null;
  }

  async cryptoKey() {
    if (this._key) return this._key;
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

module.exports = {
  ServiceAccount,
  decodeJwtPayload,
  b64urlFromBytes,
  b64urlFromString,
  bytesFromB64,
};
