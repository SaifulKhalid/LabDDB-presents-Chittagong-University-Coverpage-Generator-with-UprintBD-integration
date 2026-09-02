/**
 * scripts/audit-idempotency.js — Adversarial Idempotency Stress Audit.
 * -----------------------------------------------------------------------------
 * Verifies that repeating the exact same operations (print, hold, settle, release,
 * reconcile) is strictly idempotent and cannot produce double charges, phantom
 * refunds, duplicate jobs, or balance drift.
 */

'use strict';

const assert = require('assert');
const { WalletService } = require('../lib/services/wallet-service.js');
const { PrintService } = require('../lib/services/print-service.js');
const { reconcile } = require('../lib/services/reconcile-service.js');
const { checkLimits } = require('../lib/domain/pricing.js');

class MockRtdb {
  constructor() {
    this.data = {};
    this.etags = {};
    this.counter = 1;
  }

  _clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  _seg(path) {
    return String(path).replace(/^\/+|\/+$/g, '').split('/');
  }

  async get(path) {
    const segs = this._seg(path);
    let cur = this.data;
    for (const s of segs) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[s];
    }
    return this._clone(cur);
  }

  async getWithEtag(path) {
    const value = await this.get(path);
    const etag = this.etags[path] || `etag_${this.counter++}`;
    this.etags[path] = etag;
    return { value, etag };
  }

  async put(path, value, opts = {}) {
    const currentEtag = this.etags[path];
    if (opts.etag && currentEtag && opts.etag !== currentEtag) {
      const err = new Error('412 Precondition Failed');
      err.name = 'ConflictError';
      throw err;
    }
    const segs = this._seg(path);
    let cur = this.data;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!cur[s] || typeof cur[s] !== 'object') cur[s] = {};
      cur = cur[s];
    }
    cur[segs[segs.length - 1]] = this._clone(value);
    this.etags[path] = `etag_${this.counter++}`;
    return value;
  }

  async patch(path, value) {
    const cur = (await this.get(path)) || {};
    return this.put(path, Object.assign({}, cur, value));
  }

  async remove(path) {
    const segs = this._seg(path);
    let cur = this.data;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!cur[s] || typeof cur[s] !== 'object') return true;
      cur = cur[s];
    }
    delete cur[segs[segs.length - 1]];
    delete this.etags[path];
    return true;
  }

  async transaction(path, mutator) {
    const { value, etag } = await this.getWithEtag(path);
    const next = await mutator(value);
    if (next === undefined) return { committed: false, value };
    await this.put(path, next, { etag });
    return { committed: true, value: next };
  }
}

