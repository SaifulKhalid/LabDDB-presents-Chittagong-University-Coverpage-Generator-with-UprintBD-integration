/**
 * uprint-bridge.js
 * -----------------------------------------------------------------------------
 * Headless automation of UprintBD's EXISTING web interface — no API required.
 *
 * UprintBD told us they will not build or expose any API. This module instead
 * drives the exact same HTTP requests a real browser makes when a logged-in
 * user uploads a document and accepts the print options. The end result is a
 * genuine 6-digit OTP, minted by UprintBD's own system, that works at any
 * Uprint kiosk.
 *
 * The flow below was reverse-engineered and verified end-to-end against the
 * live site (uprintbd.com), running on Django + DRF:
 *
 *   1. GET  /login/                          -> csrftoken cookie + form token
 *   2. POST /login/                          -> 302 /home/, sets sessionid
 *   3. GET  /uprint/dashboard/               -> fresh csrfmiddlewaretoken
 *   4. POST /uprint/uploader/  (multipart)   -> 302 /uprint/set_options/<id>/
 *   5. POST /uprint/accept_print_info/<id>/  -> {"status":"OK"} (mints OTP)
 *   6. GET  /uprint/dashboard/               -> scrape OTP for <id>
 *
 * Zero external dependencies: uses Node 18+ global fetch / FormData / Blob and
 * a tiny hand-rolled cookie jar. Requires Node >= 20 for Headers.getSetCookie().
 */

'use strict';

const BASE = process.env.UPRINT_BASE_URL || 'https://uprintbd.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// What we declare to UprintBD as `total_cost`. This mirrors the site's OWN
// calculateCost() (3 Tk/page mono, 5 colour) so our payload looks exactly like
// the browser's. It is an estimate, not the charge: print_history shows the
// outlet actually bills 2.0 Tk for a 1-page mono job. Our users' prices live in
// RTDB /config/pricing and are unrelated to these two constants.
const UNIT_PRICE_MONO = 3;
const UNIT_PRICE_COLOR = 5;

// Fallback OTP lifetime when the dashboard countdown cannot be read.
const DEFAULT_OTP_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Tiny cookie jar
// ---------------------------------------------------------------------------
class CookieJar {
  constructor() {
    this.cookies = Object.create(null);
  }
  /** Absorb Set-Cookie headers from a fetch Response. */
  absorb(res) {
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
}

// ---------------------------------------------------------------------------
// HTTP helper — injects the jar, captures Set-Cookie, never auto-follows so we
// can read 302 Location headers (that is how we learn the record id).
// ---------------------------------------------------------------------------
async function http(jar, url, opts = {}) {
  const headers = Object.assign(
    {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    opts.headers || {}
  );
  const cookie = jar.header();
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: 'manual',
  });
  jar.absorb(res);
  return res;
}

function extractCsrfInput(html) {
  const m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  return m ? m[1] : null;
}

/** Best-effort page count from a PDF buffer; cover pages are 1 page. */
function countPdfPages(buf) {
  try {
    let s = '';
    if (typeof buf === 'string') {
      s = buf;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) {
      s = buf.toString('latin1');
    } else if (buf instanceof Uint8Array || buf instanceof ArrayBuffer) {
      s = new TextDecoder('latin1').decode(buf);
    }
    const count = s.match(/\/Count\s+(\d+)/);
    if (count) {
      const n = parseInt(count[1], 10);
      if (n > 0 && n < 10000) return n;
    }
    const pages = s.match(/\/Type\s*\/Page(?![s])/g);
    if (pages && pages.length > 0) return pages.length;
  } catch (_) {
    /* ignore */
  }
  return 1;
}

// ---------------------------------------------------------------------------
// HTML scraping helpers
//
// These back the reconciler, which is the component that decides whether a user
// is charged. Everything here is read-only against pages the site renders for
// any logged-in user.
// ---------------------------------------------------------------------------

/** Cell text: drop tags, decode the handful of entities Django emits, trim. */
function cellText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The institutional account's remaining credit. UprintBD renders
 * `<p class="...">Balance: 8 Tk</p>` into the sidebar of every authenticated
 * page, so this needs no upload and costs nothing.
 */
