/**
 * scripts/test-domain.js — Comprehensive unit test suite for pure Domain layer.
 * -----------------------------------------------------------------------------
 * Verifies domain invariants, state machines, financial math, and quota policies
 * completely offline with zero external dependencies.
 */

'use strict';

const assert = require('assert');
const {
  DomainError,
  LedgerError,
  AuthError,
  ValidationError,
  ConflictError,
  ProviderError,
} = require('../lib/domain/errors.js');
const { JobStatus, PrintJob, VALID_TRANSITIONS } = require('../lib/domain/print-job.js');
const {
  Wallet,
  calculateAvailable,
  toIntegerTaka,
  pruneApplied,
  newJobId,
  uniqueFilename,
  fileKey,
} = require('../lib/domain/wallet.js');
const {
  DEFAULT_PRICING,
  DEFAULT_LIMITS,
  countPdfPages,
  priceJob,
  checkLimits,
} = require('../lib/domain/pricing.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

console.log('\n--- Domain Layer Unit Tests ---');

console.log('\n1. Typed Error Hierarchy:');
test('DomainError has status and name', () => {
  const err = new DomainError('Base error', 400);
  assert.strictEqual(err.name, 'DomainError');
  assert.strictEqual(err.status, 400);
});

test('LedgerError carries financial payload', () => {
  const err = new LedgerError('No funds', 402, { required: 15, available: 10 });
  assert.strictEqual(err.status, 402);
  assert.strictEqual(err.required, 15);
  assert.strictEqual(err.available, 10);
});

test('ConflictError defaults to 412', () => {
  const err = new ConflictError();
  assert.strictEqual(err.status, 412);
});

test('ProviderError supports retryable flag', () => {
  const err = new ProviderError('Timeout', 502, { retryable: true });
  assert.strictEqual(err.retryable, true);
});

console.log('\n2. PrintJob State Machine:');
test('PrintJob initializes with default reserving status', () => {
  const job = new PrintJob({ id: 'job1', uid: 'user1', price: 3 });
  assert.strictEqual(job.status, JobStatus.RESERVING);
  assert.strictEqual(job.price, 3);
});

test('Valid transition: reserving -> reserved with OTP', () => {
  const job = new PrintJob({ id: 'job1', uid: 'user1' });
  job.transitionTo(JobStatus.RESERVED, { otp: '123456', recordId: 'rec99' });
  assert.strictEqual(job.status, JobStatus.RESERVED);
  assert.strictEqual(job.otp, '123456');
  assert.strictEqual(job.recordId, 'rec99');
});

test('Valid transition: reserved -> printed', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.RESERVED });
  job.transitionTo(JobStatus.PRINTED, { actualCost: 2.0, deviceId: 'KIOSK_01' });
  assert.strictEqual(job.status, JobStatus.PRINTED);
  assert.strictEqual(job.actualCost, 2.0);
  assert.strictEqual(job.deviceId, 'KIOSK_01');
});

test('Valid transition: reserved -> expired', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.RESERVED });
  job.transitionTo(JobStatus.EXPIRED, { reason: 'TTL elapsed' });
  assert.strictEqual(job.status, JobStatus.EXPIRED);
  assert.strictEqual(job.reason, 'TTL elapsed');
});

test('Valid transition: reserved -> cancelled', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.RESERVED });
  job.transitionTo(JobStatus.CANCELLED, { reason: 'Cancelled by student' });
  assert.strictEqual(job.status, JobStatus.CANCELLED);
});

test('Valid transition: expired -> printed (settle-after-release race)', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.EXPIRED });
  job.transitionTo(JobStatus.PRINTED, { actualCost: 2.0 });
  assert.strictEqual(job.status, JobStatus.PRINTED);
});

test('Invalid transition rejected: printed -> cancelled', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.PRINTED });
  assert.throws(() => {
    job.transitionTo(JobStatus.CANCELLED);
  }, /Invalid job status transition/);
});

test('Invalid transition rejected: reserving -> printed', () => {
  const job = new PrintJob({ id: 'job1', status: JobStatus.RESERVING });
  assert.throws(() => {
    job.transitionTo(JobStatus.PRINTED);
  }, /Invalid job status transition/);
});

test('INV-12: toPublicView masks OTP unless reserved', () => {
  const reservedJob = new PrintJob({ id: 'j1', status: JobStatus.RESERVED, otp: '888999' });
  assert.strictEqual(reservedJob.toPublicView().otp, '888999');

  const printedJob = new PrintJob({ id: 'j2', status: JobStatus.PRINTED, otp: '888999' });
  assert.strictEqual(printedJob.toPublicView().otp, null);

  const expiredJob = new PrintJob({ id: 'j3', status: JobStatus.EXPIRED, otp: '888999' });
  assert.strictEqual(expiredJob.toPublicView().otp, null);
});

console.log('\n3. Wallet & Financial Logic:');
test('Available balance equals balance minus reserved', () => {
  const w = new Wallet({ balance: 20, reserved: 6 });
  assert.strictEqual(w.available, 14);
});

test('Available balance cannot go below zero', () => {
  const w = new Wallet({ balance: 5, reserved: 10 });
  assert.strictEqual(w.available, 0);
});

