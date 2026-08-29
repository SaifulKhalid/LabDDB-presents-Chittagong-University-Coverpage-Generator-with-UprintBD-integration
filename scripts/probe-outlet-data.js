/**
 * probe-outlet-data.js — STRICTLY READ-ONLY.
 *
 * Calls /uprint/fetch_outlet_data/?outlet_id=<id> for every outlet the account
 * can see. The endpoint takes ONLY outlet_id (confirmed at all three call sites
 * in the page's own JS: one fetch() and two $.ajax()), so it needs no uploaded
 * record — this probe creates no record, queues no job, mints no OTP, spends
 * nothing. Pure GET sweep.
 *
 * NOTE ON `cost`: an earlier reading of the page assumed fetch_outlet_data
 * returned cost/user_balance. It does not — those come from the POST to
 * /uprint/printer_selected/ (which also receives file_id, so it can price the
 * actual document). fetch_outlet_data returns the KIOSK LIST. See probe-cost.js
 * for the authoritative price. This probe answers:
 *
 *   1. Which kiosks does each outlet expose (kiosk_id / kiosk_name / status)?
 *   2. Which of them are online right now?
 *   3. What else does the payload carry that we have not accounted for?
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

// Outlets scraped from scripts/_set_options.html (option value = outlet account email).
const OUTLETS = [
  ['Dept. of EEE_CU_Uprint', 'test.uprintbd@gmail.com'],
  ['Abdur Rab Hall_CU_Uprint', 'rabhallcu.uprintbd@gmail.com'],
  ['Shaheed Farhad Hossain Hall_CU_Uprint', 'shaheedforhadhossainhall@gmail.com'],
  ['Begum Khaleda Zia Hall_CU_Uprint', 'najifa92tasfi@gmail.com'],
  ['Stellar Uprint', 'stellar.uprintbd@gmail.com'],
  ['Factory Next Dhaka', 'iaj.ankon@gmail.com'],
  ['Test Outlet', 'mdsaifuzzamansohan@gmail.com'],
];

(async () => {
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });
  await s.ensureLogin();

  const summary = [];
  const dump = {};

  for (const [name, id] of OUTLETS) {
    const r = await fetch(
      `${BASE}/uprint/fetch_outlet_data/?outlet_id=${encodeURIComponent(id)}`,
      {
        headers: {
          'User-Agent': UA,
          Cookie: s.jar.header(),
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE}/uprint/dashboard/`,
        },
        redirect: 'manual',
      }
    );
    s.jar.absorb(r);
    const body = await r.text();

    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* leave null; raw body printed below */
    }

    console.log(`\n===== ${name} =====`);
    console.log(`  outlet_id : ${id}`);
    console.log(`  HTTP      : ${r.status}`);

    if (!json) {
      console.log('  (non-JSON response, first 300B)');
      console.log('  ' + body.slice(0, 300).replace(/\s+/g, ' '));
      continue;
    }
    dump[id] = json;

    console.log(`  keys      : ${JSON.stringify(Object.keys(json))}`);

    const kiosks = Array.isArray(json.options) ? json.options : [];
    console.log(`  kiosks    : ${kiosks.length}`);
    let online = 0;
    for (const k of kiosks) {
      // Only "Device Online" is actually printable. "Printer Disconnected" and
      // "Device Offline (No response found)" both mean the job would not come
      // out, so anything that is not exactly online counts as unusable.
      const usable = String(k.status || '').trim() === 'Device Online';
      if (usable) online++;
      console.log(
        `      - ${String(k.kiosk_id).padEnd(14)} ${JSON.stringify(k.kiosk_name)}  ` +
          `status=${JSON.stringify(k.status)}${usable ? '' : '   << UNUSABLE'}`
      );
      // surface any per-kiosk capability flags (colour/duplex support etc.)
      const extraK = Object.keys(k).filter(
        (x) => !['kiosk_id', 'kiosk_name', 'status'].includes(x)
      );
      if (extraK.length) {
        console.log(
          '        caps: ' + extraK.map((x) => `${x}=${JSON.stringify(k[x])}`).join(' ')
        );
      }
    }

    // Anything we did not anticipate is worth seeing verbatim.
    const extra = Object.keys(json).filter((k) => k !== 'options');
    if (extra.length) {
      console.log('  OTHER TOP-LEVEL FIELDS:');
      for (const k of extra) {
        console.log(`      ${k} = ${JSON.stringify(json[k]).slice(0, 300)}`);
      }
    }

    summary.push({ name, id, kiosks: kiosks.length, online });
  }

  fs.writeFileSync(
    path.join(__dirname, '_outlet_data.json'),
    JSON.stringify(dump, null, 2)
  );

  console.log('\n================ SUMMARY ================');
  for (const row of summary) {
    console.log(
      `${String(row.online).padStart(2)}/${String(row.kiosks).padEnd(2)} usable   ${row.name}`
    );
  }
  console.log('\nRaw payloads saved to scripts/_outlet_data.json');
})();
