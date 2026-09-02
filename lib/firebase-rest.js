/**
 * lib/firebase-rest.js — Dependency-free Firebase admin access for Workers and Node.
 * -----------------------------------------------------------------------------
 * Clean re-export of modular infrastructure components for backward compatibility.
 */

'use strict';

const {
  ServiceAccount,
  decodeJwtPayload,
  b64urlFromBytes,
  b64urlFromString,
  bytesFromB64,
} = require('./infrastructure/firebase/service-account.js');

const {
  Rtdb,
  ConflictError,
} = require('./infrastructure/firebase/rtdb-client.js');

module.exports = {
  ServiceAccount,
  Rtdb,
  ConflictError,
  decodeJwtPayload,
  b64urlFromBytes,
  b64urlFromString,
  bytesFromB64,
};
