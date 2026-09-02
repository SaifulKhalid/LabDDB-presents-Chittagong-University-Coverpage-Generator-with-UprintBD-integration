/**
 * scripts/audit-concurrency.js — Adversarial Concurrency Stress Audit.
 * -----------------------------------------------------------------------------
 * Tests:
 *   Test A: Balance = 10, Two simultaneous 10 Tk hold requests.
 *   Test B: 15 simultaneous requests against limited balance (Balance 10, each 3 Tk).
 *   Test C: 10 concurrent settlements of the same job.
 *   Test D: 10 concurrent releases of the same job.
 *   Test E: Concurrent settlement racing with concurrent release.
 *   Test F: Concurrent reconciliation runs racing on the same job.
 */

'use strict';

const assert = require('assert');
const { WalletService } = require('../lib/services/wallet-service.js');
const { reconcile } = require('../lib/services/reconcile-service.js');
const { ConflictError } = require('../lib/domain/errors.js');

// High-fidelity Mock RTDB with simulated random network latency and ETag CAS
class ConcurrentMockRtdb {
  constructor() {
    this.data = {};
    this.etags = new Map();
    this.counter = 1;
    this.conflictCount = 0;
  }

  _clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  async _delay() {
    const ms = Math.floor(Math.random() * 15) + 5;
    await new Promise((r) => setTimeout(r, ms));
  }

  _seg(path) {
    return String(path).replace(/^\/+|\/+$/g, '').split('/');
  }

  async get(path) {
    await this._delay();
    const segs = this._seg(path);
    let cur = this.data;
    for (const s of segs) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[s];
    }
    return this._clone(cur);
  }

  async getWithEtag(path) {
    await this._delay();
    const value = await this.get(path);
    let etag = this.etags.get(path);
    if (!etag) {
      etag = `etag_${this.counter++}`;
      this.etags.set(path, etag);
    }
    return { value, etag };
  }

  async put(path, value, opts = {}) {
    await this._delay();
    const currentEtag = this.etags.get(path);
    if (opts.etag && currentEtag && opts.etag !== currentEtag) {
      this.conflictCount++;
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
    const nextEtag = `etag_${this.counter++}`;
    this.etags.set(path, nextEtag);
    return value;
  }

  async patch(path, value) {
    const cur = (await this.get(path)) || {};
    return this.put(path, Object.assign({}, cur, value));
  }

  async remove(path) {
    await this._delay();
    const segs = this._seg(path);
    let cur = this.data;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!cur[s] || typeof cur[s] !== 'object') return true;
      cur = cur[s];
    }
    delete cur[segs[segs.length - 1]];
    this.etags.delete(path);
    return true;
  }

  async transaction(path, mutator) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { value, etag } = await this.getWithEtag(path);
      const next = await mutator(value);
      if (next === undefined) return { committed: false, value };
      try {
        await this.put(path, next, { etag });
        return { committed: true, value: next };
      } catch (err) {
        if (err.name !== 'ConflictError') throw err;
      }
    }
    return { committed: false };
  }
}

