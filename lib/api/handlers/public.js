/**
 * lib/api/handlers/public.js — Public anonymous API route handlers.
 * -----------------------------------------------------------------------------
 * Free & open routes for health checking and client configuration.
 */

'use strict';

const { json } = require('../response.js');
const { DEFAULT_PRICING, DEFAULT_LIMITS } = require('../../domain/pricing.js');

async function handleHealth(request, ctx) {
  return json({
    ok: true,
    service: 'LabDDB UprintBD Bridge',
    configured: ctx.missing.length === 0,
    missing: ctx.missing,
  });
}

async function handleConfig(request, ctx) {
  let pricing = { ...DEFAULT_PRICING };
  let limits = { ...DEFAULT_LIMITS };

  if (!ctx.missing.includes('LABDDB_DATABASE_URL') && !ctx.missing.includes('LABDDB_SERVICE_ACCOUNT')) {
    try {
      pricing = await ctx.walletService.loadPricing();
      limits = await ctx.walletService.loadLimits();
    } catch (_) {}
  }

  return json({
    ok: true,
    pricing,
    limits,
  });
}

module.exports = {
  handleHealth,
  handleConfig,
};
