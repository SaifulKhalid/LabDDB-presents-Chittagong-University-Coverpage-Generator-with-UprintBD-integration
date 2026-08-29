/**
 * probe-price.js — READ-ONLY-ish probe of the options page.
 *
 * Uploads a 1-page stub PDF to get a recordId, then dumps whatever pricing
 * information /uprint/set_options/<id>/ exposes, then deletes the record.
 *
 * It deliberately does NOT call accept_print_info — so no job is queued,
 * no OTP is minted, and no balance is spent. Balance is read before and
 * after to prove that.
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

/** Build a byte-correct minimal 1-page A4 PDF (with a real xref table). */
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

  const before = await s.getProfile().catch(() => null);
  console.log('balance BEFORE :', before ? before.balance : '(unreadable)');

  await s.ensureLogin();

  // fresh token from the dashboard, then upload
  const dash = await fetch(`${BASE}/uprint/dashboard/`, {
    headers: { 'User-Agent': UA, Cookie: s.jar.header() },
    redirect: 'manual',
  });
  s.jar.absorb(dash);
  const dashHtml = await dash.text();
  const tok =
    (dashHtml.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/) || [])[1] ||
    s.csrf;

  const form = new FormData();
  form.append('csrfmiddlewaretoken', tok);
  form.append('file', new Blob([minimalPdf()], { type: 'application/pdf' }), 'price_probe.pdf');

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
  const loc = up.headers.get('location') || '';
  const id = (loc.match(/set_options\/(\d+)/) || [])[1];
  console.log('upload        :', up.status, loc || '(no location)');
  if (!id) {
    console.log('no recordId — stopping.');
    return;
  }

  // The page the browser shows the "estimated cost" on.
  const opt = await fetch(`${BASE}/uprint/set_options/${id}/`, {
    headers: { 'User-Agent': UA, Cookie: s.jar.header(), Referer: `${BASE}/uprint/dashboard/` },
    redirect: 'manual',
  });
  s.jar.absorb(opt);
  const html = await opt.text();
  console.log('set_options   :', opt.status, `${html.length} bytes`);

  console.log('\n--- lines mentioning price / cost / rate / outlet ---');
  const hits = html
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /price|cost|rate|per.?page|mono|colou?r_?price|outlet|shop|branch|taka|bdt|৳/i.test(l))
    .filter((l) => l.length < 400);
  console.log(hits.slice(0, 60).join('\n') || '(none)');

  console.log('\n--- numeric assignments that look like unit prices ---');
  const nums = [
    ...html.matchAll(/(?:var|let|const)\s+(\w*(?:price|cost|rate)\w*)\s*=\s*["']?([\d.]+)/gi),
  ].map((m) => `${m[1]} = ${m[2]}`);
  const dataAttrs = [...html.matchAll(/data-[\w-]*(?:price|cost|rate)[\w-]*=["']([^"']+)["']/gi)].map(
    (m) => m[0]
  );
  console.log([...new Set([...nums, ...dataAttrs])].join('\n') || '(none)');

  // clean up — leave the account exactly as we found it
  const del = await s.deletePrintRequest(id);
  console.log('\ndeleted record:', id, '->', del);

  const after = await s.getProfile().catch(() => null);
  console.log('balance AFTER :', after ? after.balance : '(unreadable)');
})();
