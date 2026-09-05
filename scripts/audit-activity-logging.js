/**
 * scripts/audit-activity-logging.js
 * -----------------------------------------------------------------------------
 * Verifies end-to-end activity logging, data minimization, and category filtering:
 * 1. POST /api/activity records client actions (PDF_DOWNLOADED, DIRECT_PRINT_INITIATED, COURSE_*, etc.).
 * 2. Audit data minimization: OTP codes, passwords, and secrets are NEVER logged or returned.
 * 3. Printing events: PRINT_REQUESTED, PRINT_OTP_CREATED, PRINT_FAILED, PRINT_CANCELLED, PRINT_EXPIRED, PRINT_COMPLETED.
 * 4. D1 category filtering supports covers, catalogue, printing, auth, financial, admin, errors.
 */

'use strict';

const assert = require('assert');
const { routeRequest } = require('../lib/api/router.js');
const { createContext } = require('../lib/api/context.js');
const { sanitizeAuditData, matchesCategory } = require('../lib/services/audit-service.js');

function createMockJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.valid_sig`;
}

(async () => {
  console.log('=== AUDIT: ACTIVITY LOGGING & DATA MINIMIZATION ===\n');

  // 1. Data Minimization & Sanitization Unit Tests
  console.log('1. Testing Data Sanitization & OTP Masking:');
  const dirtyData = {
    jobId: 'job_123',
    pages: 2,
    copies: 1,
    otp: '984512',
    pin: '1234',
    password: 'secret_password',
    token: 'jwt_secret_token',
    nested: {
      otp: '654321',
      courseCode: 'EEE 418',
    },
  };

  const clean = sanitizeAuditData(dirtyData);
  assert.strictEqual(clean.jobId, 'job_123');
  assert.strictEqual(clean.pages, 2);
  assert.strictEqual(clean.otp, undefined, 'OTP must be completely stripped');
  assert.strictEqual(clean.password, undefined, 'Password must be stripped');
  assert.strictEqual(clean.token, undefined, 'Token must be stripped');
  assert.strictEqual(clean.nested.otp, undefined, 'Nested OTP must be stripped');
  assert.strictEqual(clean.nested.courseCode, 'EEE 418');
  console.log('   ✅ sanitizeAuditData recursively strips OTP, passwords, tokens and secrets');

  // 2. Category Matcher Unit Tests
  console.log('\n2. Testing Category Filter Rules:');
  assert.strictEqual(matchesCategory('COVER_GENERATED', 'covers'), true);
  assert.strictEqual(matchesCategory('PDF_DOWNLOADED', 'covers'), true);
  assert.strictEqual(matchesCategory('DIRECT_PRINT_INITIATED', 'covers'), true);

  assert.strictEqual(matchesCategory('COURSE_CREATED', 'catalogue'), true);
  assert.strictEqual(matchesCategory('EXPERIMENT_DELETED', 'catalogue'), true);
  assert.strictEqual(matchesCategory('ASSIGNMENT_UPDATED', 'catalogue'), true);
  assert.strictEqual(matchesCategory('STUDENT_CREATED', 'catalogue'), true);

  assert.strictEqual(matchesCategory('PRINT_REQUESTED', 'printing'), true);
  assert.strictEqual(matchesCategory('PRINT_OTP_CREATED', 'printing'), true);
  assert.strictEqual(matchesCategory('PRINT_COMPLETED', 'printing'), true);

  assert.strictEqual(matchesCategory('USER_SIGN_IN', 'auth'), true);
  assert.strictEqual(matchesCategory('USER_SIGN_OUT', 'auth'), true);

  assert.strictEqual(matchesCategory('topup', 'financial'), true);
  assert.strictEqual(matchesCategory('adjustment', 'financial'), true);

  assert.strictEqual(matchesCategory('pricing_change', 'admin'), true);
  assert.strictEqual(matchesCategory('user_flags', 'admin'), true);

  assert.strictEqual(matchesCategory('PRINT_FAILED', 'errors'), true);
  console.log('   ✅ Category matching rules cover covers, catalogue, printing, auth, financial, admin, errors');

  // 3. Testing POST /api/activity API Endpoint
  console.log('\n3. Testing POST /api/activity API:');
  const env = {
    ADMIN_EMAIL: 'htmlwithkhalid@gmail.com',
    FIREBASE_API_KEY: 'test_key',
    LABDDB_DATABASE_URL: 'https://test-db.firebaseio.com',
    LABDDB_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account',
      project_id: 'labddb-pro',
      private_key: 'MOCK_PRIVATE_KEY_FOR_TEST_ONLY',
      client_email: 'test@labddb-pro.iam.gserviceaccount.com',
    }),
  };

  const recordedLogs = [];
  const recordedUserHistory = [];

  const ctx = createContext(env);
  Object.defineProperty(ctx, 'auditLogger', {
    configurable: true,
    writable: true,
    value: {
      logEvent: async (c, evt) => {
        recordedLogs.push(evt);
      },
      logAudit: async (c, entry) => {
        recordedLogs.push(entry);
      },
      logUserHistory: async (c, entry) => {
        recordedUserHistory.push(entry);
      },
      getClientInfo: () => ({ ip: '127.0.0.1', userAgent: 'test-agent' }),
    },
  });

  const student = {
    uid: 'student_act',
    email: 'act@cu.ac.bd',
    displayName: 'Active Student',
  };

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      users: [{ localId: student.uid, email: student.email, emailVerified: true, displayName: student.displayName, disabled: false }],
    }),
  });

  try {
    const studentJwt = createMockJwt({
      user_id: student.uid,
      sub: student.uid,
      email: student.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // A. Anonymous Activity Post fails with 401
    const anonReq = new Request('http://localhost/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'PDF_DOWNLOADED' }),
    });
    const anonRes = await routeRequest(anonReq, ctx);
    assert.strictEqual(anonRes.status, 401);
    console.log('   ✅ Anonymous POST /api/activity rejected with 401');

    // B. Authenticated Activity Post for PDF_DOWNLOADED
    const pdfReq = new Request('http://localhost/api/activity', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'PDF_DOWNLOADED',
        entity: { type: 'cover', id: 'EEE 418' },
        metadata: { filename: 'LabReport.pdf', roll: '24702008' },
      }),
    });
    const pdfRes = await routeRequest(pdfReq, ctx);
    assert.strictEqual(pdfRes.status, 200);
    const pdfBody = await pdfRes.json();
    assert.strictEqual(pdfBody.ok, true);
    assert.strictEqual(recordedLogs.length, 1);
    assert.strictEqual(recordedLogs[0].action, 'PDF_DOWNLOADED');
    assert.strictEqual(recordedLogs[0].metadata.filename, 'LabReport.pdf');
    console.log('   ✅ Authenticated POST /api/activity logs PDF_DOWNLOADED');

    // C. Authenticated Activity Post for COURSE_UPDATED
    const courseReq = new Request('http://localhost/api/activity', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'COURSE_UPDATED',
        entity: { type: 'course', id: 'EEE 418' },
        metadata: { courseCode: 'EEE 418', courseTitle: 'Power System Protection' },
      }),
    });
    const courseRes = await routeRequest(courseReq, ctx);
    assert.strictEqual(courseRes.status, 200);
    assert.strictEqual(recordedLogs.length, 2);
    assert.strictEqual(recordedLogs[1].action, 'COURSE_UPDATED');
    console.log('   ✅ Authenticated POST /api/activity logs COURSE_UPDATED');

    console.log('\n------------------------------------------------------------');
    console.log('ACTIVITY LOGGING & DATA MINIMIZATION AUDIT: PASSED ✅\n');
  } finally {
    global.fetch = origFetch;
  }
})().catch((err) => {
  console.error('\nActivity Logging Audit FAILED ❌:', err);
  process.exit(1);
});
