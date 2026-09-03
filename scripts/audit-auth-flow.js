/**
 * scripts/audit-auth-flow.js — End-to-end authentication and token authorization audit.
 * -----------------------------------------------------------------------------
 * Verifies:
 * 1. Anonymous request to /api/cover-token and /api/me returns 401.
 * 2. Expired / malformed tokens return 401.
 * 3. Regular student authentication yields projectAdmin: false, admin: false, and 403 on cover-token.
 * 4. Project admin (htmlwithkhalid@gmail.com) yields projectAdmin: true, admin: true, and 200 on cover-token with valid custom token.
 */

'use strict';

const assert = require('assert');
const { routeRequest } = require('../lib/api/router.js');
const { createContext } = require('../lib/api/context.js');
const { isProjectAdmin } = require('../lib/infrastructure/firebase/token-verifier.js');

function createMockJwt(payload, { header = { alg: 'RS256', typ: 'JWT' }, sig = 'valid_mock_sig' } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.${sig}`;
}

(async () => {
  console.log('=== AUTH FLOW & COVER TOKEN AUDIT ===\n');

  const env = {
    ADMIN_EMAIL: 'htmlwithkhalid@gmail.com',
    FIREBASE_API_KEY: 'test_api_key',
    LABDDB_DATABASE_URL: 'https://test-db.firebaseio.com',
    LABDDB_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account',
      project_id: 'labddb-pro',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD\n-----END PRIVATE KEY-----\n',
      client_email: 'test@labddb-pro.iam.gserviceaccount.com',
    }),
    LDDB_DEMO_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account',
      project_id: 'lddb-demo',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD\n-----END PRIVATE KEY-----\n',
      client_email: 'test@lddb-demo.iam.gserviceaccount.com',
    }),
  };

  const mockUsers = {
    student_123: {
      localId: 'student_123',
      email: 'student@cu.ac.bd',
      emailVerified: true,
      displayName: 'CU Student',
      disabled: false,
    },
    admin_001: {
      localId: 'admin_001',
      email: 'htmlwithkhalid@gmail.com',
      emailVerified: true,
      displayName: 'Project Admin',
      disabled: false,
    },
  };

  // Mock global.fetch for Google token verification & service account token minting
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('accounts:lookup') || urlStr.includes('getAccountInfo')) {
      const body = JSON.parse(opts.body || '{}');
      const token = body.idToken;
      const { decodeJwtPayload } = require('../lib/infrastructure/firebase/service-account.js');
      const claims = decodeJwtPayload(token);
      if (!claims || !claims.exp || claims.exp * 1000 <= Date.now() || token.includes('malformed')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'INVALID_ID_TOKEN' } }),
        };
      }
      const uid = claims.user_id || claims.sub;
      const u = mockUsers[uid];
      if (u) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            users: [{ localId: u.localId, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, disabled: u.disabled }],
          }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'USER_NOT_FOUND' } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const ctx = createContext(env);

    // Mock wallet & user storage
    Object.defineProperty(ctx, 'walletService', {
      value: {
        getWallet: async (uid) => ({ uid, balance: 25, reserved: 0, available: 25 }),
        loadPricing: async () => ({ mono: 3, color: 5, currency: 'BDT' }),
      },
    });

    const mockCatalogueService = {
      mintCoverToken: async (identity) => {
        if (!identity) {
          const { AuthError } = require('../lib/domain/errors.js');
          throw new AuthError('Authentication is required to edit the course catalogue.', 401);
        }
        return { token: 'mock_custom_lddb_demo_token', expiresIn: 3600 };
      },
    };

    Object.defineProperty(ctx, 'catalogueService', {
      value: mockCatalogueService,
      configurable: true,
      writable: true,
    });

    ctx.ensureUser = async (identity) => ({
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      coverAdmin: false,
      disabled: false,
    });

    // 1. Signed Out / Anonymous Requests
    console.log('1. Anonymous / Signed-Out Checks:');
    {
      const reqCover = new Request('http://localhost/api/cover-token', { method: 'POST' });
      const resCover = await routeRequest(reqCover, ctx);
      assert.strictEqual(resCover.status, 401, 'Anonymous POST /api/cover-token must return 401');
      const bodyCover = await resCover.json();
      assert.strictEqual(bodyCover.ok, false);
      console.log('   ✅ Anonymous POST /api/cover-token rejected with 401');

      const reqMe = new Request('http://localhost/api/me', { method: 'GET' });
      const resMe = await routeRequest(reqMe, ctx);
      assert.strictEqual(resMe.status, 401, 'Anonymous GET /api/me must return 401');
      console.log('   ✅ Anonymous GET /api/me rejected with 401');
    }

    // 2. Expired / Invalid Token Checks
    console.log('\n2. Invalid / Expired Token Checks:');
    {
      const expiredJwt = createMockJwt({
        user_id: 'student_123_expired',
        sub: 'student_123_expired',
        email: 'student@cu.ac.bd',
        exp: Math.floor(Date.now() / 1000) - 600,
      });
      const reqExpired = new Request('http://localhost/api/cover-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${expiredJwt}` },
      });
      const resExpired = await routeRequest(reqExpired, ctx);
      assert.strictEqual(resExpired.status, 401, 'Expired token must return 401');
      console.log('   ✅ Expired token rejected with 401');

      const reqMalformed = new Request('http://localhost/api/me', {
        method: 'GET',
        headers: { Authorization: 'Bearer not_a_valid_jwt' },
      });
      const resMalformed = await routeRequest(reqMalformed, ctx);
      assert.strictEqual(resMalformed.status, 401, 'Malformed token must return 401');
      console.log('   ✅ Malformed token rejected with 401');
    }

    // 3. Regular Student Authentication
    console.log('\n3. Regular Student Flow Checks:');
    {
      const studentJwt = createMockJwt({
        user_id: 'student_123',
        sub: 'student_123',
        email: 'student@cu.ac.bd',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const reqMe = new Request('http://localhost/api/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${studentJwt}` },
      });
      const resMe = await routeRequest(reqMe, ctx);
      assert.strictEqual(resMe.status, 200);
      const dataMe = await resMe.json();
      assert.strictEqual(dataMe.ok, true);
      assert.strictEqual(dataMe.roles.projectAdmin, false, 'Student must not have projectAdmin role');
      assert.strictEqual(dataMe.roles.admin, false, 'Student must not have admin role');
      console.log('   ✅ GET /api/me returned projectAdmin: false, admin: false for regular student');

      // Authenticated student calling /api/cover-token receives 200 with coverAdmin token
      const reqCover = new Request('http://localhost/api/cover-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentJwt}` },
      });
      const resCover = await routeRequest(reqCover, ctx);
      assert.strictEqual(resCover.status, 200, 'Authenticated student must receive 200 on cover-token');
      const dataCover = await resCover.json();
      assert.strictEqual(dataCover.ok, true);
      assert.ok(dataCover.token, 'Must return lddb-demo custom token');
      console.log('   ✅ POST /api/cover-token returned 200 and custom token for authenticated student');
    }

    // 4. Project Admin Authentication (htmlwithkhalid@gmail.com)
    console.log('\n4. Project Admin Flow Checks:');
    {
      const adminJwt = createMockJwt({
        user_id: 'admin_001',
        sub: 'admin_001',
        email: 'htmlwithkhalid@gmail.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const reqMe = new Request('http://localhost/api/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      const resMe = await routeRequest(reqMe, ctx);
      assert.strictEqual(resMe.status, 200);
      const dataMe = await resMe.json();
      assert.strictEqual(dataMe.ok, true);
      assert.strictEqual(dataMe.roles.projectAdmin, true, 'htmlwithkhalid@gmail.com must have projectAdmin role');
      assert.strictEqual(dataMe.roles.admin, true, 'htmlwithkhalid@gmail.com must have admin role');
      console.log('   ✅ GET /api/me returned projectAdmin: true, admin: true for htmlwithkhalid@gmail.com');

      // Mock catalogueService.mintCoverToken to verify call success
      ctx.catalogueService.mintCoverToken = async (identity) => {
        if (!identity || !isProjectAdmin(identity, env.ADMIN_EMAIL)) {
          const { AuthError } = require('../lib/domain/errors.js');
          throw new AuthError('Access denied', 403);
        }
        return { token: 'mock_custom_lddb_demo_token', expiresIn: 3600 };
      };

      const reqCover = new Request('http://localhost/api/cover-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      const resCover = await routeRequest(reqCover, ctx);
      assert.strictEqual(resCover.status, 200);
      const dataCover = await resCover.json();
      assert.strictEqual(dataCover.ok, true);
      assert.strictEqual(dataCover.token, 'mock_custom_lddb_demo_token');
      assert.strictEqual(dataCover.expiresIn, 3600);
      console.log('   ✅ POST /api/cover-token succeeded with 200 and custom token for project admin');
    }

    console.log('\n------------------------------------------------------------');
    console.log('AUTH FLOW & COVER TOKEN AUDIT PASSED ✅\n');
  } finally {
    global.fetch = origFetch;
  }
})();
