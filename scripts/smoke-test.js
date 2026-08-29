/**
 * smoke-test.js — verify the bridge mints a real OTP end-to-end, then cleans up.
 * Usage: node scripts/smoke-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { UprintSession } = require('../lib/uprint-bridge');

// load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > -1) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

// Minimal valid one-page PDF built in-memory.
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
  const s = new UprintSession({
    email: process.env.UPRINT_EMAIL,
    password: process.env.UPRINT_PASSWORD,
  });
  console.log('1) logging in ...');
  await s.login();
  console.log('   sessionid acquired:', !!s.jar.get('sessionid'));

  console.log('2) uploading test cover page + accepting options ...');
  const pdf = makePdf('LabDDB Smoke Test Cover Page');
  const r = await s.printAndGetOtp(pdf, {
    filename: 'SMOKE_TEST.pdf',
    copies: 1,
    color: false,
  });
  console.log('   RESULT:', JSON.stringify(r, null, 2));

  if (!/^\d{4,8}$/.test(r.otp)) throw new Error('OTP not in expected format!');
  console.log(`\n   ✅ OTP minted: ${r.otp}  (cost ${r.cost} ${r.currency})`);

  console.log('3) cleaning up test job ...');
  const del = await s.deletePrintRequest(r.recordId);
  console.log('   deleted:', del);
  console.log('\nSMOKE TEST PASSED ✅');
})().catch((e) => {
  console.error('\nSMOKE TEST FAILED ❌:', e.message);
  process.exit(1);
});
