/**
 * scripts/audit-financial-live-safe.js — Live-Safe Financial Verification.
 * -----------------------------------------------------------------------------
 * Verifies wallet read, hold placement, cancellation/release, duplicate protection,
 * and balance consistency without incurring real charges.
 */

'use strict';

const assert = require('assert');
const { WalletService } = require('../lib/services/wallet-service.js');
const { checkLimits } = require('../lib/domain/pricing.js');

class MemoryRtdb {
  constructor() {
    this.store = {};
    this.etags = {};
    this.counter = 1;
  }
  _clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  _seg(path) { return String(path).replace(/^\/+|\/+$/g, '').split('/'); }
  async get(path) {
    const segs = this._seg(path);
    let cur = this.store;
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
    const segs = this._seg(path);
    let cur = this.store;
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
    let cur = this.store;
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
  console.log('=== FINANCIAL LIVE-SAFE AUDIT ===\n');

  const rtdb = new MemoryRtdb();
  const ws = new WalletService(rtdb);

  const testUid = 'student_livesafe_01';
  await rtdb.put(`wallets/${testUid}`, { balance: 25, reserved: 0, applied: {} });

  // 1. Wallet read
  console.log('1. Verifying wallet initial state...');
  let w = await ws.getWallet(testUid);
  assert.strictEqual(w.balance, 25);
  assert.strictEqual(w.reserved, 0);
  assert.strictEqual(w.available, 25);
  console.log(`   ✅ Initial balance: ৳${w.balance}, Reserved: ৳${w.reserved}, Available: ৳${w.available}`);

  // 2. Pre-flight reservation (Hold)
  console.log('\n2. Placing pre-flight hold of ৳3 for job_safe_99...');
  const holdRes = await ws.hold(testUid, 'job_safe_99', 3);
  assert.strictEqual(holdRes.committed, true);
  w = await ws.getWallet(testUid);
  assert.strictEqual(w.balance, 25, 'Balance must remain 25');
  assert.strictEqual(w.reserved, 3, 'Reserved must become 3');
  assert.strictEqual(w.available, 22, 'Available must become 22');
  console.log(`   ✅ Hold placed: Balance = ৳${w.balance}, Reserved = ৳${w.reserved}, Available = ৳${w.available}`);

  // 3. Duplicate request protection
  console.log('\n3. Verifying duplicate-request protection within 10m...');
  let dupeBlocked = false;
  try {
    checkLimits({
      limits: { maxOpenHolds: 3, maxJobsPerHour: 20, maxPagesPerJob: 20 },
      pages: 1,
      copies: 1,
      activeHoldsCount: 1,
      recentJobsCount: 1,
      clientJobId: 'client_req_100',
      existingDuplicateJob: {
        id: 'job_safe_99',
        clientJobId: 'client_req_100',
        status: 'reserved',
        createdAt: Date.now() - 30000,
      },
    });
  } catch (err) {
    if (err.status === 409 && err.code === 'DUPLICATE') dupeBlocked = true;
  }
  assert.strictEqual(dupeBlocked, true, 'Must block duplicate with 409 DUPLICATE');
  console.log('   ✅ Duplicate submission rejected with 409 Conflict.');

  // 4. Cancellation & Release
  console.log('\n4. Cancelling print job and releasing held funds...');
  const relRes = await ws.release(testUid, { id: 'job_safe_99', price: 3 }, 'cancelled');
  assert.strictEqual(relRes.committed, true);
  w = await ws.getWallet(testUid);
  assert.strictEqual(w.balance, 25, 'Balance must not change');
  assert.strictEqual(w.reserved, 0, 'Reserved must return to 0');
  assert.strictEqual(w.available, 25, 'Available must return to full ৳25');
  console.log(`   ✅ Release verified: Balance = ৳${w.balance}, Reserved = ৳${w.reserved}, Available = ৳${w.available}`);

  // 5. Ledger Statement Verification: zero charges written
  console.log('\n5. Checking ledger statement: confirming zero unprinted charges...');
  const stmt = await rtdb.get(`ledger/${testUid}`);
  assert.strictEqual(stmt, null, 'No charge rows written for cancelled job (INV-4)');
  console.log('   ✅ Clean ledger: Zero charges logged; student was charged ৳0.');

  console.log('\n------------------------------------------------------------');
  console.log('FINANCIAL LIVE-SAFE AUDIT PASSED 100% ✅\n');
})().catch((err) => {
  console.error('\nLive-safe financial audit failed:', err);
  process.exit(1);
});
