/**
 * probe-outlet.js — probes the authoritative pricing endpoint.
 *
 * The options page's own JS calls /uprint/fetch_outlet_data/ and reads
 * `response.cost` + `response.user_balance` — i.e. the REAL per-outlet price,
 * not the hardcoded estimate. This dumps that response, the outlet list, and
 * the surrounding JS, then cleans up. No accept_print_info -> no OTP, no spend.
 *
 * Also saves the raw set_options HTML to scripts/_set_options.html for reading.
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

function minimalPdf() {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const BASE = process.env.UPRINT_BASE_URL || 'https://uprintbd.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

(async () => {
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });
  await s.ensureLogin();

  const dash = await fetch(`${BASE}/uprint/dashboard/`, {
    headers: { 'User-Agent': UA, Cookie: s.jar.header() },
    redirect: 'manual',
  });
  s.jar.absorb(dash);
  const tok =
    ((await dash.text()).match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/) ||
      [])[1] || s.csrf;

  const form = new FormData();
  form.append('csrfmiddlewaretoken', tok);
  form.append('file', new Blob([minimalPdf()], { type: 'application/pdf' }), 'outlet_probe.pdf');
  const up = await fetch(`${BASE}/uprint/uploader/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: s.jar.header(),
      Origin: BASE,
      Referer: `${BASE}/uprint/dashboard/`,
    },
    body: form,
    redirect: 'manual',
  });
  s.jar.absorb(up);
  const id = ((up.headers.get('location') || '').match(/set_options\/(\d+)/) || [])[1];
  if (!id) return console.log('no recordId');
  console.log('recordId:', id);

  const opt = await fetch(`${BASE}/uprint/set_options/${id}/`, {
    headers: { 'User-Agent': UA, Cookie: s.jar.header(), Referer: `${BASE}/uprint/dashboard/` },
    redirect: 'manual',
  });
  s.jar.absorb(opt);
  const html = await opt.text();
  fs.writeFileSync(path.join(__dirname, '_set_options.html'), html);

  // every outlet option in the dropdown
  console.log('\n--- outlets available to this account ---');
  for (const m of html.matchAll(/<option value="([^"]*)"[^>]*data-name="([^"]*)"/g)) {
    console.log(` ${m[2]}  ->  ${m[1]}`);
  }

  // every /uprint/ endpoint the page talks to
  console.log('\n--- uprint endpoints referenced by the page ---');
  console.log(
    [...new Set([...html.matchAll(/['"`](\/uprint\/[a-z_]+\/)/g)].map((m) => m[1]))].join('\n')
  );

  // call the authoritative pricing endpoint for each outlet
  const outlets = [...new Set([...html.matchAll(/<option value="([^"]+)"[^>]*data-name=/g)].map((m) => m[1]))];
  for (const o of outlets) {
    const r = await fetch(
      `${BASE}/uprint/fetch_outlet_data/?outlet_id=${encodeURIComponent(o)}`,
      {
        headers: {
          'User-Agent': UA,
          Cookie: s.jar.header(),
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': s.csrf,
          Referer: `${BASE}/uprint/set_options/${id}/`,
        },
        redirect: 'manual',
      }
    );
    const body = await r.text();
    console.log(`\n--- fetch_outlet_data(${o}) -> HTTP ${r.status} ---`);
    console.log(body.slice(0, 800));
  }

  console.log('\ndeleted:', await s.deletePrintRequest(id));
  const p = await s.getProfile().catch(() => null);
  console.log('balance:', p ? p.balance : '?');
})();