(async () => {
  console.log('=== ADVERSARIAL CONCURRENCY AUDIT ===\n');

  // -------------------------------------------------------------------------
  // Test A: Balance = 10, Two simultaneous 10 Tk hold requests
  // -------------------------------------------------------------------------
  console.log('Test A: Two simultaneous ৳10 print requests against ৳10 balance...');
  {
    const rtdb = new ConcurrentMockRtdb();
    const walletService = new WalletService(rtdb);
    await rtdb.put('wallets/user_a', { balance: 10, reserved: 0, applied: {} });

    const results = await Promise.allSettled([
      walletService.hold('user_a', 'job_a1', 10),
      walletService.hold('user_a', 'job_a2', 10),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(successes.length, 1, 'Exactly one request must succeed');
    assert.strictEqual(failures.length, 1, 'Exactly one request must fail');
    assert.strictEqual(failures[0].reason.status, 402, 'Failure must be 402 Insufficient Funds');

    const wallet = await walletService.getWallet('user_a');
    assert.strictEqual(wallet.balance, 10, 'Balance must remain 10');
    assert.strictEqual(wallet.reserved, 10, 'Reserved must be 10');
    assert.strictEqual(wallet.available, 0, 'Available must be 0');
    assert.ok(wallet.available >= 0, 'Available cannot be negative');
    console.log('   ✅ Test A Passed: Exactly one succeeded, one failed (402), available = 0');
  }

  // -------------------------------------------------------------------------
  // Test B: 15 simultaneous requests against limited balance (10 Tk, 3 Tk each)
  // -------------------------------------------------------------------------
  console.log('\nTest B: 15 simultaneous ৳3 hold requests against ৳10 balance...');
  {
    const rtdb = new ConcurrentMockRtdb();
    const walletService = new WalletService(rtdb);
    await rtdb.put('wallets/user_b', { balance: 10, reserved: 0, applied: {} });

    const promises = [];
    for (let i = 0; i < 15; i++) {
      promises.push(walletService.hold('user_b', `job_b${i}`, 3));
    }

    const results = await Promise.allSettled(promises);
    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(successes.length, 3, 'Exactly 3 requests of ৳3 can fit in ৳10');
    assert.strictEqual(failures.length, 12, '12 requests must be rejected');

    const wallet = await walletService.getWallet('user_b');
    assert.strictEqual(wallet.balance, 10);
    assert.strictEqual(wallet.reserved, 9, 'Reserved must equal 3 * 3 = 9');
    assert.strictEqual(wallet.available, 1, 'Available must equal 10 - 9 = 1');
    console.log(`   ✅ Test B Passed: 3 succeeded, 12 refused, wallet available = ৳${wallet.available}`);
  }

  // -------------------------------------------------------------------------
  // Test C: Concurrent settlement (10 parallel settle calls for same job)
  // -------------------------------------------------------------------------
  console.log('\nTest C: 10 concurrent settlements of the same job...');
  {
    const rtdb = new ConcurrentMockRtdb();
    const walletService = new WalletService(rtdb);
    await rtdb.put('wallets/user_c', {
      balance: 20,
      reserved: 3,
      applied: { hold_job_c: Date.now() },
    });
    await rtdb.put('jobs/user_c/job_c', { id: 'job_c', price: 3, filename: 'Doc_C.pdf', status: 'reserved' });
    await rtdb.put('openJobs/job_c', { id: 'job_c', uid: 'user_c', price: 3, filename: 'Doc_C.pdf' });

    const job = { id: 'job_c', uid: 'user_c', price: 3, filename: 'Doc_C.pdf' };
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(walletService.settle('user_c', job, { actualCost: 2 }));
    }

    const results = await Promise.allSettled(promises);
    assert.strictEqual(results.filter((r) => r.status === 'rejected').length, 0, 'No uncaught errors');

    const replays = results.filter((r) => r.value.alreadyApplied);
    const firstCommits = results.filter((r) => !r.value.alreadyApplied);

    assert.strictEqual(firstCommits.length, 1, 'Exactly one commit charges the balance');
    assert.strictEqual(replays.length, 9, '9 calls were recognized as replays');

    const wallet = await walletService.getWallet('user_c');
    assert.strictEqual(wallet.balance, 17, 'Balance must be exactly 20 - 3 = 17 (no double charge)');
    assert.strictEqual(wallet.reserved, 0, 'Reserved must be 0');
    console.log('   ✅ Test C Passed: 1 charge applied, 9 replays detected, balance = ৳17');
  }

  // -------------------------------------------------------------------------
  // Test D: Concurrent release (10 parallel release calls for same job)
  // -------------------------------------------------------------------------
  console.log('\nTest D: 10 concurrent releases of the same job...');
  {
    const rtdb = new ConcurrentMockRtdb();
    const walletService = new WalletService(rtdb);
    await rtdb.put('wallets/user_d', {
      balance: 10,
      reserved: 3,
      applied: { hold_job_d: Date.now() },
    });
    await rtdb.put('jobs/user_d/job_d', { id: 'job_d', price: 3, filename: 'Doc_D.pdf', status: 'reserved' });

    const job = { id: 'job_d', uid: 'user_d', price: 3, filename: 'Doc_D.pdf' };
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(walletService.release('user_d', job, 'expired'));
    }

    const results = await Promise.allSettled(promises);
    assert.strictEqual(results.filter((r) => r.status === 'rejected').length, 0);

    const firstCommits = results.filter((r) => !r.value.alreadyApplied);
    const replays = results.filter((r) => r.value.alreadyApplied);

    assert.strictEqual(firstCommits.length, 1, 'Exactly one commit released the hold');
    assert.strictEqual(replays.length, 9, '9 calls detected as replays');

    const wallet = await walletService.getWallet('user_d');
    assert.strictEqual(wallet.balance, 10, 'Balance unchanged');
    assert.strictEqual(wallet.reserved, 0, 'Reserved released to 0');
    assert.strictEqual(wallet.available, 10, 'Available restored to 10');
    console.log('   ✅ Test D Passed: 1 release applied, 9 replays detected, reserved = ৳0');
  }

  // -------------------------------------------------------------------------
  // Test E: Concurrent settlement racing with concurrent release
  // -------------------------------------------------------------------------
  console.log('\nTest E: Concurrent settlement racing with concurrent release...');
  {
    const rtdb = new ConcurrentMockRtdb();
    const walletService = new WalletService(rtdb);
    await rtdb.put('wallets/user_e', {
      balance: 10,
      reserved: 3,
      applied: { hold_job_e: Date.now() },
    });
    await rtdb.put('jobs/user_e/job_e', { id: 'job_e', price: 3, filename: 'Doc_E.pdf', status: 'reserved' });

    const job = { id: 'job_e', uid: 'user_e', price: 3, filename: 'Doc_E.pdf' };

    // Settle and Release fired simultaneously
    await Promise.all([
      walletService.settle('user_e', job, { actualCost: 2 }),
      walletService.release('user_e', job, 'expired'),
    ]);

    const wallet = await walletService.getWallet('user_e');
    // INV-19 Guarantee: regardless of who won the race, the student is charged for the printed paper (10 - 3 = 7),
    // and reserved never goes negative!
    assert.strictEqual(wallet.balance, 7, 'Final balance must be 7 (student paid for the print)');
    assert.strictEqual(wallet.reserved, 0, 'Reserved must not go negative');
    assert.strictEqual(wallet.available, 7, 'Available must equal 7');
    console.log('   ✅ Test E Passed: Settle-race-release ended with balance ৳7, reserved ৳0');
  }

  // -------------------------------------------------------------------------
  // Test F: Concurrent reconciliation of the same job
  // -------------------------------------------------------------------------
  console.log('\nTest F: Concurrent reconciliation of the same job...');
  {
    const rtdb = new ConcurrentMockRtdb();
    await rtdb.put('wallets/user_f', {
      balance: 15,
      reserved: 3,
      applied: { hold_job_f: Date.now() },
    });
    await rtdb.put('jobs/user_f/job_f', { id: 'job_f', uid: 'user_f', price: 3, filename: 'Doc_F.pdf', status: 'reserved' });
    await rtdb.put('openJobs/job_f', {
      id: 'job_f',
      uid: 'user_f',
      price: 3,
      filename: 'Doc_F.pdf',
      createdAt: Date.now() - 60000,
    });
    await rtdb.put('printIndex/Doc_F_pdf', { uid: 'user_f', jobId: 'job_f' });

    const mockSession = {
      getAccountBalance: async () => 50,
      getPrintHistory: async () => [
        { dateTime: '2026-09-03 01:00', filename: 'doc_f.pdf', status: 'Completed', cost: 2.0 },
      ],
      getQueuedRecordIds: async () => new Set(),
      deletePrintRequest: async () => true,
    };

    const ctx = { rtdb, session: mockSession, env: {} };

    // Fire two concurrent reconciliation passes
    const [pass1, pass2] = await Promise.all([
      reconcile(ctx, { reason: 'cron_1' }),
      reconcile(ctx, { reason: 'cron_2' }),
    ]);

    console.log('   pass1 result:', JSON.stringify(pass1));
    console.log('   pass2 result:', JSON.stringify(pass2));

    // One must have acquired the lock, the other must have skipped
    const ran = [pass1, pass2].filter((p) => !p.skipped);
    const skipped = [pass1, pass2].filter((p) => p.skipped);

    assert.strictEqual(ran.length, 1, 'Exactly one reconciler pass executes');
    assert.strictEqual(skipped.length, 1, 'The competing pass was locked out (skipped: true)');

    const wallet = await rtdb.get('wallets/user_f');
    assert.strictEqual(wallet.balance, 12, 'Charged exactly once: 15 - 3 = 12');
    assert.strictEqual(wallet.reserved, 0, 'Reserved cleared');

    console.log('   ✅ Test F Passed: Lock acquired by one pass; second pass safely skipped.');
  }

  console.log('\n------------------------------------------------------------');
  console.log('ALL ADVERSARIAL CONCURRENCY AUDIT TESTS PASSED ✅\n');
})().catch((err) => {
  console.error('\nConcurrency Audit FAILED ❌:', err);
  process.exit(1);
});
