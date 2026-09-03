/**
 * lib/api/handlers/activity.js — Authenticated client activity logging.
 * -----------------------------------------------------------------------------
 * Records user actions (cover downloads, catalogue edits, auth transitions).
 * Strictly requires verified authentication.
 */

'use strict';

const { json } = require('../response.js');
const { getClientInfo } = require('../../services/audit-service.js');
const { ValidationError } = require('../../domain/errors.js');

const ALLOWED_ACTIONS = new Set([
  'USER_SIGN_IN',
  'USER_SIGN_OUT',
  'COVER_GENERATED',
  'PDF_DOWNLOADED',
  'DIRECT_PRINT_INITIATED',
  'COURSE_CREATED',
  'COURSE_UPDATED',
  'COURSE_DELETED',
  'EXPERIMENT_CREATED',
  'EXPERIMENT_UPDATED',
  'EXPERIMENT_DELETED',
  'ASSIGNMENT_CREATED',
  'ASSIGNMENT_UPDATED',
  'ASSIGNMENT_DELETED',
  'STUDENT_CREATED',
  'STUDENT_UPDATED',
  'STUDENT_DELETED',
  'TEACHER_UPDATED',
  'FACULTY_UPDATED',
  'DEPARTMENT_UPDATED',
  'PRINT_REQUESTED',
  'PRINT_OTP_CREATED',
  'PRINT_FAILED',
  'PRINT_CANCELLED',
  'PRINT_EXPIRED',
  'PRINT_COMPLETED',
]);

async function handleActivity(request, ctx) {
  const identity = await ctx.authService.verifyRequest(request);
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    throw new ValidationError('Invalid JSON body.', 400);
  }

  const rawAction = String(body.action || '').trim().toUpperCase();
  if (!ALLOWED_ACTIONS.has(rawAction)) {
    throw new ValidationError(`Unsupported activity action: ${rawAction}`, 400);
  }

  const clientInfo = getClientInfo(request);

  try {
    await ctx.auditLogger.logEvent(ctx, {
      action: rawAction,
      actor: identity,
      entity: body.entity && typeof body.entity === 'object' ? body.entity : null,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
      ...clientInfo,
    });
  } catch (err) {
    // Non-blocking best-effort auditing
    console.warn('[activity] Logging failed:', err.message);
  }

  return json({ ok: true });
}

module.exports = {
  handleActivity,
};
