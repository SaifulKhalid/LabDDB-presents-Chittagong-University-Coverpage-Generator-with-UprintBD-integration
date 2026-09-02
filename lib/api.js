/**
 * lib/api.js — Clean API gateway & facade for Workers and Node.js.
 * -----------------------------------------------------------------------------
 * Bridges HTTP Fetch requests to the modular domain and application services:
 *   - Domain entities: lib/domain/
 *   - Infrastructure adapters: lib/infrastructure/
 *   - Application services: lib/services/
 *   - Route handlers: lib/api/handlers/
 */

'use strict';

const { createContext } = require('./api/context.js');
const { corsHeaders, json, errorResponse } = require('./api/response.js');
const { routeRequest } = require('./api/router.js');
const { reconcile, reconcileIfStale } = require('./services/reconcile-service.js');
const { base64ToUint8Array, isPdf } = require('./services/print-service.js');
const { emailKey } = require('./services/auth-service.js');

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

/**
 * Handle an API request. Returns null for non-API paths so static asset
 * middleware can serve them.
 */
async function handleApi(request, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    return null;
  }

  // Alias legacy route paths for seamless backward compatibility
  if (url.pathname === '/api/admin/topup') {
    url.pathname = '/api/admin/users/topup';
    request = new Request(url.toString(), request);
  } else if (url.pathname === '/api/admin/adjust') {
    url.pathname = '/api/admin/users/adjust';
    request = new Request(url.toString(), request);
  } else if (url.pathname === '/api/admin/user-flags') {
    url.pathname = '/api/admin/users/flags';
    request = new Request(url.toString(), request);
  } else if (url.pathname === '/api/admin/job-action') {
    url.pathname = '/api/admin/jobs/action';
    request = new Request(url.toString(), request);
  } else if (url.pathname === '/api/admin/analytics/summary') {
    url.pathname = '/api/admin/analytics-summary';
    request = new Request(url.toString(), request);
  }

  return routeRequest(request, ctx);
}

module.exports = {
  createContext,
  handleApi,
  corsHeaders,
  json,
  errorResponse,
  base64ToUint8Array,
  isPdf,
  emailKey,
  reconcile,
  reconcileIfStale,
  MAX_PDF_BYTES,
};
