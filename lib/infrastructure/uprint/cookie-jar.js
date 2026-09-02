/**
 * lib/infrastructure/uprint/cookie-jar.js — Lightweight cookie jar.
 * -----------------------------------------------------------------------------
 * Extracts and serializes cookies from Fetch Response headers across Node.js
 * and Cloudflare Workers environments.
 */

'use strict';

class CookieJar {
  constructor() {
    this.cookies = Object.create(null);
  }

  /**
   * Absorb Set-Cookie headers from a fetch Response.
   */
  absorb(res) {
    if (!res || !res.headers) return;
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') {
      list = res.headers.getSetCookie();
    } else {
      const single = res.headers.get('set-cookie');
      if (single) list = [single];
    }

    for (const line of list) {
      const first = line.split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.cookies[name] = value;
    }
  }

  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  get(name) {
    return this.cookies[name];
  }

  set(name, value) {
    this.cookies[name] = value;
  }

  clear() {
    this.cookies = Object.create(null);
  }
}

module.exports = {
  CookieJar,
};
