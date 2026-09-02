/**
 * lib/reconcile.js — Facade for reconcile service.
 * -----------------------------------------------------------------------------
 * Clean re-export of reconciliation engine for backward compatibility.
 */

'use strict';

const reconcileService = require('./services/reconcile-service.js');

module.exports = {
  ...reconcileService,
};
