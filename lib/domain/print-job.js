/**
 * lib/domain/print-job.js — PrintJob domain entity & explicit state machine.
 * -----------------------------------------------------------------------------
 * Enforces the job lifecycle:
 *   reserving -> reserved -> printed | expired | cancelled | failed
 *   (with expired -> printed supported for settle-after-release races)
 */

'use strict';

const { DomainError } = require('./errors.js');

const JobStatus = Object.freeze({
  RESERVING: 'reserving',
  RESERVED: 'reserved',
  PRINTED: 'printed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

// Explicit transition rules: [fromState]: Set(toStates)
const VALID_TRANSITIONS = Object.freeze({
  [JobStatus.RESERVING]: new Set([JobStatus.RESERVED, JobStatus.FAILED]),
  [JobStatus.RESERVED]: new Set([
    JobStatus.PRINTED,
    JobStatus.EXPIRED,
    JobStatus.CANCELLED,
    JobStatus.FAILED,
  ]),
  // settle-after-release race: physical print occurred right around expiration
  [JobStatus.EXPIRED]: new Set([JobStatus.PRINTED]),
  [JobStatus.PRINTED]: new Set(),
  [JobStatus.CANCELLED]: new Set(),
  [JobStatus.FAILED]: new Set(),
});

class PrintJob {
  constructor(data = {}) {
    this.id = String(data.id || '');
    this.uid = String(data.uid || '');
    this.status = data.status || JobStatus.RESERVING;
    this.price = Math.round(Number(data.price) || 0);
    this.unitPrice = Math.round(Number(data.unitPrice) || 0);
    this.pages = Math.max(1, Math.round(Number(data.pages) || 1));
    this.copies = Math.max(1, Math.round(Number(data.copies) || 1));
    this.color = !!data.color;
    this.filename = String(data.filename || '');
    this.clientJobId = data.clientJobId ? String(data.clientJobId) : null;
    this.tool = String(data.tool || '');
    this.title = String(data.title || '');
    this.courseCode = String(data.courseCode || '');
    this.roll = String(data.roll || '');
    this.createdAt = Number(data.createdAt) || Date.now();
    this.expiresAt = data.expiresAt ? Number(data.expiresAt) : null;
    this.otp = data.otp ? String(data.otp) : null;
    this.recordId = data.recordId ? String(data.recordId) : null;
    this.uprintEstimate = data.uprintEstimate != null ? Number(data.uprintEstimate) : null;
    this.actualCost = data.actualCost != null ? Number(data.actualCost) : null;
    this.deviceId = data.deviceId ? String(data.deviceId) : null;
    this.settledAt = data.settledAt ? Number(data.settledAt) : null;
    this.releasedAt = data.releasedAt ? Number(data.releasedAt) : null;
    this.printedAt = data.printedAt ? Number(data.printedAt) : null;
    this.reason = data.reason ? String(data.reason) : null;
    this.failureReason = data.failureReason ? String(data.failureReason) : null;
  }

  /**
   * Validate whether transitioning from current status to next status is permitted.
   */
  canTransitionTo(nextStatus) {
    const allowed = VALID_TRANSITIONS[this.status];
    return !!(allowed && allowed.has(nextStatus));
  }

  /**
   * Transition job status with invariant verification.
   */
  transitionTo(nextStatus, actionDetails = {}) {
    if (!this.canTransitionTo(nextStatus)) {
      throw new DomainError(
        `Invalid job status transition from '${this.status}' to '${nextStatus}'.`,
        409
      );
    }
    this.status = nextStatus;

    if (actionDetails.otp) this.otp = String(actionDetails.otp);
    if (actionDetails.recordId) this.recordId = String(actionDetails.recordId);
    if (actionDetails.expiresAt) this.expiresAt = Number(actionDetails.expiresAt);
    if (actionDetails.settledAt) this.settledAt = Number(actionDetails.settledAt);
    if (actionDetails.releasedAt) this.releasedAt = Number(actionDetails.releasedAt);
    if (actionDetails.printedAt) this.printedAt = Number(actionDetails.printedAt);
    if (actionDetails.actualCost != null) this.actualCost = Number(actionDetails.actualCost);
    if (actionDetails.deviceId) this.deviceId = String(actionDetails.deviceId);
    if (actionDetails.reason) this.reason = String(actionDetails.reason);
    if (actionDetails.failureReason) this.failureReason = String(actionDetails.failureReason);

    return this;
  }

  /**
   * Format job for presentation to clients.
   * INVARIANT INV-12: OTP is visible only while status is 'reserved'.
   */
  toPublicView() {
    return {
      id: this.id,
      status: this.status,
      otp: this.status === JobStatus.RESERVED ? this.otp : null,
      price: this.price,
      pages: this.pages,
      copies: this.copies,
      color: this.color,
      title: this.title,
      courseCode: this.courseCode,
      filename: this.filename,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      settledAt: this.settledAt,
      actualCost: this.actualCost,
    };
  }

  toDatabaseRecord() {
    return {
      id: this.id,
      uid: this.uid,
      status: this.status,
      price: this.price,
      unitPrice: this.unitPrice,
      pages: this.pages,
      copies: this.copies,
      color: this.color,
      filename: this.filename,
      clientJobId: this.clientJobId,
      tool: this.tool,
      title: this.title,
      courseCode: this.courseCode,
      roll: this.roll,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      otp: this.otp,
      recordId: this.recordId,
      uprintEstimate: this.uprintEstimate,
      actualCost: this.actualCost,
      deviceId: this.deviceId,
      settledAt: this.settledAt,
      releasedAt: this.releasedAt,
      printedAt: this.printedAt,
      reason: this.reason,
      failureReason: this.failureReason,
    };
  }
}

module.exports = {
  JobStatus,
  PrintJob,
  VALID_TRANSITIONS,
};
