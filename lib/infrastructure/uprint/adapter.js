/**
 * lib/infrastructure/uprint/adapter.js — UprintBD web scraping provider adapter.
 * -----------------------------------------------------------------------------
 * Implements the PrintProvider interface by driving UprintBD's web interface.
 */

'use strict';

const { PrintProvider } = require('../../domain/print-provider.js');
const { ProviderError } = require('../../domain/errors.js');
const { countPdfPages } = require('../../domain/pricing.js');
const { CookieJar } = require('./cookie-jar.js');
const { SessionQueue } = require('./session-queue.js');
const {
  extractCsrfInput,
  parseBalance,
  parseCountdownCell,
  parseQueuedRecordIds,
  parsePrintHistory,
  dhakaDate,
} = require('./parsers.js');

const DEFAULT_BASE_URL = 'https://uprintbd.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const UNIT_PRICE_MONO = 3;
const UNIT_PRICE_COLOR = 5;
const REQUEST_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return String(name || 'Document.pdf')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

class UprintBDAdapter extends PrintProvider {
  constructor(config = {}) {
    super();
    this.email = config.email;
    this.password = config.password;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.jar = new CookieJar();
    this.queue = new SessionQueue();
    this.loggedInAt = 0;
  }

  get csrf() {
    return this.jar.get('csrftoken');
  }

  isFresh(maxAgeMs = 8 * 60 * 1000) {
    return !!(this.jar.get('sessionid') && Date.now() - this.loggedInAt < maxAgeMs);
  }

  async fetchWithJar(url, opts = {}) {
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      opts.headers || {}
    );

