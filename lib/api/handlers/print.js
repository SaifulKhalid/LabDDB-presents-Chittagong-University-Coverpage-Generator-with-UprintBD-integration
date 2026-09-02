/**
 * lib/api/handlers/print.js — Print request, job history, and cancellation handlers.
 * -----------------------------------------------------------------------------
 */

'use strict';

const { json } = require('../response.js');
const { reconcileIfStale } = require('../../services/reconcile-service.js');
const { ValidationError } = require('../../domain/errors.js');

async function handlePrint(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  const user = await ctx.ensureUser(identity, request);

  const body = await request.json().catch(() => null);
  if (!body) {
    throw new ValidationError('No document data was received in the request body.', 400);
  }

  // Safety net: trigger lazy reconciliation if last run is stale (>3min)
  await reconcileIfStale(ctx);

  const result = await ctx.printService.requestPrint(ctx, identity, user, body, request);
  return json(result);
}

async function handleJobs(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  const rawJobs = await ctx.walletService.getRecentJobs(identity.uid, 25);

  const jobs = rawJobs.map((j) => ({
    id: j.id,
    status: j.status,
    otp: j.status === 'reserved' ? j.otp : null, // INVARIANT INV-12: OTP visible only if reserved
    price: j.price,
    pages: j.pages,
    copies: j.copies,
    color: !!j.color,
    title: j.title || '',
    courseCode: j.courseCode || '',
    filename: j.filename,
    createdAt: j.createdAt,
    expiresAt: j.expiresAt || null,
    settledAt: j.settledAt || null,
    actualCost: j.actualCost ?? null,
  }));

  return json({ ok: true, jobs });
}

async function handleCancel(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  const body = await request.json().catch(() => ({}));
  const jobId = body && body.jobId ? String(body.jobId).trim() : null;

  if (!jobId) {
    throw new ValidationError('Job ID is required for cancellation.', 400);
  }

  const result = await ctx.printService.cancelPrint(ctx, identity, jobId);
  return json(result);
}

module.exports = {
  handlePrint,
  handleJobs,
  handleCancel,
};
