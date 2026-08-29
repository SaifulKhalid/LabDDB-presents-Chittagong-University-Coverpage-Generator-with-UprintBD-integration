/**
 * probe-cost.js — finds the AUTHORITATIVE price. No OTP, no spend.
 *
 * The site prices a job with POST /uprint/printer_selected/
 *   { outlet_id, printer_id, file_id, csrfmiddlewaretoken }
 * and reads back { status, cost, user_balance }, where status is one of
 *   ready_to_print | insufficient_balance | unsupported_color |
 *   unsupported_duplex | no_file_found
 *
 * That is the real quote: it knows the outlet's rate AND the document, so it is
 * the number the bridge should be showing instead of its hardcoded 3 Tk/page.
 *
 * DECISIVE TEST: we upload a **3-page** stub. print_history shows a 1-page job
 * really cost 2.0 Tk, so
 *   cost == 6  -> `cost` is the JOB TOTAL at 2 Tk/page
 *   cost == 2  -> `cost` is the PER-PAGE unit price and we must multiply
 *
 * Stops before accept_print_info, so nothing is queued and no balance moves.
 * The uploaded record is deleted at the end and the balance is re-read to prove
 * the account is left exactly as we found it.
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
const { UprintSession, countPdfPages } = require(path.join(ROOT, 'lib', 'uprint-bridge.js'));

const BASE = process.env.UPRINT_BASE_URL || 'https://uprintbd.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const OUTLET = process.env.PROBE_OUTLET || 'test.uprintbd@gmail.com'; // Dept. of EEE_CU_Uprint
const PAGES = parseInt(process.env.PROBE_PAGES || '3', 10);

/** Byte-correct N-page A4 PDF with a real xref table. */
function minimalPdf(n) {
  const kids = Array.from({ length: n }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${n}>>`,
    ...Array.from(
      { length: n },
      () => '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>'
    ),
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

(async () => {
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });

  const before = await s.getProfile().catch(() => null);
  const balBefore = before ? before.balance ?? JSON.stringify(before).slice(0, 120) : '(unreadable)';
  console.log('balance BEFORE   :', balBefore);

  await s.ensureLogin();

  const pdf = minimalPdf(PAGES);
  console.log(`stub PDF         : ${PAGES} pages requested, countPdfPages() sees ${countPdfPages(pdf)}`);

  // fresh token, then upload
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
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'cost_probe.pdf');
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
  const fileId = ((up.headers.get('location') || '').match(/set_options\/(\d+)/) || [])[1];
  console.log('upload           :', up.status, fileId ? `file_id=${fileId}` : '(no id)');
  if (!fileId) return;

  try {
    // kiosks for this outlet
    const od = await fetch(
      `${BASE}/uprint/fetch_outlet_data/?outlet_id=${encodeURIComponent(OUTLET)}`,
      {
        headers: {
          'User-Agent': UA,
          Cookie: s.jar.header(),
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE}/uprint/set_options/${fileId}/`,
        },
        redirect: 'manual',
      }
    );
    s.jar.absorb(od);
    const outletJson = await od.json().catch(() => null);
    const kiosks = outletJson && Array.isArray(outletJson.options) ? outletJson.options : [];
    console.log(`outlet           : ${OUTLET} -> ${kiosks.length} kiosk(s)`);
    for (const k of kiosks) console.log(`   ${k.kiosk_id}  ${k.kiosk_name}  status=${JSON.stringify(k.status)}`);
    if (!kiosks.length) return console.log('no kiosks — cannot price.');

    // price against every kiosk (rates can differ per device/outlet)
    for (const k of kiosks) {
      const body = new URLSearchParams({
        outlet_id: OUTLET,
        printer_id: k.kiosk_id,
        file_id: fileId,
        csrfmiddlewaretoken: s.csrf,
      }).toString();

      const ps = await fetch(`${BASE}/uprint/printer_selected/`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Cookie: s.jar.header(),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRFToken': s.csrf,
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE,
          Referer: `${BASE}/uprint/set_options/${fileId}/`,
        },
        body,
        redirect: 'manual',
      });
      s.jar.absorb(ps);
      const txt = await ps.text();
      let j = null;
      try {
        j = JSON.parse(txt);
      } catch {
        /* ignore */
      }

      console.log(`\n--- printer_selected(${k.kiosk_id}) HTTP ${ps.status} ---`);
      if (!j) {
        console.log(txt.slice(0, 400).replace(/\s+/g, ' '));
        continue;
      }
      console.log('  keys        :', JSON.stringify(Object.keys(j)));
      console.log('  status      :', JSON.stringify(j.status));
      console.log('  cost        :', JSON.stringify(j.cost));
      console.log('  user_balance:', JSON.stringify(j.user_balance));
      const known = new Set(['status', 'cost', 'user_balance']);
      for (const key of Object.keys(j).filter((x) => !known.has(x))) {
        console.log(`  ${key} = ${JSON.stringify(j[key]).slice(0, 300)}`);
      }

      if (typeof j.cost !== 'undefined' && j.cost !== null) {
        const c = Number(j.cost);
        console.log(
          `  >>> VERDICT : ${PAGES} pages -> cost ${c}.  ` +
            (c === 2 * PAGES
              ? 'cost is the JOB TOTAL (2 Tk/page).'
              : c === 2
              ? 'cost is a PER-PAGE unit price -> must multiply by pages x copies.'
              : `neither 2 nor ${2 * PAGES} — rate is ${(c / PAGES).toFixed(3)} Tk/page if total.`)
        );
      }
    }
  } finally {
    console.log('\ndeleted record   :', fileId, '->', await s.deletePrintRequest(fileId));
    const after = await s.getProfile().catch(() => null);
    const balAfter = after ? after.balance ?? JSON.stringify(after).slice(0, 120) : '(unreadable)';
    console.log('balance AFTER    :', balAfter, balBefore === balAfter ? '(unchanged ✓)' : '(CHANGED!)');
  }
})();
