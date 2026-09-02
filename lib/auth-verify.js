/**
 * lib/auth-verify.js — Firebase ID token verification for Workers and Node.
 * -----------------------------------------------------------------------------
 * Clean re-export of modular authentication components for backward compatibility.
 */

'use strict';

const { AuthError } = require('./domain/errors.js');
const {
  bearerToken,
  verifyIdToken,
  isProjectAdmin,
  requireUser,
  requireProjectAdmin,
} = require('./infrastructure/firebase/token-verifier.js');

module.exports = {
  AuthError,
  bearerToken,
  verifyIdToken,
  isProjectAdmin,
  requireUser,
  requireProjectAdmin,
};