(async () => {
  console.log('=== ADVERSARIAL IDEMPOTENCY AUDIT ===\n');

  // 1. Hold Idempotency
  console.log('1. Repeat Hold with identical jobId...');
  {
    const rtdb = new MockRtdb();
    const ws = new WalletService(rtdb);
    await rtdb.put('wallets/u1', { balance: 10, reserved: 0, applied: {} });

    const first = await ws.hold('u1', 'job_repeat', 3);
    assert.strictEqual(first.committed, true);
    assert.strictEqual(first.alreadyApplied, false);

    const second = await ws.hold('u1', 'job_repeat', 3);
    assert.strictEqual(second.committed, false);
    assert.strictEqual(second.alreadyApplied, true, 'Must detect as alreadyApplied');

    const third = await ws.hold('u1', 'job_repeat', 3);
    assert.strictEqual(third.alreadyApplied, true);

    const w = await ws.getWallet('u1');
    assert.strictEqual(w.balance, 10);
    assert.strictEqual(w.reserved, 3, 'Money reserved only once (not 9)');
    assert.strictEqual(w.available, 7);
    console.log('   ✅ Hold idempotency verified: 3 calls reserved ৳3 exactly once.');
  }

  // 2. Settle Idempotency
  console.log('\n2. Repeat Settle with identical job...');
  {
    const rtdb = new MockRtdb();
    const ws = new WalletService(rtdb);
    await rtdb.put('wallets/u2', { balance: 10, reserved: 3, applied: { hold_j2: Date.now() } });
    await rtdb.put('jobs/u2/j2', { id: 'j2', price: 3, filename: 'Doc.pdf', status: 'reserved' });

    const job = { id: 'j2', uid: 'u2', price: 3, filename: 'Doc.pdf' };
    const s1 = await ws.settle('u2', job, { actualCost: 2 });
    assert.strictEqual(s1.committed, true);

    const s2 = await ws.settle('u2', job, { actualCost: 2 });
    assert.strictEqual(s2.committed, false);
    assert.strictEqual(s2.alreadyApplied, true);

    const s3 = await ws.settle('u2', job, { actualCost: 2 });
    assert.strictEqual(s3.alreadyApplied, true);

    const ledgerEntries = Object.values((await rtdb.get('ledger/u2')) || {});
    assert.strictEqual(ledgerEntries.length, 1, 'Exactly one ledger charge row exists');
    assert.strictEqual(ledgerEntries[0].amount, -3);

    const w = await ws.getWallet('u2');
    assert.strictEqual(w.balance, 7, 'Balance is 7 (not 1 or -2)');
    assert.strictEqual(w.reserved, 0);
    console.log('   ✅ Settle idempotency verified: 3 calls charged ৳3 exactly once; 1 ledger entry.');
  }

  // 3. Release Idempotency
  console.log('\n3. Repeat Release with identical job...');
  {
    const rtdb = new MockRtdb();
    const ws = new WalletService(rtdb);
    await rtdb.put('wallets/u3', { balance: 10, reserved: 3, applied: { hold_j3: Date.now() } });
    const job = { id: 'j3', uid: 'u3', price: 3, filename: 'Doc3.pdf' };

    const r1 = await ws.release('u3', job, 'expired');
    assert.strictEqual(r1.committed, true);

    const r2 = await ws.release('u3', job, 'expired');
    assert.strictEqual(r2.alreadyApplied, true);

    const r3 = await ws.release('u3', job, 'expired');
    assert.strictEqual(r3.alreadyApplied, true);

    const w = await ws.getWallet('u3');
    assert.strictEqual(w.balance, 10, 'Balance is untouched');
    assert.strictEqual(w.reserved, 0, 'Reserved is 0 (not negative)');
    assert.strictEqual(w.available, 10);
    console.log('   ✅ Release idempotency verified: 3 calls released reservation exactly once; reserved >= 0.');
  }

  // 4. Duplicate Print Request (clientJobId)
  console.log('\n4. Duplicate print request with identical clientJobId (<10min)...');
  {
    const existingDuplicateJob = {
      id: 'job_original_999',
      clientJobId: 'uuid_12345',
      otp: '777888',
      status: 'reserved',
      createdAt: Date.now() - 60000,
    };

    let thrown = null;
    try {
      checkLimits({
        limits: { maxOpenHolds: 3, maxJobsPerHour: 20, maxPagesPerJob: 20 },
        pages: 1,
        copies: 1,
        activeHoldsCount: 1,
        recentJobsCount: 1,
        clientJobId: 'uuid_12345',
        existingDuplicateJob,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'Must throw duplicate error');
    assert.strictEqual(thrown.status, 409, 'Status must be 409 Conflict');
    assert.strictEqual(thrown.jobId, 'job_original_999', 'Must return original jobId');
    console.log('   ✅ Duplicate submission protection verified: 409 returned pointing to original jobId.');
  }

  // 5. Repeat Reconciliation
  console.log('\n5. Repeat Reconciliation passes with same state...');
  {
    const rtdb = new MockRtdb();
    await rtdb.put('wallets/u5', { balance: 10, reserved: 3, applied: { hold_j5: Date.now() } });
    await rtdb.put('jobs/u5/j5', { id: 'j5', uid: 'u5', price: 3, filename: 'Doc5.pdf', status: 'reserved' });
    await rtdb.put('openJobs/j5', { id: 'j5', uid: 'u5', price: 3, filename: 'Doc5.pdf', createdAt: Date.now() - 1000 });
    await rtdb.put('printIndex/Doc5_pdf', { uid: 'u5', jobId: 'j5' });

    const session = {
      getAccountBalance: async () => 20,
      getPrintHistory: async () => [
        { dateTime: '2026-09-03 01:00', filename: 'doc5.pdf', status: 'Completed', cost: 2.0 },
      ],
      getQueuedRecordIds: async () => new Set(),
      deletePrintRequest: async () => true,
    };

    const ctx = { rtdb, session, env: {} };

    // Pass 1: Settles job
    const res1 = await reconcile(ctx, { reason: 'test1', force: true });
    assert.strictEqual(res1.settled, 1);

    // Pass 2: Re-run immediately over same history
    const res2 = await reconcile(ctx, { reason: 'test2', force: true });
    assert.strictEqual(res2.openJobs, 0, 'openJobs is now 0');
    assert.strictEqual(res2.settled, 0, 'No additional settles');

    // Pass 3: Re-run again
    const res3 = await reconcile(ctx, { reason: 'test3', force: true });
    assert.strictEqual(res3.settled, 0);

    const w = await rtdb.get('wallets/u5');
    assert.strictEqual(w.balance, 7, 'Balance charged exactly once');
    assert.strictEqual(w.reserved, 0);
    console.log('   ✅ Reconciliation idempotency verified: 3 passes converged cleanly with 1 charge.');
  }

  console.log('\n------------------------------------------------------------');
  console.log('ALL ADVERSARIAL IDEMPOTENCY AUDIT TESTS PASSED ✅\n');
})().catch((err) => {
  console.error('\nIdempotency Audit FAILED ❌:', err);
  process.exit(1);
});
