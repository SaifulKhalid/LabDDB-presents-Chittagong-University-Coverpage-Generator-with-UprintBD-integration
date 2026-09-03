/**
 * lib/api/router.js — Centralized HTTP Request Router & Error Boundary.
 * -----------------------------------------------------------------------------
 * Maps HTTP requests to clean route handlers with CORS pre-flight support
 * and typed error serialization.
 */

'use strict';

const { corsHeaders, json, errorResponse } = require('./response.js');
const { handleHealth, handleConfig } = require('./handlers/public.js');
const { handleMe, handleUpdateRoll, handleCoverToken } = require('./handlers/user.js');
const { handleActivity } = require('./handlers/activity.js');
const { handlePrint, handleJobs, handleCancel } = require('./handlers/print.js');
const {
  handleAdminOverview,
  handleAdminUsers,
  handleAdminTopUp,
  handleAdminAdjust,
  handleAdminUserFlags,
  handleAdminJobs,
  handleAdminJobAction,
  handleAdminLedger,
  handleAdminPricing,
  handleAdminReconcile,
  handleAdminUnmatched,
  handleAdminAuditLogs,
  handleAdminAnalyticsSummary,
  handleAdminUserHistory,
  handleAdminUprint,
} = require('./handlers/admin.js');

async function routeRequest(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // CORS Pre-flight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(ctx.env, request),
    });
  }

  try {
    let res;

    // Public routes
    if (path === '/api/health' && method === 'GET') {
      res = await handleHealth(request, ctx);
    } else if (path === '/api/config' && method === 'GET') {
      res = await handleConfig(request, ctx);
    }

    // Student profile & catalogue
    else if (path === '/api/me' && method === 'GET') {
      res = await handleMe(request, ctx);
    } else if (path === '/api/me/roll' && method === 'POST') {
      res = await handleUpdateRoll(request, ctx);
    } else if (path === '/api/cover-token' && method === 'POST') {
      res = await handleCoverToken(request, ctx);
    } else if (path === '/api/activity' && method === 'POST') {
      res = await handleActivity(request, ctx);
    }

    // Print actions
    else if (path === '/api/print' && method === 'POST') {
      res = await handlePrint(request, ctx);
    } else if (path === '/api/jobs' && method === 'GET') {
      res = await handleJobs(request, ctx);
    } else if (path === '/api/cancel' && method === 'POST') {
      res = await handleCancel(request, ctx);
    }

    // Admin endpoints
    else if (path === '/api/admin/overview' && method === 'GET') {
      res = await handleAdminOverview(request, ctx);
    } else if (path === '/api/admin/users' && method === 'GET') {
      res = await handleAdminUsers(request, ctx);
    } else if (path === '/api/admin/users/topup' && method === 'POST') {
      res = await handleAdminTopUp(request, ctx);
    } else if (path === '/api/admin/users/adjust' && method === 'POST') {
      res = await handleAdminAdjust(request, ctx);
    } else if (path === '/api/admin/users/flags' && method === 'POST') {
      res = await handleAdminUserFlags(request, ctx);
    } else if (path === '/api/admin/jobs' && method === 'GET') {
      res = await handleAdminJobs(request, ctx);
    } else if (path === '/api/admin/jobs/action' && method === 'POST') {
      res = await handleAdminJobAction(request, ctx);
    } else if (path === '/api/admin/ledger' && method === 'GET') {
      res = await handleAdminLedger(request, ctx);
    } else if (path === '/api/admin/pricing' && method === 'POST') {
      res = await handleAdminPricing(request, ctx);
    } else if (path === '/api/admin/reconcile' && method === 'POST') {
      res = await handleAdminReconcile(request, ctx);
    } else if (path === '/api/admin/unmatched' && (method === 'GET' || method === 'POST')) {
      res = await handleAdminUnmatched(request, ctx);
    } else if (path === '/api/admin/uprint' && method === 'GET') {
      res = await handleAdminUprint(request, ctx);
    } else if (path === '/api/admin/audit-logs' && method === 'GET') {
      res = await handleAdminAuditLogs(request, ctx);
    } else if (path === '/api/admin/analytics-summary' && method === 'GET') {
      res = await handleAdminAnalyticsSummary(request, ctx);
    } else if (path === '/api/admin/user-history' && method === 'GET') {
      res = await handleAdminUserHistory(request, ctx);
    } else {
      res = json({ ok: false, error: 'Not found' }, 404);
    }

    // Attach CORS headers
    const cors = corsHeaders(ctx.env, request);
    for (const [k, v] of Object.entries(cors)) {
      if (!res.headers.has(k)) res.headers.set(k, v);
    }
    return res;
  } catch (err) {
    return errorResponse(err, ctx.env, request);
  }
}

module.exports = {
  routeRequest,
};
