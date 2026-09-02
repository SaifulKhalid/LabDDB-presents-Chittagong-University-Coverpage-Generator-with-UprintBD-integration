/**
 * lib/services/catalogue-service.js — Catalogue administration & custom token service.
 * -----------------------------------------------------------------------------
 * Manages scoped token minting for the separate lddb-demo project (courses/students).
 * Hardens security by requiring authentication and authorization (fixing Discrepancy #1).
 */

'use strict';

const { AuthError } = require('../domain/errors.js');

class CatalogueService {
  /**
   * @param {object} coverServiceAccount Service account for lddb-demo
   * @param {object} rtdb LabDDB-Pro RTDB instance for role lookup
   * @param {object} authService AuthService instance
   * @param {boolean} allowPublic Whether public catalogue editing is enabled
   */
  constructor(coverServiceAccount, rtdb, authService, allowPublic = false) {
    this.coverSa = coverServiceAccount;
    this.rtdb = rtdb;
    this.authService = authService;
    this.allowPublic = allowPublic;
  }

  /**
   * Mint a scoped write token for lddb-demo with role validation.
   */
  async mintCoverToken(identity = null) {
    if (!this.coverSa) {
      throw new Error('Cover service account is not configured on the server.');
    }

    let uid = 'public_admin';
    let email = 'admin@cu.ac.bd';

    if (identity && identity.uid) {
      uid = identity.uid;
      email = identity.email || email;

      const isProjAdmin = this.authService ? this.authService.isProjectAdmin(identity) : false;
      const role = (await this.rtdb.get(`roles/${uid}/coverAdmin`)) === true;

      if (!isProjAdmin && !role && !this.allowPublic) {
        throw new AuthError('You do not have permission to edit the course catalogue.', 403);
      }
    } else {
      if (!this.allowPublic) {
        throw new AuthError('Authentication is required to edit the course catalogue.', 401);
      }
    }

    const token = await this.coverSa.createCustomToken(uid, {
      coverAdmin: true,
      email,
    });

    return {
      token,
      expiresIn: 3600,
    };
  }
}

module.exports = {
  CatalogueService,
};
