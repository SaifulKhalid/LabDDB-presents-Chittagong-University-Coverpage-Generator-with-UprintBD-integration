/**
 * probe-history.js — READ-ONLY.
 *
 * Fetches /uprint/print_history/ and /uprint/transaction_history/ and reports
 * their table structure. These are the two sources of truth for answering
 * "was this job actually printed, and what did UprintBD really charge?"
 * No uploads, no jobs, no spend.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const l = raw.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i < 0) continue;
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const { UprintSession } = require(path.join(ROOT, 'lib', 'uprint-bridge.js'));

const BASE = process.env.UPRINT_BASE_URL || 'https://uprintbd.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function textCells(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\s+/g, ' ');
}

(async () => {
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });
  await s.ensureLogin();

  for (const page of ['print_history', 'transaction_history', 'payment_history']) {
    const r = await fetch(`${BASE}/uprint/${page}/`, {
      headers: { 'User-Agent': UA, Cookie: s.jar.header(), Referer: `${BASE}/uprint/dashboard/` },
      redirect: 'manual',
    });
    s.jar.absorb(r);
    const html = await r.text();
    fs.writeFileSync(path.join(__dirname, `_${page}.html`), html);
    const flat = textCells(html);

    console.log(`\n========== /uprint/${page}/  HTTP ${r.status}  ${html.length}B ==========`);

    // column headers
    const heads = [...flat.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
    console.log('HEADERS:', JSON.stringify(heads));

    // first few data rows
    const rows = [...flat.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) =>
        [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
          c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        )
      )
      .filter((r) => r.length);
    console.log(`ROWS: ${rows.length}`);
    rows.slice(0, 6).forEach((r, i) => console.log(` [${i}]`, JSON.stringify(r)));

    // any status vocabulary present
    const vocab = [
      ...new Set(
        (flat.match(/\b(Printed|Completed|Success\w*|Fail\w*|Cancel\w*|Expired|In Queue|Pending|Deleted|Refund\w*)\b/gi) || [])
          .map((v) => v.toLowerCase())
      ),
    ];
    console.log('STATUS VOCAB:', JSON.stringify(vocab));
  }
})();