    const cookieHeader = this.jar.header();
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    let signal = opts.signal;
    if (!signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }

    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body,
        redirect: 'manual',
        signal,
      });
      this.jar.absorb(res);
      return res;
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || /timeout|abort/i.test(err.message);
      throw new ProviderError(
        `UprintBD request failed: ${isTimeout ? 'Network timeout after 15s' : err.message}`,
        502,
        { retryable: isTimeout }
      );
    }
  }

  async authenticate() {
    if (!this.email || !this.password) {
      throw new ProviderError('UprintBD credentials are not configured.', 503);
    }

    const base = this.baseUrl;
    const getRes = await this.fetchWithJar(`${base}/login/`);
    const loginHtml = await getRes.text();
    const formToken = extractCsrfInput(loginHtml) || this.csrf;
    if (!formToken) {
      throw new ProviderError('Could not extract CSRF token from UprintBD login page.', 502);
    }

    const body = new URLSearchParams({
      csrfmiddlewaretoken: formToken,
      email: this.email,
      password: this.password,
    }).toString();

    const postRes = await this.fetchWithJar(`${base}/login/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: base,
        Referer: `${base}/login/`,
      },
      body,
    });

    if (!this.jar.get('sessionid')) {
      throw new ProviderError(
        `UprintBD login failed (HTTP ${postRes.status}). Check credentials.`,
        502
      );
    }
    this.loggedInAt = Date.now();
    return true;
  }

  async ensureLogin() {
    if (!this.isFresh()) {
      await this.authenticate();
    }
    return true;
  }

  /**
   * Upload and queue print request. Serialized via session queue.
   */
  async uploadAndQueue(pdfBytes, options = {}) {
    return this.queue.enqueue(async () => {
      await this.ensureLogin();
      const base = this.baseUrl;
      const filename = sanitizeFilename(options.filename || 'coverpage.pdf');
      const copies = Math.max(1, Math.min(99, parseInt(options.copies, 10) || 1));
      const color = !!options.color;

      // 1. Get dashboard for fresh CSRF token
      const dashRes = await this.fetchWithJar(`${base}/uprint/dashboard/`);
      const dashHtml = await dashRes.text();
      const uploadToken = extractCsrfInput(dashHtml) || this.csrf;

      // 2. Upload PDF
      const form = new FormData();
      form.append('csrfmiddlewaretoken', uploadToken);
      form.append(
        'file',
        new Blob([pdfBytes], { type: 'application/pdf' }),
        filename
      );

      const upRes = await this.fetchWithJar(`${base}/uprint/uploader/`, {
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
        throw new ProviderError(
          `Upload did not return a record id (HTTP ${upRes.status}, location: "${location}").`,
          502
        );
      }
      const recordId = recordMatch[1];

      // 3. Accept options
      const pages = countPdfPages(pdfBytes);
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
        scale: 'false',
        pagesPerSheet: 1,
        watermarkOption: 'no_watermark',
      };

      const acceptRes = await this.fetchWithJar(
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
        throw new ProviderError(
          `UprintBD accept_print_info failed (HTTP ${acceptRes.status}).`,
          502
        );
      }

      // 4. Scrape OTP with quick backoff retry
      let otpResult = await this.retrieveOtp(recordId);
      if (!otpResult || !otpResult.otp) {
        await sleep(900);
        otpResult = await this.retrieveOtp(recordId);
      }

      if (!otpResult || !otpResult.otp) {
        throw new ProviderError(
          `Job ${recordId} was queued at UprintBD, but no OTP appeared on the dashboard.`,
          502
        );
      }

      return {
        ok: true,
        recordId,
        otp: otpResult.otp,
        filename,
        pages,
        copies,
        color,
        cost: totalCost,
        currency: 'BDT',
        validForSeconds: otpResult.validForSeconds || 3600,
      };
    });
  }

  async retrieveOtp(recordId) {
    const base = this.baseUrl;
    const res = await this.fetchWithJar(`${base}/uprint/dashboard/`);
    const html = await res.text();

    let otp = null;
    const anchored = new RegExp(
      `text-danger fw-bold fs-5">\\s*(\\d{4,8})\\s*</td>\\s*<td id="seconds${recordId}"`
    );
    const m = html.match(anchored);
    if (m) {
      otp = m[1];
    } else {
      // Fallback: locate the row with seconds<recordId>
      const idx = html.indexOf(`id="seconds${recordId}"`);
      if (idx !== -1) {
        const before = html.slice(Math.max(0, idx - 400), idx);
        const codes = [...before.matchAll(/fs-5">\s*(\d{4,8})\s*</g)];
        if (codes.length) otp = codes[codes.length - 1][1];
      }
    }

    return {
      otp,
      validForSeconds: parseCountdownCell(html, recordId),
    };
  }

  async getPrintHistory(filters = {}) {
    await this.ensureLogin();
    const base = this.baseUrl;
    let url = `${base}/uprint/print_history/`;

    if (filters.sinceMs || filters.startDate) {
      const start = filters.startDate || dhakaDate(filters.sinceMs);
      const end = filters.endDate || dhakaDate(Date.now());
      url += `?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;
    }

    const res = await this.fetchWithJar(url);
    const html = await res.text();
    return parsePrintHistory(html);
  }

  async getQueuedRecordIds() {
    await this.ensureLogin();
    const res = await this.fetchWithJar(`${this.baseUrl}/uprint/dashboard/`);
    const html = await res.text();
    return parseQueuedRecordIds(html);
  }

  async deletePrintRequest(recordId) {
    if (!recordId) return true;
    await this.ensureLogin();
    const base = this.baseUrl;
    const url = `${base}/uprint/delete_print_request/${recordId}/?file_id=${recordId}`;

    const res = await this.fetchWithJar(url);
    return res.status === 200 || res.status === 302;
  }

  async getAccountBalance() {
    await this.ensureLogin();
    const res = await this.fetchWithJar(`${this.baseUrl}/uprint/dashboard/`);
    const html = await res.text();
    const bal = parseBalance(html);
    return bal != null ? bal : 0;
  }
}

module.exports = {
  UprintBDAdapter,
  sanitizeFilename,
};
