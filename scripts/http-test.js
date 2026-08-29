/**
 * http-test.js — exercises the running bridge exactly as the browser does.
 * -----------------------------------------------------------------------------
 *   GET  /api/health            no auth
 *   GET  /api/config            no auth
 *   POST /api/print   (no token)   -> must be 401: the auth gate itself
 *   GET  /api/me                   -> wallet before
 *   POST /api/print   (Bearer)     -> real OTP, money RESERVED not charged
 *   GET  /api/me                   -> balance unchanged, reserved up by cost
 *   POST /api/cancel  { jobId }    -> hold returned
 *   GET  /api/me                   -> back exactly where we started
 *
 * The middle assertions are the product promise over real HTTP: an OTP was
 * minted and the balance never moved. Only a confirmed print may move it.
 *
 * Steps 1-3 need nothing. The rest needs a Firebase ID token, because
 * /api/print requires one by design. Get one from the browser console while
 * signed in:
 *
 *   await LabDDB.auth.getToken()
 *
 * then either
 *   TEST_ID_TOKEN=eyJ... npm run test:http
 *   node scripts/http-test.js eyJ...
 *
 * Tokens last an hour. Without one the script still verifies the gate and says
 * so, rather than failing in a way that looks like a broken server.
 */
'use strict';

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const TOKEN = (process.env.TEST_ID_TOKEN || process.argv[2] || '').trim();

