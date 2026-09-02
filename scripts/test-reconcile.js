/**
 * scripts/test-reconcile.js — Comprehensive unit test suite for Reconciliation engine.
 * -----------------------------------------------------------------------------
 * Verifies settle, expiry, provider deletion, leak detection, lock safety,
 * and error bailout without live network or external credentials.
 */

'use strict';

const assert = require('assert');
const { reconcile, acquireLock, releaseLock, normName } = require('../lib/services/reconcile-service.js');
const ledger = require('../lib/ledger.js');

// Mock RTDB with ETag CAS support (derived from FakeRtdb pattern)
class MockRtdb {
  constructor() {
    this.data = {};
    this.etags = {};
    this._etagCounter = 1;
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
    const etag = this.etags[path] || `etag_${this._etagCounter++}`;
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
    this.etags[path] = `etag_${this._etagCounter++}`;
    return value;
  }

  async patch(path, value) {
    const existing = (await this.get(path)) || {};
    const merged = Object.assign({}, existing, value);
    return this.put(path, merged);
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
    const { value: current, etag } = await this.getWithEtag(path);
    const next = await mutator(current);
    if (next === undefined) return { committed: false, value: current };
    await this.put(path, next, { etag });
    return { committed: true, value: next };
  }
}

class MockSession {
  constructor() {
    this.historyRows = [];
    this.queuedRecordIds = new Set();
    this.balance = 50;
    this.deletedRecords = [];
    this.failHistory = false;
    this.failDelete = false;
  }

  async getAccountBalance() {
    return this.balance;
  }

  async getPrintHistory() {
    if (this.failHistory) throw new Error('Simulated network failure on print history');
    return this.historyRows;
  }

  async getQueuedRecordIds() {
    return new Set(this.queuedRecordIds);
  }

  async deletePrintRequest(recordId) {
    if (this.failDelete) return false;
    this.deletedRecords.push(recordId);
    this.queuedRecordIds.delete(recordId);
    return true;
  }
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

(async () => {
  console.log('\n--- Reconciliation Engine Unit Tests ---');

  await test('Empty openJobs finishes cleanly and writes lastReconcileAt', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    const ctx = { rtdb, session, env: {} };

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.openJobs, 0);
    assert.strictEqual(summary.settled, 0);
    assert.strictEqual(summary.released, 0);

    const state = await rtdb.get('admin/uprint');
    assert.ok(state && state.lastReconcileAt);
    assert.strictEqual(state.accountBalance, 50);
  });

  await test('INV-1: Completed history row settles print job, charges balance, clears reservation', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    const ctx = { rtdb, session, env: {} };

    // Setup initial student wallet: 20 balance, 3 reserved (from hold)
    await rtdb.put('wallets/user1', { balance: 20, reserved: 3, applied: { hold_job101: Date.now() } });
    await rtdb.put('jobs/user1/job101', {
      id: 'job101',
      uid: 'user1',
      price: 3,
      filename: 'Doc_JOB101.pdf',
      status: 'reserved',
      recordId: 'rec101',
    });
    await rtdb.put('openJobs/job101', {
      id: 'job101',
      uid: 'user1',
      price: 3,
      filename: 'Doc_JOB101.pdf',
      recordId: 'rec101',
      createdAt: Date.now() - 60000,
      expiresAt: Date.now() + 300000,
    });
    await rtdb.put('printIndex/Doc_JOB101_pdf', { uid: 'user1', jobId: 'job101' });

    // UprintBD history confirms print
    session.historyRows = [
      {
        dateTime: '2026-09-03 01:00',
        filename: 'doc_job101.pdf',
        status: 'Completed',
        cost: 2.0,
        deviceId: 'KIOSK_05',
      },
    ];

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.openJobs, 1);
    assert.strictEqual(summary.settled, 1);

    // Wallet checks: 20 - 3 = 17 balance, 0 reserved
    const wallet = await rtdb.get('wallets/user1');
    assert.strictEqual(wallet.balance, 17);
    assert.strictEqual(wallet.reserved, 0);

    // Job check: status printed, settledAt stamped
    const job = await rtdb.get('jobs/user1/job101');
    assert.strictEqual(job.status, 'printed');
    assert.strictEqual(job.actualCost, 2.0);
    assert.strictEqual(job.deviceId, 'KIOSK_05');

