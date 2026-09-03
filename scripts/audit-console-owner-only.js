/**
 * scripts/audit-console-owner-only.js
 * -----------------------------------------------------------------------------
 * Verifies privileged Console owner restriction:
 * 1. Only htmlwithkhalid@gmail.com can access /api/admin/* endpoints.
 * 2. Authenticated students calling /api/admin/* receive HTTP 403 Forbidden.
 * 3. Anonymous visitors calling /api/admin/* receive HTTP 401 Unauthorized.
 * 4. Client-forged role flags or tampered headers are strictly rejected.
 */

'use strict';

const assert = require('assert');
const { routeRequest } = require('../lib/api/router.js');
const { createContext } = require('../lib/api/context.js');

function createMockJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.valid_sig`;
}

(async () => {
  console.log('=== AUDIT: PRIVILEGED CONSOLE OWNER-ONLY RESTRICTION ===\n');

  const OWNER_EMAIL = 'htmlwithkhalid@gmail.com';
  const env = {
    ADMIN_EMAIL: OWNER_EMAIL,
    FIREBASE_API_KEY: 'test_key',
    LABDDB_DATABASE_URL: 'https://test-db.firebaseio.com',
    LABDDB_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account',
      project_id: 'labddb-pro',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD\n-----END PRIVATE KEY-----\n',
      client_email: 'test@labddb-pro.iam.gserviceaccount.com',
    }),
  };

  const student = {
    uid: 'student_attacker',
    email: 'hacker@cu.ac.bd',
    displayName: 'Intruder Student',
  };

  const owner = {
    uid: 'admin_owner',
    email: OWNER_EMAIL,
    displayName: 'Site Administrator',
  };

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    const token = body.idToken;
    const { decodeJwtPayload } = require('../lib/infrastructure/firebase/service-account.js');
    const claims = decodeJwtPayload(token);
    if (!claims || !claims.user_id) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'INVALID_TOKEN' } }) };
    }
    const uid = claims.user_id;
    const user = uid === student.uid ? student : (uid === owner.uid ? owner : null);
    if (user) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          users: [{ localId: user.uid, email: user.email, emailVerified: true, displayName: user.displayName, disabled: false }],
        }),
      };
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: 'NOT_FOUND' } }) };
  };

  try {
    const ctx = createContext(env);

    // Mock admin handlers dependencies
    Object.defineProperty(ctx, 'rtdb', {
      configurable: true, writable: true,
      value: { get: async () => ({}), put: async () => ({}), patch: async () => ({}), set: async () => ({}) },
    });
    Object.defineProperty(ctx, 'walletService', {
      configurable: true, writable: true,
      value: {
        loadPricing: async () => ({ mono: 3, color: 5 }),
        loadLimits: async () => ({ maxPages: 100, maxCopies: 10 }),
      },
    });

    const adminEndpoints = [
      { method: 'GET', path: '/api/admin/overview' },
      { method: 'GET', path: '/api/admin/users' },
      { method: 'GET', path: '/api/admin/jobs' },
      { method: 'GET', path: '/api/admin/ledger' },
      { method: 'POST', path: '/api/admin/pricing' },
      { method: 'POST', path: '/api/admin/reconcile' },
      { method: 'GET', path: '/api/admin/unmatched' },
      { method: 'GET', path: '/api/admin/audit-logs' },
    ];

    // 1. Anonymous Access Checks
    console.log('1. Checking Anonymous Access to Admin Endpoints:');
    for (const ep of adminEndpoints) {
      const req = new Request(`http://localhost${ep.path}`, { method: ep.method });
      const res = await routeRequest(req, ctx);
      assert.strictEqual(res.status, 401, `Anonymous ${ep.path} must return 401`);
    }
    console.log('   ✅ All admin endpoints reject anonymous requests with 401 Unauthorized');

    // 2. Non-Admin Authenticated Student Access Checks
    console.log('\n2. Checking Non-Admin Student Access to Admin Endpoints:');
    const studentJwt = createMockJwt({
      user_id: student.uid,
      sub: student.uid,
      email: student.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    for (const ep of adminEndpoints) {
      const req = new Request(`http://localhost${ep.path}`, {
        method: ep.method,
        headers: { Authorization: `Bearer ${studentJwt}` },
      });
      const res = await routeRequest(req, ctx);
      assert.strictEqual(res.status, 403, `Student access to ${ep.path} must return 403`);
    }
    console.log('   ✅ All admin endpoints reject regular student with 403 Forbidden');

    // 3. Client Forged / Spoofed Claims
    console.log('\n3. Checking Client-Spoofed Claims:');
    const forgedJwt = createMockJwt({
      user_id: student.uid,
      sub: student.uid,
      email: student.email,
      admin: true, // Forged claim in token
      projectAdmin: true,
      roles: { admin: true },
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const forgedReq = new Request('http://localhost/api/admin/overview', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${forgedJwt}`,
        'X-User-Role': 'admin', // Forged header
        'X-Admin-Email': OWNER_EMAIL, // Forged header
      },
    });
    const forgedRes = await routeRequest(forgedReq, ctx);
    assert.strictEqual(forgedRes.status, 403, 'Forged client claims must be rejected with 403');
    console.log('   ✅ Forged client role claims and fake headers strictly rejected with 403');

    // 4. Authorized Project Admin Access
    console.log('\n4. Checking Authorized Project Admin Access:');
    const ownerJwt = createMockJwt({
      user_id: owner.uid,
      sub: owner.uid,
      email: OWNER_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const ownerReq = new Request('http://localhost/api/admin/overview', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    const ownerRes = await routeRequest(ownerReq, ctx);
    assert.strictEqual(ownerRes.status, 200, 'Owner must receive 200 on /api/admin/overview');
    const ownerData = await ownerRes.json();
    assert.strictEqual(ownerData.ok, true);
    console.log(`   ✅ Authorized project admin (${OWNER_EMAIL}) received 200 OK`);

    console.log('\n------------------------------------------------------------');
    console.log('PRIVILEGED CONSOLE OWNER-ONLY AUDIT: PASSED ✅\n');
  } finally {
    global.fetch = origFetch;
  }
})().catch((err) => {
  console.error('\nConsole Owner-Only Audit FAILED ❌:', err);
  process.exit(1);
});