test('Hold decreases available and increases reserved without altering balance', () => {
  const w = new Wallet({ balance: 15, reserved: 0 });
  const res = w.hold('job1', 6);
  assert.strictEqual(res.committed, true);
  assert.strictEqual(w.balance, 15);
  assert.strictEqual(w.reserved, 6);
  assert.strictEqual(w.available, 9);
});

test('Hold fails with 402 on insufficient funds', () => {
  const w = new Wallet({ balance: 5, reserved: 0 });
  assert.throws(() => {
    w.hold('job1', 9);
  }, (err) => err instanceof LedgerError && err.status === 402 && err.code === 'INSUFFICIENT_BALANCE');
});

test('Hold is idempotent under duplicate opId', () => {
  const w = new Wallet({ balance: 15, reserved: 0 });
  w.hold('job1', 5);
  const second = w.hold('job1', 5);
  assert.strictEqual(second.committed, false);
  assert.strictEqual(second.alreadyApplied, true);
  assert.strictEqual(w.reserved, 5); // Did not double-reserve
});

test('Settle charges balance and decrements reserved', () => {
  const w = new Wallet({ balance: 20, reserved: 6 });
  const res = w.settle('job1', 6);
  assert.strictEqual(res.committed, true);
  assert.strictEqual(w.balance, 14);
  assert.strictEqual(w.reserved, 0);
  assert.strictEqual(w.available, 14);
});

test('Settle after release charges balance without driving reserved negative', () => {
  const w = new Wallet({ balance: 20, reserved: 0 });
  const res = w.settle('job1', 6);
  assert.strictEqual(res.committed, true);
  assert.strictEqual(w.balance, 14);
  assert.strictEqual(w.reserved, 0);
});

test('Release restores available without touching balance', () => {
  const w = new Wallet({ balance: 20, reserved: 6 });
  const res = w.release('job1', 6);
  assert.strictEqual(res.committed, true);
  assert.strictEqual(w.balance, 20);
  assert.strictEqual(w.reserved, 0);
  assert.strictEqual(w.available, 20);
});

test('Top-up increases balance and is idempotent', () => {
  const w = new Wallet({ balance: 10, reserved: 0 });
  w.topUp('top_1', 50);
  assert.strictEqual(w.balance, 60);

  const retry = w.topUp('top_1', 50);
  assert.strictEqual(retry.alreadyApplied, true);
  assert.strictEqual(w.balance, 60);
});

test('Negative balance adjustment is refused if below zero', () => {
  const w = new Wallet({ balance: 10, reserved: 0 });
  assert.throws(() => {
    w.adjust('adj_1', -15);
  }, /Cannot adjust balance below zero/);
  assert.strictEqual(w.balance, 10);
});

test('uniqueFilename formats correctly with jobId uppercase suffix', () => {
  const fn = uniqueFilename('Assignment EEE 417', 'm89k78ABC123');
  assert.strictEqual(fn, 'Assignment_EEE_417_ABC123.pdf');
});

test('fileKey strips RTDB invalid characters', () => {
  const key = fileKey('Doc.test$name#1[2]/3.pdf');
  assert.strictEqual(key, 'Doc_test_name_1_2__3_pdf');
});

console.log('\n4. Pricing & Limits:');
test('priceJob calculates mono and colour accurately', () => {
  const mono = priceJob({ pages: 3, copies: 2, color: false });
  assert.strictEqual(mono.price, 18); // 3 * 2 * 3

  const color = priceJob({ pages: 2, copies: 1, color: true });
  assert.strictEqual(color.price, 10); // 2 * 1 * 5
});

test('priceJob handles zero, negative, or invalid pages safely', () => {
  assert.strictEqual(priceJob({ pages: 0, copies: 1, color: false }).price, 3);
  assert.strictEqual(priceJob({ pages: -5, copies: 1, color: false }).price, 3);
  assert.strictEqual(priceJob({ pages: 'invalid', copies: 1, color: false }).price, 3);
  assert.strictEqual(priceJob({ pages: 2.6, copies: 1, color: false }).price, 9); // rounds to 3p * 3
});

test('checkLimits blocks over-page documents', () => {
  assert.throws(() => {
    checkLimits({ pages: 25, copies: 1 });
  }, /maximum per job is 20/);
});

test('checkLimits blocks excessive copies', () => {
  assert.throws(() => {
    checkLimits({ pages: 1, copies: 15 });
  }, /maximum is 10/);
});

test('checkLimits blocks excessive concurrent holds (429 TOO_MANY_HOLDS)', () => {
  assert.throws(() => {
    checkLimits({ pages: 1, copies: 1, activeHoldsCount: 3 });
  }, (err) => err instanceof LedgerError && err.status === 429 && err.code === 'TOO_MANY_HOLDS');
});

test('checkLimits detects recent duplicate submission (409 DUPLICATE)', () => {
  const existingJob = { id: 'dup123', status: 'reserved', createdAt: Date.now() - 30000 };
  assert.throws(() => {
    checkLimits({ pages: 1, copies: 1, existingDuplicateJob: existingJob });
  }, (err) => err instanceof LedgerError && err.status === 409 && err.code === 'DUPLICATE' && err.jobId === 'dup123');
});

console.log('\n------------------------------------------------------------');
console.log(`Domain unit tests: ${passed} passed, 0 failed.\n`);
