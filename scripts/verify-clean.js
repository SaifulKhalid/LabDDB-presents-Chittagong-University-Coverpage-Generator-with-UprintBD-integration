/**
 * verify-clean.js — confirms the specific jobs created during testing are gone.
 * Uses only the public UprintSession API (scrapeOtp returns null once deleted).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { UprintSession } = require('../lib/uprint-bridge');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > -1) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

// Record ids created during this session's tests.
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['13696', '13697'];

(async () => {
  const s = new UprintSession({ email: process.env.UPRINT_EMAIL, password: process.env.UPRINT_PASSWORD });
  await s.login();
  let anyLeft = false;
  for (const id of IDS) {
    const otp = await s.scrapeOtp(id);
    const gone = otp === null;
    if (!gone) anyLeft = true;
    console.log(`  job ${id}: ${gone ? 'deleted ✓' : 'STILL PRESENT (otp ' + otp + ')'}`);
  }
  console.log(anyLeft ? '\n⚠️ Some test jobs remain.' : '\n✅ All test jobs removed — account is clean.');
  process.exit(anyLeft ? 1 : 0);
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