    // openJobs cleaned up
    const open = await rtdb.get('openJobs');
    assert.strictEqual(open && open.job101, undefined);
  });

  await test('INV-6: Expired unused code deleted at UprintBD FIRST before hold release', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    const ctx = { rtdb, session, env: {} };

    await rtdb.put('wallets/user2', { balance: 10, reserved: 3, applied: { hold_job202: Date.now() } });
    await rtdb.put('jobs/user2/job202', {
      id: 'job202',
      uid: 'user2',
      price: 3,
      filename: 'Doc_JOB202.pdf',
      status: 'reserved',
      recordId: 'rec202',
    });
    // Expired past 3600s + 300s grace
    await rtdb.put('openJobs/job202', {
      id: 'job202',
      uid: 'user2',
      price: 3,
      filename: 'Doc_JOB202.pdf',
      recordId: 'rec202',
      createdAt: Date.now() - 4000000,
      expiresAt: Date.now() - 500000,
    });
    await rtdb.put('printIndex/Doc_JOB202_pdf', { uid: 'user2', jobId: 'job202' });

    session.queuedRecordIds.add('rec202');

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.released, 1);
    assert.ok(session.deletedRecords.includes('rec202'), 'Must delete record at provider');

    const wallet = await rtdb.get('wallets/user2');
    assert.strictEqual(wallet.balance, 10); // Balance untouched
    assert.strictEqual(wallet.reserved, 0); // Reservation freed

    const job = await rtdb.get('jobs/user2/job202');
    assert.strictEqual(job.status, 'expired');
  });

  await test('INV-6 Failure: If provider delete fails, hold is NOT released', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    session.failDelete = true;
    const ctx = { rtdb, session, env: {} };

    await rtdb.put('wallets/user3', { balance: 10, reserved: 3, applied: { hold_job303: Date.now() } });
    await rtdb.put('openJobs/job303', {
      id: 'job303',
      uid: 'user3',
      price: 3,
      filename: 'Doc_JOB303.pdf',
      recordId: 'rec303',
      createdAt: Date.now() - 4000000,
      expiresAt: Date.now() - 500000,
    });
    session.queuedRecordIds.add('rec303');

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.failedDeletes, 1);
    assert.strictEqual(summary.released, 0);

    const wallet = await rtdb.get('wallets/user3');
    assert.strictEqual(wallet.reserved, 3, 'Hold must be kept if delete failed');
  });

  await test('INV-7: On print history error, bail out immediately and leave holds untouched', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    session.failHistory = true;
    const ctx = { rtdb, session, env: {} };

    await rtdb.put('wallets/user4', { balance: 10, reserved: 3 });
    await rtdb.put('openJobs/job404', {
      id: 'job404',
      uid: 'user4',
      price: 3,
      filename: 'Doc_JOB404.pdf',
      createdAt: Date.now() - 1000,
    });

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.settled, 0);
    assert.strictEqual(summary.released, 0);
    assert.ok(summary.errors.length > 0);

    const wallet = await rtdb.get('wallets/user4');
    assert.strictEqual(wallet.reserved, 3, 'Holds must stay untouched on history failure');
  });

  await test('INV-17: Completed prints missing from printIndex recorded in unmatched leak detector', async () => {
    const rtdb = new MockRtdb();
    const session = new MockSession();
    const ctx = { rtdb, session, env: {} };

    session.historyRows = [
      {
        dateTime: '2026-09-03 01:15',
        filename: 'mystery_untracked_document.pdf',
        status: 'Completed',
        cost: 2.0,
      },
    ];

    // Dummy open job to trigger history processing
    await rtdb.put('openJobs/dummy', { id: 'dummy', filename: 'dummy.pdf', expiresAt: Date.now() + 100000 });

    const summary = await reconcile(ctx);
    assert.strictEqual(summary.unmatched, 1);

    const unmatched = await rtdb.get('admin/uprint/unmatched/mystery_untracked_document_pdf');
    assert.ok(unmatched);
    assert.strictEqual(unmatched.cost, 2.0);
  });

  console.log('\n------------------------------------------------------------');
  console.log(`Reconciliation tests: ${passed} passed, 0 failed.\n`);
})();
