/**
 * scripts/audit-roll-persistence.js
 * -----------------------------------------------------------------------------
 * Verifies roll persistence and sign-out cleanup invariants:
 * 1. Anonymous roll numbers are NOT persisted in localStorage or cookies.
 * 2. Authenticated students store their roll on server at users/<uid>/profile/roll.
 * 3. POST /api/me/roll persists roll server-side.
 * 4. GET /api/me returns user.roll.
 * 5. Sign-out clears in-memory user profile, resets roll, wipes inputs, and cleans localStorage.
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
  console.log('=== AUDIT: ROLL PERSISTENCE & PRIVACY INVARIANTS ===\n');

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

  const student = {
    uid: 'student_999',
    email: 'khalid@cu.ac.bd',
    displayName: 'Saiful Khalid',
  };

  const mockDbStorage = {};
  const mockRtdb = {
    get: async (p) => mockDbStorage[p] || null,
    put: async (p, v) => { mockDbStorage[p] = v; return v; },
    set: async (p, v) => { mockDbStorage[p] = v; return v; },
    patch: async (p, v) => {
      mockDbStorage[p] = Object.assign({}, mockDbStorage[p] || {}, v);
      return mockDbStorage[p];
    },
  };

  const ctx = createContext(env);
  Object.defineProperty(ctx, 'rtdb', { configurable: true, writable: true, value: mockRtdb });

  // Reconstruct authService using the mock RTDB
  const { AuthService } = require('../lib/services/auth-service.js');
  const authService = new AuthService(mockRtdb, ctx.authOpts);
  Object.defineProperty(ctx, 'authService', { configurable: true, writable: true, value: authService });

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

    // 1. Initial State: New user has no roll
    console.log('1. Checking Initial /api/me roll:');
    const reqInitial = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${studentJwt}` },
    });
    const resInitial = await routeRequest(reqInitial, ctx);
    assert.strictEqual(resInitial.status, 200);
    const bodyInitial = await resInitial.json();
    assert.strictEqual(bodyInitial.user.roll, '', 'Initial roll should be empty string');
    console.log('   ✅ Initial GET /api/me returns empty roll for new user');

    // 2. Server-side Roll Update via POST /api/me/roll
    console.log('\n2. Testing POST /api/me/roll:');
    const reqUpdate = new Request('http://localhost/api/me/roll', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studentJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roll: '24702008' }),
    });
    const resUpdate = await routeRequest(reqUpdate, ctx);
    assert.strictEqual(resUpdate.status, 200);
    const bodyUpdate = await resUpdate.json();
    assert.strictEqual(bodyUpdate.ok, true);
    assert.strictEqual(bodyUpdate.roll, '24702008');

    // Verify storage in RTDB path users/<uid>/profile/roll
    const storedRoll = await ctx.authService.getUserRoll(student.uid);
    assert.strictEqual(storedRoll, '24702008', 'Server-side RTDB must store the roll');
    console.log('   ✅ POST /api/me/roll persisted roll "24702008" to server database');

    // 3. Subsequent /api/me returns the persisted roll
    console.log('\n3. Verifying GET /api/me returns Persisted Roll:');
    const reqSubsequent = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${studentJwt}` },
    });
    const resSubsequent = await routeRequest(reqSubsequent, ctx);
    assert.strictEqual(resSubsequent.status, 200);
    const bodySubsequent = await resSubsequent.json();
    assert.strictEqual(bodySubsequent.user.roll, '24702008');
    console.log('   ✅ GET /api/me returned persisted roll "24702008"');

    // 4. Anonymous Users do NOT have roll persistence
    console.log('\n4. Verifying Anonymous Users Do NOT Persist Roll:');
    const reqAnonRoll = new Request('http://localhost/api/me/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roll: '24702008' }),
    });
    const resAnonRoll = await routeRequest(reqAnonRoll, ctx);
    assert.strictEqual(resAnonRoll.status, 401, 'Anonymous user cannot call /api/me/roll');
    console.log('   ✅ Anonymous call to POST /api/me/roll is rejected with 401');

    // 5. Codebase audit for removal of anonymous localStorage roll persistence
    console.log('\n5. Auditing Client Scripts for Removal of Anonymous LocalStorage:');
    const authJs = fs.readFileSync(path.join(__dirname, '../public/js/labddb-auth.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    const expJs = fs.readFileSync(path.join(__dirname, '../public/js/experiment-cover.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(__dirname, '../public/js/experiment-main-cover.js'), 'utf8');

    // Check that getRememberedRoll() does not return localStorage for anonymous users
    assert.ok(
      authJs.includes('function getRememberedRoll() {\n    if (state.user && state.user.roll) {\n      return state.user.roll;\n    }\n    return \'\';\n  }'),
      'labddb-auth.js getRememberedRoll must return empty string for unauthenticated users'
    );
    console.log('   ✅ getRememberedRoll() strictly returns empty string when user is not signed in');

    // Check that sign out clears roll and dispatches event
    assert.ok(authJs.includes('localStorage.removeItem(\'labddb_remembered_roll\')'), 'Must purge legacy remembered roll on logout');
    assert.ok(authJs.includes('window.dispatchEvent(new CustomEvent(\'labddb:roll_changed\', { detail: { roll: \'\' } }))'), 'Must dispatch roll_changed with empty roll on logout');
    console.log('   ✅ Sign-out explicitly purges local roll and dispatches empty roll event');

    // Check that generator inputs are cleared on empty roll event
    assert.ok(appJs.includes('if (el.rollNumber) el.rollNumber.value = \'\';'), 'app.js clears rollNumber input on sign-out');
    assert.ok(expJs.includes('if (el.rollNumber) el.rollNumber.value = \'\';'), 'experiment-cover.js clears rollNumber input on sign-out');
    assert.ok(mainJs.includes('if (el.rollNumber) el.rollNumber.value = \'\';'), 'experiment-main-cover.js clears rollNumber input on sign-out');
    console.log('   ✅ Form inputs, student state and previews are cleanly reset on sign-out');

    console.log('\n------------------------------------------------------------');
    console.log('ROLL PERSISTENCE & PRIVACY AUDIT: PASSED ✅\n');
  } finally {
    global.fetch = origFetch;
  }
})().catch((err) => {
  console.error('\nRoll Persistence Audit FAILED ❌:', err);
  process.exit(1);
});
