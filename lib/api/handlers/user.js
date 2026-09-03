/**
 * lib/api/handlers/user.js — Student profile and catalogue token route handlers.
 * -----------------------------------------------------------------------------
 */

'use strict';

const { json } = require('../response.js');
const { DEFAULT_PRICING } = require('../../domain/pricing.js');

async function handleMe(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  const user = await ctx.ensureUser(identity, request);
  const wallet = await ctx.walletService.getWallet(identity.uid);

  let pricing = { ...DEFAULT_PRICING };
  try {
    pricing = await ctx.walletService.loadPricing();
  } catch (_) {}

  return json({
    ok: true,
    user: {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      roll: user.roll || '',
    },
    wallet,
    roles: {
      admin: ctx.authService.isProjectAdmin(identity),
      projectAdmin: ctx.authService.isProjectAdmin(identity),
      coverAdmin: true, // Every authenticated student is an authorized catalogue editor
      disabled: !!user.disabled,
    },
    pricing,
  });
}

async function handleUpdateRoll(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  let body = {};
  try {
    body = await request.json();
  } catch (_) {}

  const roll = await ctx.authService.updateUserRoll(identity.uid, body.roll);
  return json({
    ok: true,
    roll,
  });
}

async function handleCoverToken(request, ctx) {
  let identity = null;
  try {
    identity = await ctx.authService.verifyRequest(request);
  } catch (_) {}

  const result = await ctx.catalogueService.mintCoverToken(identity);
  return json({
    ok: true,
    token: result.token,
    expiresIn: result.expiresIn,
  });
}

module.exports = {
  handleMe,
  handleUpdateRoll,
  handleCoverToken,
};
