/**
 * lib/services/auth-service.js — User identity & authorization application service.
 * -----------------------------------------------------------------------------
 * Verifies ID tokens via Google Identity Toolkit, enforces role policies,
 * and maintains user records in Firebase RTDB.
 */

'use strict';

const {
  bearerToken,
  verifyIdToken,
  isProjectAdmin,
  requireUser,
  requireProjectAdmin,
} = require('../infrastructure/firebase/token-verifier.js');
const { AuthError } = require('../domain/errors.js');

function emailKey(email) {
  return String(email || '').toLowerCase().replace(/[.$#[\]/@]/g, '_');
}

class AuthService {
  constructor(rtdb, authOpts = {}) {
    this.rtdb = rtdb;
    this.authOpts = authOpts;
  }

  async verifyRequest(request) {
    return requireUser(request, this.authOpts);
  }

  async verifyAdminRequest(request) {
    return requireProjectAdmin(request, this.authOpts);
  }

  isProjectAdmin(identity) {
    return isProjectAdmin(identity, this.authOpts.adminEmail);
  }

  /**
   * Upsert user profile in RTDB, initialize first-time zero wallet,
   * and index verified email for admin search.
   */
  async ensureUser(identity, request = null) {
    if (!identity || !identity.uid) {
      throw new AuthError('Invalid user identity.');
    }

    const uid = identity.uid;
    const now = Date.now();
    const userPath = `users/${uid}`;

    let user = await this.rtdb.get(userPath);
    if (!user) {
      user = {
        uid,
        email: identity.email || '',
        displayName: identity.displayName || '',
        photoURL: identity.photoURL || '',
        createdAt: now,
        lastSeenAt: now,
        provider: identity.provider || 'google.com',
      };
      await this.rtdb.put(userPath, user);
    } else {
      await this.rtdb.patch(userPath, {
        displayName: identity.displayName || user.displayName || '',
        photoURL: identity.photoURL || user.photoURL || '',
        lastSeenAt: now,
      });
    }

    // Ensure wallet exists; initialize with 0 if absent
    const walletPath = `wallets/${uid}`;
    const existingWallet = await this.rtdb.get(walletPath);
    if (!existingWallet) {
      await this.rtdb.put(walletPath, {
        balance: 0,
        reserved: 0,
        applied: {},
        updatedAt: now,
      });
    }

    // Index email for admin search
    if (identity.email) {
      const eKey = emailKey(identity.email);
      await this.rtdb.put(`adminIndex/byEmail/${eKey}`, { uid, email: identity.email });
    }

    // Check role flags
    const roles = (await this.rtdb.get(`roles/${uid}`)) || {};
    return {
      ...user,
      disabled: !!roles.disabled,
      coverAdmin: !!roles.coverAdmin,
    };
  }
}

module.exports = {
  AuthService,
  bearerToken,
  verifyIdToken,
  isProjectAdmin,
  requireUser,
  requireProjectAdmin,
  emailKey,
};
