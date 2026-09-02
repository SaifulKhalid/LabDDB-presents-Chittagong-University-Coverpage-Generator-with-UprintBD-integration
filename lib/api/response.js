/**
 * lib/api/response.js — HTTP Response helpers, CORS handling & error formatting.
 * -----------------------------------------------------------------------------
 * Ensures uniform JSON envelopes across Cloudflare Workers and Node.js.
 */

'use strict';

const { DomainError } = require('../domain/errors.js');

function corsHeaders(env, request) {
  const allowed = (env && env.ALLOWED_ORIGIN) || '*';
  const origin = request && request.headers ? request.headers.get('origin') : null;
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? origin || '*' : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      extraHeaders
    ),
  });
}

function errorResponse(err, env, request) {
  const status = err.status || 500;
  const body = {
    ok: false,
    error: err.message || 'An unexpected error occurred.',
  };

  if (err.code) body.code = err.code;
  if (err.required != null) body.required = err.required;
  if (err.available != null) body.available = err.available;
  if (err.balance != null) body.balance = err.balance;
  if (err.reserved != null) body.reserved = err.reserved;
  if (err.jobId) body.jobId = err.jobId;
  if (err.detail) body.detail = err.detail;

  if (status >= 500 && !(err instanceof DomainError)) {
    console.error('[server error]', err.stack || err);
    body.error = 'Internal server error. Please try again later.';
  }

  return json(body, status, corsHeaders(env, request));
}

module.exports = {
  corsHeaders,
  json,
  errorResponse,
};
