/**
 * lib/audit-logger.js — Facade for audit service.
 * -----------------------------------------------------------------------------
 * Clean re-export of audit and document tracking service for backward compatibility.
 */

'use strict';

const auditService = require('./services/audit-service.js');

module.exports = {
  ...auditService,
};
