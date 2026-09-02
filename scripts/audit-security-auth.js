/**
 * scripts/audit-security-auth.js — Adversarial Security, Authentication & Authorization Audit.
 * -----------------------------------------------------------------------------
 * Tests token verifier edge cases, disabled account handling, and RBAC gatekeeping.
 */

'use strict';

const assert = require('assert');
const { verifyIdToken, requireUser, requireProjectAdmin, isProjectAdmin } = require('../lib/infrastructure/firebase/token-verifier.js');
const { AuthError } = require('../lib/domain/errors.js');
const { routeRequest } = require('../lib/api/router.js');
const { createContext } = require('../lib/api/context.js');

// Helper to craft a mock JWT with specified header, payload, signature
function createMockJwt(payload, { header = { alg: 'RS256', typ: 'JWT' }, sig = 'mock_signature' } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.${sig}`;
}

(async () => {
  console.log('=== ADVERSARIAL SECURITY, AUTH & RBAC AUDIT ===\n');

  // -------------------------------------------------------------------------
  // 1. Authentication Tests (token verifier)
  // -------------------------------------------------------------------------
  console.log('1. Testing Token Verification Edge Cases:');

  // A. Missing token
  {
    let err = null;
    try {
      await requireUser(new Request('http://localhost/api/me'), {});
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AuthError, 'Missing token must throw AuthError');
    assert.strictEqual(err.status, 401);
    console.log('   ✅ Missing token rejected with 401');
  }

  // B. Malformed token (garbage string)
  {
    let err = null;
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: 'Bearer this_is_garbage_not_a_jwt' },
    });
    try {
      await requireUser(req, { apiKey: 'mock_key' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AuthError, 'Malformed token must throw AuthError');
    assert.strictEqual(err.status, 401);
    console.log('   ✅ Malformed token rejected with 401');
  }

  // C. Expired token (exp in past)
  {
    const expiredPayload = {
      user_id: 'user_123',
      sub: 'user_123',
      email: 'student@cu.ac.bd',
      exp: Math.floor(Date.now() / 1000) - 300, // Expired 5 minutes ago
    };
    const expiredJwt = createMockJwt(expiredPayload);
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });

    let err = null;
    try {
      await requireUser(req, { apiKey: 'mock_key' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AuthError, 'Expired token must throw AuthError');
    assert.strictEqual(err.status, 401);
    console.log('   ✅ Expired token rejected with 401');
  }

  // D. Disabled user
  {
    // Mock fetch to simulate Identity Toolkit returning a disabled account
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('accounts:lookup')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            users: [
              {
                localId: 'user_banned',
                email: 'banned@cu.ac.bd',
                emailVerified: true,
                disabled: true, // Account banned
              },
            ],
          }),
        };
      }
      return origFetch(url);
    };

    try {
      const validPayload = {
        user_id: 'user_banned',
        sub: 'user_banned',
        email: 'banned@cu.ac.bd',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const jwt = createMockJwt(validPayload);
      const req = new Request('http://localhost/api/me', {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      let err = null;
      try {
        await requireUser(req, { apiKey: 'mock_key' });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof AuthError, 'Disabled account must throw AuthError');
      assert.strictEqual(err.status, 403, 'Disabled account must be 403 Forbidden');
      console.log('   ✅ Disabled account rejected with 403');
    } finally {
      global.fetch = origFetch;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Authorization & RBAC Gatekeeping Tests
  // -------------------------------------------------------------------------
  console.log('\n2. Testing RBAC Gatekeeping on Admin Endpoints:');

  // Mock verified student and admin identities
  const studentIdentity = {
    uid: 'student_001',
    email: 'regular_student@cu.ac.bd',
    displayName: 'Regular Student',
    disabled: false,
  };

  const adminIdentity = {
    uid: 'admin_001',
    email: 'htmlwithkhalid@gmail.com',
    emailVerified: true,
    displayName: 'Project Admin',
    disabled: false,
  };

  const unverifiedAdminIdentity = {
    uid: 'admin_fake',
    email: 'htmlwithkhalid@gmail.com',
    emailVerified: false, // Email unverified!
    displayName: 'Fake Admin',
    disabled: false,
  };

  // Check isProjectAdmin logic
  assert.strictEqual(isProjectAdmin(studentIdentity, 'htmlwithkhalid@gmail.com'), false);
  assert.strictEqual(isProjectAdmin(adminIdentity, 'htmlwithkhalid@gmail.com'), true);
  assert.strictEqual(isProjectAdmin(adminIdentity, 'HTMLWITHKHALID@GMAIL.COM'), true, 'Case insensitive');
  assert.strictEqual(isProjectAdmin(unverifiedAdminIdentity, 'htmlwithkhalid@gmail.com'), false, 'Unverified email must be rejected');
  assert.strictEqual(isProjectAdmin(null, 'htmlwithkhalid@gmail.com'), false);
  console.log('   ✅ isProjectAdmin email matching and emailVerified security checks verified.');

  // Test requireProjectAdmin
  {
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        users: [{ localId: studentIdentity.uid, email: studentIdentity.email, disabled: false }],
      }),
    });

    try {
      const studentJwt = createMockJwt({
        user_id: studentIdentity.uid,
        sub: studentIdentity.uid,
        email: studentIdentity.email,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      // Regular student trying to access admin endpoint
      const req = new Request('http://localhost/api/admin/overview', {
        headers: { Authorization: `Bearer ${studentJwt}` },
      });

      let err = null;
      try {
        await requireProjectAdmin(req, { apiKey: 'key', adminEmail: 'htmlwithkhalid@gmail.com' });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof AuthError);
      assert.strictEqual(err.status, 403, 'Regular student must be 403 on admin routes');
      console.log('   ✅ Regular student calling admin route rejected with 403 Forbidden');
    } finally {
      global.fetch = origFetch;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Cross-Tenant Isolation: Student A cancelling Student B's job
  // -------------------------------------------------------------------------
  console.log('\n3. Testing Cross-Tenant Job Cancellation Isolation:');
  {
    const { PrintService } = require('../lib/services/print-service.js');
    const mockRtdb = {
      get: async (path) => {
        // Path queried will be `jobs/${identity.uid}/${jobId}`
        // Student A has uid 'student_A', trying to cancel 'job_B'
        if (path === 'jobs/student_A/job_B') return null; // Doesn't exist in Student A's tree
        if (path === 'jobs/student_B/job_B') return { id: 'job_B', uid: 'student_B', status: 'reserved' };
        return null;
      },
    };

    const printService = new PrintService({ rtdb: mockRtdb, walletService: {}, printProvider: {} });
    let err = null;
    try {
      await printService.cancelPrint({}, { uid: 'student_A' }, 'job_B');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'Must throw error');
    assert.strictEqual(err.status, 404, 'Student A cannot see or cancel Student B job (404)');
    console.log('   ✅ Cross-tenant job cancellation rejected with 404 (isolation enforced).');
  }

  console.log('\n------------------------------------------------------------');
  console.log('ALL SECURITY, AUTHENTICATION & RBAC TESTS PASSED ✅\n');
})().catch((err) => {
  console.error('\nSecurity Audit FAILED ❌:', err);
  process.exit(1);
});
