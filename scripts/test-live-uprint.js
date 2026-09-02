/**
 * scripts/test-live-uprint.js — Live integration test for UprintBDAdapter.
 * -----------------------------------------------------------------------------
 * Validates the adapter implementation against live uprintbd.com.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { UprintBDAdapter } = require('../lib/infrastructure/uprint/adapter.js');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > -1) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

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
  objs.forEach((o, idx) => {
    offs.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => (pdf += `${String(o).padStart(10, '0')} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

(async () => {
  console.log('=== Live UprintBDAdapter Integration Audit ===\n');

  if (!process.env.UPRINT_EMAIL || !process.env.UPRINT_PASSWORD) {
    console.error('LIVE UPRINTBD VERIFICATION: BLOCKED (Missing credentials in .env)');
    process.exit(1);
  }

  const adapter = new UprintBDAdapter({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
    baseUrl: process.env.UPRINT_BASE_URL || 'https://uprintbd.com',
  });

  console.log('1. Authenticating & establishing session...');
  await adapter.ensureLogin();
  console.log('   Session acquired successfully.');

  console.log('2. Fetching institutional account balance...');
  const balance = await adapter.getAccountBalance();
  console.log(`   Institutional balance: ৳${balance}`);

  console.log('3. Uploading real PDF & creating real kiosk print request...');
  const pdfBytes = makePdf('UprintBDAdapter Live Audit');
  const job = await adapter.uploadAndQueue(pdfBytes, {
    filename: 'AUDIT_TEST.pdf',
    copies: 1,
    color: false,
  });
  console.log(`   Kiosk OTP minted: ${job.otp}`);
  console.log(`   Record ID: ${job.recordId}`);
  console.log(`   Countdown / Valid for: ${job.validForSeconds} seconds`);

  console.log('4. Inspecting active queued record IDs on dashboard...');
  const queued = await adapter.getQueuedRecordIds();
  const isQueued = queued.has(String(job.recordId));
  console.log(`   Record ${job.recordId} present in active queue: ${isQueued}`);

  console.log('5. Fetching real print history table...');
  const history = await adapter.getPrintHistory({ sinceMs: Date.now() - 24 * 3600 * 1000 });
  console.log(`   Fetched ${history.length} print history rows from UprintBD.`);

  console.log('6. Cleaning up: deleting print request (INV-6)...');
  const deleted = await adapter.deletePrintRequest(job.recordId);
  console.log(`   Delete confirmed: ${deleted}`);

  const queuedAfter = await adapter.getQueuedRecordIds();
  const gone = !queuedAfter.has(String(job.recordId));
  console.log(`   Record cleanly removed from dashboard queue: ${gone}`);

  if (job.otp && isQueued && deleted && gone) {
    console.log('\nLIVE UPRINTBD ADAPTER VERIFICATION: PASSED ✅');
  } else {
    console.error('\nLIVE UPRINTBD ADAPTER VERIFICATION: FAILED ❌');
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nLive UprintBD Verification Error:', err.message);
  process.exit(1);
});
