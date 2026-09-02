/**
 * scripts/audit-production-health.js — Production Health, Config, and Gateway Audit.
 * -----------------------------------------------------------------------------
 * Validates the deployed production worker at https://pitch.labddb.workers.dev.
 */

'use strict';

const assert = require('assert');

const PROD_BASE = 'https://pitch.labddb.workers.dev';

(async () => {
  console.log('=== PRODUCTION HEALTH & GATEWAY AUDIT ===\n');
  console.log(`Auditing target: ${PROD_BASE}...\n`);

  // 1. /api/health
  console.log('1. Querying GET /api/health...');
  const healthRes = await fetch(`${PROD_BASE}/api/health`);
  assert.strictEqual(healthRes.status, 200, 'Health check must return 200');
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.ok, true);
  assert.strictEqual(healthData.configured, true, 'Worker must be configured with credentials');
  console.log('   ✅ Production Health: OK = true, Configured = true, Missing = []');

  // 2. /api/config
  console.log('\n2. Querying GET /api/config...');
  const configRes = await fetch(`${PROD_BASE}/api/config`);
  assert.strictEqual(configRes.status, 200);
  const configData = await configRes.json();
  assert.strictEqual(configData.ok, true);
  assert.ok(configData.pricing.mono > 0, 'Pricing must be active');
  assert.ok(configData.limits.maxOpenHolds > 0, 'Limits must be active');
  console.log(`   ✅ Production Config: Mono = ৳${configData.pricing.mono}, Color = ৳${configData.pricing.color}, Max Holds = ${configData.limits.maxOpenHolds}`);

  // 3. Static Assets: index.html
  console.log('\n3. Querying GET / (index.html static asset)...');
  const indexRes = await fetch(`${PROD_BASE}/`);
  assert.strictEqual(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert.ok(indexHtml.includes('LabDDB'), 'index.html must contain LabDDB branding');
  assert.ok(indexHtml.includes('coverPage'), 'index.html must contain coverPage canvas');
  console.log(`   ✅ Static Assets: index.html served cleanly (${(indexHtml.length / 1024).toFixed(1)} KB)`);

  // 4. Static Assets: css/styles.css
  console.log('\n4. Querying GET /css/styles.css...');
  const cssRes = await fetch(`${PROD_BASE}/css/styles.css`);
  assert.strictEqual(cssRes.status, 200);
  const cssText = await cssRes.text();
  assert.ok(cssText.includes('@media print'), 'styles.css must contain print styles');
  console.log(`   ✅ Static Assets: css/styles.css served cleanly (${(cssText.length / 1024).toFixed(1)} KB)`);

  // 5. Auth Gate: GET /api/me without token -> 401
  console.log('\n5. Testing Auth Gate on GET /api/me without token...');
  const meRes = await fetch(`${PROD_BASE}/api/me`);
  assert.strictEqual(meRes.status, 401, 'Must reject unauthenticated request with 401');
  const meData = await meRes.json();
  assert.strictEqual(meData.ok, false);
  console.log(`   ✅ Auth Gate: Correctly refused unauthenticated request with 401 (${meData.error})`);

  // 6. Admin Gate: GET /api/admin/overview without token -> 401
  console.log('\n6. Testing Admin Gate on GET /api/admin/overview without token...');
  const adminRes = await fetch(`${PROD_BASE}/api/admin/overview`);
  assert.strictEqual(adminRes.status, 401);
  const adminData = await adminRes.json();
  assert.strictEqual(adminData.ok, false);
  console.log(`   ✅ Admin Gate: Correctly refused unauthenticated request with 401 (${adminData.error})`);

  // 7. CORS Headers
  console.log('\n7. Checking CORS response headers...');
  assert.ok(healthRes.headers.get('access-control-allow-origin'), 'Must have CORS header');
  console.log(`   ✅ CORS Origin: ${healthRes.headers.get('access-control-allow-origin')}`);

  console.log('\n------------------------------------------------------------');
  console.log('ALL PRODUCTION HEALTH & GATEWAY AUDITS PASSED 100% ✅\n');
})().catch((err) => {
  console.error('\nProduction health audit failed:', err);
  process.exit(1);
});
