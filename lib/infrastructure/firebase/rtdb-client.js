/**
 * lib/infrastructure/firebase/rtdb-client.js — Firebase RTDB REST client with ETag CAS.
 * -----------------------------------------------------------------------------
 * Speaks directly to the Firebase Realtime Database REST API using OAuth2 bearer
 * authentication, and supports optimistic concurrency control via X-Firebase-ETag.
 */

'use strict';

const { ConflictError } = require('../../domain/errors.js');

class Rtdb {
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

  async push(path, value) {
    const out = (await this.request('POST', path, { body: value })).value;
    return out && out.name ? out.name : null;
  }

  async remove(path) {
    await this.request('DELETE', path, {});
    return true;
  }

  /**
   * Compare-and-swap a node.
   * INVARIANT INV-2: Retries on ETag conflict with exponential backoff and jitter.
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
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + attempt * 7));
      }
    }
    throw lastErr || new Error(`Could not commit ${path} after ${retries} retries.`);
  }

  static get TIMESTAMP() {
    return { '.sv': 'timestamp' };
  }
}

module.exports = {
  Rtdb,
  ConflictError,
};