let failures = 0;
function ok(cond, label, detail) {
  if (cond) {
    console.log(`   ok   ${label}`);
  } else {
    failures += 1;
    console.log(`   FAIL ${label}${detail ? ' - ' + detail : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Minimal valid one-page PDF (same builder as the smoke test). */
function makePdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 750 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, idx) => { offs.push(pdf.length); pdf += `${idx + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => (pdf += `${String(o).padStart(10, '0')} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const authed = (extra) =>
  Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}, extra);

async function call(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers || authed(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

/** Wallet from /api/me, or null with the reason printed. */
async function walletNow() {
  const me = await call('GET', '/api/me');
  if (me.status !== 200 || !me.data || !me.data.wallet) {
    console.log(`   (GET /api/me -> HTTP ${me.status} ${JSON.stringify(me.data)})`);
    return null;
  }
  return me.data.wallet;
}

(async () => {
  console.log(`HTTP route test against ${BASE}\n`);

  // -- 1. health -------------------------------------------------------------
  console.log('1) GET /api/health');
  const h = await call('GET', '/api/health');
  console.log('  ', JSON.stringify(h.data));
  eq(h.status, 200, 'health answers 200');
  ok(h.data && h.data.configured, 'reports which subsystems are configured');
  if (h.data && h.data.missing && h.data.missing.length) {
    console.log(`   note: not configured yet -> ${h.data.missing.join(', ')}`);
    console.log('         wallet/auth routes will answer 503. See docs/PRODUCTION-SETUP.md.');
  }

  // -- 2. config -------------------------------------------------------------
  console.log('\n2) GET /api/config');
  const cfg = await call('GET', '/api/config');
  console.log('  ', JSON.stringify(cfg.data));
  eq(cfg.status, 200, 'config answers 200 with no auth');
  ok(cfg.data && cfg.data.pricing && cfg.data.pricing.mono > 0, 'quotes a mono price');

  // -- 3. the gate -----------------------------------------------------------
  // The whole point of 2.0: minting spends money, so it needs an identity.
  console.log('\n3) POST /api/print with no token (must be refused)');
  const pdfBase64 = makePdf('LabDDB HTTP Route Test').toString('base64');
  const anon = await call('POST', '/api/print', { pdfBase64, filename: 'HTTP_TEST.pdf' }, { 'Content-Type': 'application/json' });
  console.log('   HTTP', anon.status, JSON.stringify(anon.data));
  eq(anon.status, 401, 'an anonymous mint is refused with 401');
  ok(anon.data && anon.data.ok === false, 'and says so in the envelope');

  if (!TOKEN) {
    console.log('\n' + '-'.repeat(60));
    console.log('Auth gate verified. Stopping here: no TEST_ID_TOKEN supplied, and');
    console.log('/api/print needs one by design. To run the money assertions too:');
    console.log('\n  1. open the app, sign in with Google');
    console.log('  2. in the browser console:  await LabDDB.auth.getToken()');
    console.log('  3. TEST_ID_TOKEN=<that> npm run test:http\n');
    process.exit(failures ? 1 : 0);
  }

  // -- 4. wallet before ------------------------------------------------------
  console.log('\n4) GET /api/me (wallet before)');
  const before = await walletNow();
  if (!before) {
    console.error('\nCannot read the wallet — is LABDDB_SERVICE_ACCOUNT set and the token current?');
    process.exit(1);
  }
  console.log('  ', JSON.stringify(before));

  // -- 5. mint ---------------------------------------------------------------
  console.log('\n5) POST /api/print (real base64 PDF, as the browser sends)');
  const print = await call('POST', '/api/print', { pdfBase64, filename: 'HTTP_TEST.pdf', copies: 2, color: false });
  console.log('   HTTP', print.status, JSON.stringify(print.data));

  if (print.status === 402) {
    console.log('\n' + '-'.repeat(60));
    console.log(`Not enough DDB balance to mint: needs ৳${print.data.required}, has ৳${print.data.available}.`);
    console.log('Top this account up from /console.html, then run again.');
    console.log('(The refusal itself is correct behaviour, so this is not a failure.)');
    process.exit(failures ? 1 : 0);
  }

  eq(print.status, 200, 'mint answers 200');
  const job = print.data || {};
  ok(/^\d{4,8}$/.test(job.otp || ''), 'returns a real OTP', JSON.stringify(job.otp));
  ok(job.jobId, 'and a jobId to cancel it with');
  ok(job.cost > 0, `charges a price (৳${job.cost})`);
  ok(
    job.filename && job.filename !== 'HTTP_TEST.pdf' && /HTTP_TEST/.test(job.filename),
    'appends a server-side unique suffix to the filename',
    job.filename
  );
  if (job.otp) console.log(`   ✅ OTP via HTTP: ${job.otp}  (৳${job.cost}, ${job.pages}p × ${job.copies})`);

  // -- 6. THE HEADLINE PROPERTY ---------------------------------------------
  // A code exists. Nothing printed. The balance must not have moved.
  console.log('\n6) GET /api/me (money reserved, not charged)');
  const during = await walletNow();
  console.log('  ', JSON.stringify(during));
  if (during) {
    eq(during.balance, before.balance, 'balance is UNCHANGED — an OTP alone never charges');
    eq(during.reserved, before.reserved + job.cost, 'the price is held in reserved instead');
    eq(during.available, before.available - job.cost, 'so available drops by exactly the price');
  }
  if (print.data.wallet) {
    eq(print.data.wallet.balance, before.balance, 'and the mint response agrees');
  }

  // -- 7. cancel -------------------------------------------------------------
  console.log('\n7) POST /api/cancel { jobId }');
  const cancel = await call('POST', '/api/cancel', { jobId: job.jobId });
  console.log('   HTTP', cancel.status, JSON.stringify(cancel.data));
  eq(cancel.status, 200, 'cancel answers 200');

  console.log('\n8) GET /api/me (hold returned)');
  const after = await walletNow();
  console.log('  ', JSON.stringify(after));
  if (after) {
    eq(after.balance, before.balance, 'balance never moved at any point');
    eq(after.reserved, before.reserved, 'the hold is fully released');
    eq(after.available, before.available, 'back exactly where we started — the unused code cost nothing');
  }

  console.log('\n' + '-'.repeat(60));
  if (failures) {
    console.error(`HTTP ROUTE TEST FAILED ❌  (${failures} assertion${failures === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log('HTTP ROUTE TEST PASSED ✅  — minted a real OTP and charged nothing for it.');
})().catch((e) => {
  console.error('\nHTTP ROUTE TEST FAILED ❌:', (e && e.message) || e);
  process.exit(1);
});
