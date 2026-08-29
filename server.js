/**
 * server.js — local development host. Zero dependencies.
 * -----------------------------------------------------------------------------
 * Serves public/ and runs the same API as production. It does that by adapting
 * Node's http req/res to Fetch `Request`/`Response` and handing off to
 * lib/api.js — the identical module the Cloudflare Worker uses. There is no
 * second implementation of the print flow, the wallet, or the reconciler to keep
 * in sync.
 *
 * Also runs the reconciler on a plain interval, standing in for the Worker's Cron
 * Trigger, so charge-on-print-only behaves the same way on a laptop.
 *
 * Run:  node server.js       (reads .env)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./lib/api.js');
const { BASE } = require('./lib/uprint-bridge.js');

// --- load .env (tiny parser, no dependency) --------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const RECONCILE_EVERY_MS = 60 * 1000;

if (!process.env.UPRINT_EMAIL || !process.env.UPRINT_PASSWORD) {
  console.error(
    '\n[FATAL] UPRINT_EMAIL and UPRINT_PASSWORD must be set.\n' +
      '        Copy .env.example to .env and fill in the institutional account.\n'
  );
  process.exit(1);
}

const context = api.createContext(process.env);

if (context.missing.length) {
  console.warn(
    `\n[warn] Not configured yet: ${context.missing.join(', ')}\n` +
      '       Sign-in and wallet routes will answer 503 until these are set.\n' +
      '       See docs/PRODUCTION-SETUP.md.\n'
  );
}

// --- static file serving ----------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- Node http <-> Fetch adaptation -----------------------------------------
function readBody(req, limitBytes = api.MAX_PDF_BYTES + 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toFetchRequest(req) {
  const url = `http://${req.headers.host || `localhost:${PORT}`}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v != null) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await readBody(req);
  }
  return new Request(url, init);
}

async function sendFetchResponse(res, response) {
  const buf = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  res.end(buf);
}

// --- router -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  if (pathname.startsWith('/api/')) {
    (async () => {
      try {
        const response = await api.handleApi(await toFetchRequest(req), context);
        await sendFetchResponse(res, response);
      } catch (err) {
        console.error('[server] ', err && err.stack ? err.stack : err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Internal server error.' }));
      }
    })();
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method not allowed');
});

// --- the local stand-in for the Worker's Cron Trigger ------------------------
let reconcileTimer = null;
function startReconciler() {
  if (context.missing.length) {
    console.warn('[reconciler] not started — wallet database is not configured.');
    return;
  }
  const tick = async () => {
    try {
      const summary = await api.reconcile(
        { rtdb: context.rtdb, session: context.session, env: context.env },
        { reason: 'interval' }
      );
      if (summary.settled || summary.released || summary.unmatched || summary.errors.length) {
        console.log(
          `[reconciler] open=${summary.openJobs} settled=${summary.settled} ` +
            `released=${summary.released} unmatched=${summary.unmatched}` +
            (summary.errors.length ? ` errors: ${summary.errors.join(' | ')}` : '')
        );
      }
    } catch (err) {
      console.error('[reconciler]', err.message);
    }
  };
  reconcileTimer = setInterval(tick, RECONCILE_EVERY_MS);
  reconcileTimer.unref?.();
  tick();
}

server.listen(PORT, () => {
  console.log(`\n  LabDDB × UprintBD bridge (dev)`);
  console.log(`  ------------------------------------------`);
  console.log(`  Cover-page generator : http://localhost:${PORT}/`);
  console.log(`  Project admin        : http://localhost:${PORT}/console.html`);
  console.log(`  Coverpage admin      : http://localhost:${PORT}/admin.html`);
  console.log(`  UprintBD account     : ${process.env.UPRINT_EMAIL}`);
  console.log(`  Target               : ${process.env.UPRINT_BASE_URL || BASE}`);
  console.log(`  Reconciler           : every ${RECONCILE_EVERY_MS / 1000}s`);
  console.log(`  ------------------------------------------\n`);
  startReconciler();
});
