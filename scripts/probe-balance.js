/**
 * probe-balance.js — READ-ONLY probe.
 * Logs in and dumps the profile/wallet payload so we can see whether UprintBD
 * exposes a balance we can read for reconciliation. Creates no print job,
 * costs nothing, deletes nothing.
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

(async () => {
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });
  try {
    const p = await s.getProfile();
    console.log('--- profile top-level keys ---');
    console.log(JSON.stringify(Object.keys(p || {})));
    console.log('--- payload (truncated) ---');
    console.log(JSON.stringify(p, null, 1).slice(0, 2000));
  } catch (e) {
    console.log('profile error:', e.message);
  }
})();
