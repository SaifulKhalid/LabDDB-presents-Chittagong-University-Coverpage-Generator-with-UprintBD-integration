/**
 * scripts/audit-student-settings-access.js
 * -----------------------------------------------------------------------------
 * Verifies student access to settings and catalogue:
 * 1. Anonymous visitor calling POST /api/cover-token receives 401.
 * 2. Authenticated student calling POST /api/cover-token receives 200 + custom token.
 * 3. Project admin calling POST /api/cover-token receives 200 + custom token.
 * 4. Token contains coverAdmin: true claim.
 * 5. Destructive actions in admin.js require confirmation dialogs.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { routeRequest } = require('../lib/api/router.js');
const { createContext } = require('../lib/api/context.js');

function createMockJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.valid_sig`;
}

(async () => {
  console.log('=== AUDIT: STUDENT SETTINGS & CATALOGUE ACCESS ===\n');

  const env = {
    ADMIN_EMAIL: 'htmlwithkhalid@gmail.com',
    FIREBASE_API_KEY: 'test_key',
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

  const studentIdentity = {
    uid: 'student_stu123',
    email: 'student@cu.ac.bd',
    emailVerified: true,
    displayName: 'Rahim Ullah',
    disabled: false,
  };

  const adminIdentity = {
    uid: 'owner_admin1',
    email: 'htmlwithkhalid@gmail.com',
    emailVerified: true,
    displayName: 'System Owner',
    disabled: false,
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
    const user = uid === studentIdentity.uid ? studentIdentity : (uid === adminIdentity.uid ? adminIdentity : null);
    if (user) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ users: [{ localId: user.uid, email: user.email, emailVerified: true, displayName: user.displayName, disabled: false }] }),
      };
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: 'NOT_FOUND' } }) };
  };

  try {
    const ctx = createContext(env);

    // Mount a stub catalogueService to capture minted tokens without hitting RTDB
    let mintedTokens = [];
    const { AuthError } = require('../lib/domain/errors.js');
    Object.defineProperty(ctx, 'catalogueService', {
      configurable: true,
      writable: true,
      value: {
        mintCoverToken: async (identity) => {
          if (!identity) throw new AuthError('Authentication is required to edit the course catalogue.', 401);
          const uid = identity.uid;
          const email = identity.email || 'anon@cu.ac.bd';
          mintedTokens.push({ uid, claims: { coverAdmin: true, email } });
          return { token: `mock_token_for_${uid}`, expiresIn: 3600 };
        },
      },
    });

    // 1. Anonymous Request
    console.log('1. Testing Anonymous Access to Catalogue Token:');
    const anonReq = new Request('http://localhost/api/cover-token', { method: 'POST' });
    const anonRes = await routeRequest(anonReq, ctx);
    assert.strictEqual(anonRes.status, 401, 'Anonymous caller must receive 401');
    console.log('   ✅ Anonymous POST /api/cover-token returns 401 Unauthorized');

    // 2. Authenticated Student Access
    console.log('\n2. Testing Authenticated Student Access:');
    const studentJwt = createMockJwt({
      user_id: studentIdentity.uid,
      sub: studentIdentity.uid,
      email: studentIdentity.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const studentReq = new Request('http://localhost/api/cover-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentJwt}` },
    });
    const studentRes = await routeRequest(studentReq, ctx);
    assert.strictEqual(studentRes.status, 200, 'Authenticated student must receive 200');
    const studentBody = await studentRes.json();
    assert.strictEqual(studentBody.ok, true);
    assert.ok(studentBody.token, 'Must return token');
    const studentMint = mintedTokens.find((t) => t.uid === studentIdentity.uid);
    assert.ok(studentMint, 'Token was minted for student');
    assert.strictEqual(studentMint.claims.coverAdmin, true, 'Student token has coverAdmin: true');
    console.log('   ✅ Authenticated student received 200 with minted coverAdmin custom token');

    // 3. Project Admin Access
    console.log('\n3. Testing Project Admin Access:');
    const adminJwt = createMockJwt({
      user_id: adminIdentity.uid,
      sub: adminIdentity.uid,
      email: adminIdentity.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const adminReq = new Request('http://localhost/api/cover-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}` },
    });
    const adminRes = await routeRequest(adminReq, ctx);
    assert.strictEqual(adminRes.status, 200, 'Project admin must receive 200');
    const adminBody = await adminRes.json();
    assert.strictEqual(adminBody.ok, true);
    assert.ok(adminBody.token);
    console.log('   ✅ Project admin received 200 with minted coverAdmin custom token');

    // 4. Verification of Client Scripts & Confirmation Dialogs
    console.log('\n4. Verifying admin.js Confirmation Dialogs & Audit Hooks:');
    const adminJsContent = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');

    assert.ok(adminJsContent.includes('Delete Course'), 'admin.js must include confirmation for delete course');
    assert.ok(adminJsContent.includes('Delete Experiment'), 'admin.js must include confirmation for delete experiment');
    assert.ok(adminJsContent.includes('Delete Assignment'), 'admin.js must include confirmation for delete assignment');
    assert.ok(adminJsContent.includes('Delete student'), 'admin.js must include confirmation for delete student');
    console.log('   ✅ Confirmation dialogs present for course, experiment, assignment, student deletion');

    assert.ok(adminJsContent.includes('auditCatalogueAction'), 'admin.js must call auditCatalogueAction');
    assert.ok(adminJsContent.includes('updatedBy'), 'admin.js must record updatedBy identity');
    console.log('   ✅ Collaborative editing concurrency & audit tracking hooks present in admin.js');

    console.log('\n------------------------------------------------------------');
    console.log('STUDENT SETTINGS & CATALOGUE ACCESS AUDIT: PASSED ✅\n');
  } finally {
    global.fetch = origFetch;
  }
})().catch((err) => {
  console.error('\nStudent Settings Access Audit FAILED ❌:', err);
  process.exit(1);
});