function parseBalance(html) {
  const m = String(html).match(/Balance:\s*([\d,]+(?:\.\d+)?)\s*Tk/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse /uprint/print_history/. Columns are read from the <th> labels rather
 * than assumed positionally, so a future column insert degrades instead of
 * silently mis-attributing money.
 *
 * @returns {Array<{dateTime,filename,cost,copies,pages,status,deviceId}>}
 */
function parsePrintHistory(html) {
  const anchor = html.indexOf('userPrintHistoryDataTable');
  const region = anchor === -1 ? html : html.slice(anchor);

  const headEnd = region.indexOf('</thead>');
  const headers =
    headEnd === -1
      ? []
      : [...region.slice(0, headEnd).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
          cellText(m[1]).toLowerCase()
        );

  const find = (needle, fallback) => {
    const i = headers.findIndex((h) => h.includes(needle));
    return i === -1 ? fallback : i;
  };
  const COL = {
    dateTime: find('date', 0),
    filename: find('file', 1),
    cost: find('cost', 2),
    copies: find('copies', 3),
    pages: find('page', 4),
    status: find('status', 5),
    device: find('device', 6),
  };

  const bodyStart = region.indexOf('<tbody');
  const bodyEnd = region.indexOf('</tbody>');
  const body =
    bodyStart !== -1 && bodyEnd > bodyStart ? region.slice(bodyStart, bodyEnd) : region;

  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 6) continue; // header row or spacer
    const filename = cells[COL.filename] || '';
    if (!filename) continue;
    rows.push({
      dateTime: cells[COL.dateTime] || '',
      filename,
      cost: Number(cells[COL.cost]) || 0,
      copies: parseInt(cells[COL.copies], 10) || 1,
      pages: parseInt(cells[COL.pages], 10) || 1,
      status: cells[COL.status] || '',
      deviceId: cells[COL.device] || '',
    });
  }
  return rows;
}

/** `YYYY-MM-DD` in Asia/Dhaka (UTC+6) — the timezone UprintBD stamps rows in. */
function dhakaDate(ms) {
  return new Date((ms == null ? Date.now() : ms) + 6 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Session: performs login and keeps the authenticated cookie jar.
// ---------------------------------------------------------------------------
class UprintSession {
  constructor(creds) {
    this.email = creds.email;
    this.password = creds.password;
    this.baseUrl = creds.baseUrl || (typeof process !== 'undefined' && process.env && process.env.UPRINT_BASE_URL) || BASE;
    this.jar = new CookieJar();
    this.loggedInAt = 0;
  }

  get csrf() {
    return this.jar.get('csrftoken');
  }

  isFresh(maxAgeMs = 8 * 60 * 1000) {
    return this.jar.get('sessionid') && Date.now() - this.loggedInAt < maxAgeMs;
  }

  async login() {
    const base = this.baseUrl;
    // 1. GET the login page for the CSRF cookie + hidden form token.
    const getRes = await http(this.jar, `${base}/login/`);
    const loginHtml = await getRes.text();
    const formToken = extractCsrfInput(loginHtml) || this.csrf;
    if (!formToken) throw new Error('Could not read CSRF token from login page.');

    // 2. POST credentials. Success is a 302 to /home/ that sets sessionid.
    const body = new URLSearchParams({
      csrfmiddlewaretoken: formToken,
      email: this.email,
      password: this.password,
    }).toString();

    const postRes = await http(this.jar, `${base}/login/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: base,
        Referer: `${base}/login/`,
      },
      body,
    });

    if (!this.jar.get('sessionid')) {
      throw new Error(
        `Login failed (HTTP ${postRes.status}). Check UPRINT_EMAIL / UPRINT_PASSWORD.`
      );
    }
    this.loggedInAt = Date.now();
    return this;
  }

  async ensureLogin() {
    if (!this.isFresh()) await this.login();
    return this;
  }

  /**
   * Upload a PDF, accept default cover-page print options, and return the OTP.
   * @param {Buffer|Uint8Array|ArrayBuffer} pdfBuffer
   * @param {object} opts { filename, copies, color }
   */
  async printAndGetOtp(pdfBuffer, opts = {}) {
    const base = this.baseUrl;
    const filename = sanitizeFilename(opts.filename || 'coverpage.pdf');
    const copies = clampInt(opts.copies, 1, 1, 99);
    const color = !!opts.color;

    await this.ensureLogin();

    // 3. Load the dashboard for a current CSRF token (matches browser behaviour).
    const dashRes = await http(this.jar, `${base}/uprint/dashboard/`);
    const dashHtml = await dashRes.text();
    const uploadToken = extractCsrfInput(dashHtml) || this.csrf;

    // 4. Upload the PDF exactly like the dashboard's #uploadForm.
    const form = new FormData();
    form.append('csrfmiddlewaretoken', uploadToken);
    form.append(
      'file',
      new Blob([pdfBuffer], { type: 'application/pdf' }),
      filename
    );

    const upRes = await http(this.jar, `${base}/uprint/uploader/`, {
      method: 'POST',
      headers: {
        Origin: base,
        Referer: `${base}/uprint/dashboard/`,
      },
      body: form,
    });

    const location = upRes.headers.get('location') || '';
    const recordMatch = location.match(/set_options\/(\d+)/);
    if (!recordMatch) {
      throw new Error(
        `Upload did not return a record id (HTTP ${upRes.status}, location "${location}").`
      );
    }
    const recordId = recordMatch[1];

    // 5. Accept print options -> this is the call that mints the OTP.
    const pages = countPdfPages(pdfBuffer);
    const unitPrice = color ? UNIT_PRICE_COLOR : UNIT_PRICE_MONO;
    const totalCost = pages * copies * unitPrice;

    const payload = {
      total_copies: copies,
      total_cost: totalCost,
      pages: 'all',
      no_of_page: pages,
      duplex_option: 'one-sided',
      print_progress_status: 'In Queue',
      colorMode: color ? 'COLOR' : 'MONO',
      layout: 'portrait',
      paperSize: 'A4',
      scale: 'false', // "actual-size"
      pagesPerSheet: 1,
      watermarkOption: 'no_watermark',
    };

    const acceptRes = await http(
      this.jar,
      `${base}/uprint/accept_print_info/${recordId}/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-CSRFToken': this.csrf,
          'X-Requested-With': 'XMLHttpRequest',
          Origin: base,
          Referer: `${base}/uprint/set_options/${recordId}/`,
        },
        body: JSON.stringify(payload),
      }
    );

    if (acceptRes.status !== 200) {
      const detail = await safeExceptionValue(acceptRes);
      throw new Error(
        `accept_print_info failed (HTTP ${acceptRes.status})${detail ? ': ' + detail : ''}.`
      );
    }

    // 6. Read the OTP from the dashboard (retry once — it appears immediately,
    //    but a re-render race is cheap to guard against).
    let job = await this.scrapeDashboardJob(recordId);
    if (!job.otp) {
      await sleep(900);
      job = await this.scrapeDashboardJob(recordId);
    }
    if (!job.otp) {
      throw new Error(
        `Job ${recordId} was queued but no OTP appeared on the dashboard.`
      );
    }

    return {
      ok: true,
      otp: job.otp,
      recordId,
      filename,
      pages,
      copies,
      color,
      cost: totalCost,
      currency: 'BDT',
      validForSeconds: job.validForSeconds,
    };
  }

  /**
   * Read one queued job off the dashboard: its OTP and how long UprintBD says
   * the code is still good for.
   *
   * The OTP cell sits immediately before the per-row countdown cell
   * <td id="seconds<recordId>">, so we anchor on that to avoid grabbing a
   * different job's code. The countdown is read rather than assumed, because
   * the hold we place expires with the OTP — guessing 3600 s when the site says
   * otherwise would either free money early or lock it up late.
   *
   * @returns {Promise<{otp: string|null, validForSeconds: number}>}
   */
  async scrapeDashboardJob(recordId) {
    const base = this.baseUrl;
    const res = await http(this.jar, `${base}/uprint/dashboard/`);
    const html = await res.text();

    let otp = null;
    const anchored = new RegExp(
      `text-danger fw-bold fs-5">\\s*(\\d{4,8})\\s*</td>\\s*<td id="seconds${recordId}"`
    );
    const m = html.match(anchored);
    if (m) {
      otp = m[1];
    } else {
      // Fallback: locate the row containing id="seconds<recordId>" and pull the
      // nearest 4-8 digit OTP-styled cell before it.
      const idx = html.indexOf(`id="seconds${recordId}"`);
      if (idx !== -1) {
        const before = html.slice(Math.max(0, idx - 400), idx);
        const codes = [...before.matchAll(/fs-5">\s*(\d{4,8})\s*</g)];
        if (codes.length) otp = codes[codes.length - 1][1];
      }
    }

    return { otp, validForSeconds: parseCountdownCell(html, recordId) };
  }

  /** Back-compat wrapper: just the OTP string, or null. */
  async scrapeOtp(recordId) {
    return (await this.scrapeDashboardJob(recordId)).otp;
  }

  /**
   * Record ids still sitting in the dashboard queue. A job that has vanished
   * from here either printed or was deleted — either way it is no longer
   * claimable at a kiosk, which is what the reconciler needs to know before it
   * releases a hold.
   *
   * @returns {Promise<Set<string>>}
   */
  async getQueuedRecordIds() {
    const base = this.baseUrl;
    await this.ensureLogin();
    const res = await http(this.jar, `${base}/uprint/dashboard/`);
    const html = await res.text();
    const ids = new Set();
    for (const m of html.matchAll(/id="seconds(\d+)"/g)) ids.add(m[1]);
    return ids;
  }

  /**
   * The institutional account's remaining credit, scraped from any
   * authenticated page. Read-only and free — no upload required.
   *
   * @returns {Promise<number|null>} taka, or null if the markup changed
   */
  async getAccountBalance() {
    const base = this.baseUrl;
    await this.ensureLogin();
    const res = await http(this.jar, `${base}/uprint/dashboard/`);
    return parseBalance(await res.text());
  }

  /**
   * Ground truth for "did this actually print". The page filters by date with a
   * plain GET (`?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`, Asia/Dhaka dates),
   * so the reconciler can ask only as far back as its oldest open job.
   *
   * @param {object} [opts] { startDate, endDate } as YYYY-MM-DD, or { sinceMs }
   * @returns {Promise<Array<object>>}
   */
  async getPrintHistory(opts = {}) {
    const base = this.baseUrl;
    await this.ensureLogin();

    const query = new URLSearchParams();
    const start = opts.startDate || (opts.sinceMs ? dhakaDate(opts.sinceMs) : null);
    if (start) {
      query.set('start_date', start);
      query.set('end_date', opts.endDate || dhakaDate());
    }
    const url = `${base}/uprint/print_history/${query.toString() ? '?' + query : ''}`;

    const res = await http(this.jar, url, { headers: { Referer: `${base}/uprint/dashboard/` } });
    if (res.status !== 200) {
      throw new Error(`print_history failed (HTTP ${res.status}).`);
    }
    const html = await res.text();
    return parsePrintHistory(html);
  }

  /** Remove a queued job (used for demo cleanup / cancellation). */
  async deletePrintRequest(recordId) {
    const base = this.baseUrl;
    await this.ensureLogin();
    const res = await http(
      this.jar,
      `${base}/uprint/delete_print_request/${recordId}/?file_id=${recordId}`,
      { headers: { Referer: `${base}/uprint/dashboard/` } }
    );
    return res.status === 200 || res.status === 302;
  }

  /** Read wallet/profile via the JWT API (handy for showing balance). */
  async getProfile() {
    const base = this.baseUrl;
    const res = await fetch(`${base}/api/user/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!res.ok) throw new Error(`Profile login failed (HTTP ${res.status}).`);
    const data = await res.json();
    const access = data?.success?.token?.access;
    if (!access) throw new Error('No access token returned.');
    const pr = await fetch(`${base}/api/user/profile/`, {
      headers: { Authorization: `Bearer ${access}`, 'User-Agent': UA },
    });
    if (!pr.ok) throw new Error(`Profile fetch failed (HTTP ${pr.status}).`);
    return pr.json();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/**
 * How many seconds UprintBD says a queued job's OTP is still valid for.
 *
 * The dashboard renders a per-row `<td id="seconds<id>">` countdown. Whether the
 * initial value is server-rendered or filled in by the page's own JS varies, so
 * accept a plain integer if one is there and fall back to the observed 1-hour
 * lifetime otherwise. Values are clamped: a hold must never outlive a code by so
 * much that funds stay locked, nor expire while the code still works.
 */
function parseCountdownCell(html, recordId) {
  const idx = html.indexOf(`id="seconds${recordId}"`);
  if (idx !== -1) {
    const close = html.indexOf('</td>', idx);
    if (close !== -1) {
      const raw = cellText(html.slice(html.indexOf('>', idx) + 1, close));
      // Either a bare count of seconds, or a "MM:SS" / "HH:MM:SS" clock.
      if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (n > 0 && n <= 24 * 3600) return n;
      }
      const clock = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
      if (clock) {
        const n =
          (parseInt(clock[1] || '0', 10) * 3600) +
          parseInt(clock[2], 10) * 60 +
          parseInt(clock[3], 10);
        if (n > 0 && n <= 24 * 3600) return n;
      }
    }
  }
  return DEFAULT_OTP_SECONDS;
}

function sanitizeFilename(name) {
  const base = String(name).split(/[\\/]/).pop() || 'coverpage.pdf';
  let clean = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!/\.pdf$/i.test(clean)) clean += '.pdf';
  return clean;
}
function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function safeExceptionValue(res) {
  try {
    const html = await res.text();
    const m = html.match(/<pre class="exception_value">([^<]+)<\/pre>/);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  UprintSession,
  CookieJar,
  countPdfPages,
  sanitizeFilename,
  parsePrintHistory,
  parseBalance,
  parseCountdownCell,
  dhakaDate,
  BASE,
  DEFAULT_OTP_SECONDS,
};

