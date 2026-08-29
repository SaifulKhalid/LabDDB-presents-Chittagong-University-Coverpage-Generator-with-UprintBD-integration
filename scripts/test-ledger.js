#!/usr/bin/env node
/* =============================================================================
   test-ledger.js — the money tests.
   -----------------------------------------------------------------------------
   The one promise this project makes to a student is: you are not charged unless
   a page came out of the printer. Everything else is a feature; that is a
   guarantee. These tests are how it is checked, and they run with no credentials
   and no network — against an in-memory database that reproduces the two RTDB
   behaviours the ledger actually depends on:

     1. ETag compare-and-swap. PUT with a stale `if-match` fails with 412, which
        is what `Rtdb.transaction` retries on. Faking this lets us force a real
        race — two holds landing on one wallet in the same tick — deterministically,
        which is not something a live database will do on command.

     2. PATCH merges, PUT replaces, DELETE removes. The ledger relies on all three
        (`patch` a job's status, `put` a ledger row, `remove` an openJobs entry).

   Run:  node scripts/test-ledger.js
   ============================================================================= */
'use strict';

const ledger = require('../lib/ledger');
const { ConflictError } = require('../lib/firebase-rest');

// ---------------------------------------------------------------------------
// the fake
// ---------------------------------------------------------------------------

/**
 * An in-memory stand-in for `Rtdb`, matching the surface `lib/ledger.js` uses.
 *
 * Values are stored as a plain nested object, cloned on every read and write so
 * a caller cannot mutate the store by holding on to a returned reference — the
 * real thing goes over HTTP, and a test that accidentally shares objects would
 * pass for the wrong reason.
 */
class FakeRtdb {
  constructor() {
    this.root = {};
    this.version = 0; // bumped on every write; the ETag is derived from it
    this.etags = new Map(); // path -> etag issued at last read/write
    this.reads = 0;
    this.writes = 0;
    this.conflicts = 0;
    /** Set to a function to run arbitrary code between a read and its write. */
    this.beforeWrite = null;
  }

  static clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
  }

  static parts(path) {
    return String(path)
      .split('/')
      .filter((s) => s.length > 0);
  }

  read(path) {
    let node = this.root;
    for (const key of FakeRtdb.parts(path)) {
      if (node === null || typeof node !== 'object' || !(key in node)) return null;
      node = node[key];
    }
    return node === undefined ? null : FakeRtdb.clone(node);
  }

  /**
   * RTDB has three behaviours here that a naive object write would get wrong, and
   * all three matter to the ledger:
   *
   *   - `null` deletes. Both as a whole value and as a key inside a PATCH.
   *   - A node with no children does not exist. Delete the last openJobs entry and
   *     reading `openJobs` answers null, not `{}`.
   *   - A write invalidates the ETag of the path, its ancestors and its children.
   */
  write(path, value, { merge = false } = {}) {
    const parts = FakeRtdb.parts(path);
    if (!parts.length) {
      this.root = merge ? { ...this.root, ...FakeRtdb.clone(value) } : FakeRtdb.clone(value) || {};
    } else {
      const chain = [this.root];
      let node = this.root;
      for (const key of parts.slice(0, -1)) {
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
        chain.push(node);
      }
      const last = parts[parts.length - 1];

      if (value === null) {
        delete node[last];
      } else if (merge && node[last] && typeof node[last] === 'object') {
        const merged = { ...node[last] };
        for (const [k, v] of Object.entries(FakeRtdb.clone(value))) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        node[last] = merged;
      } else {
        const clean = FakeRtdb.clone(value);
        if (clean && typeof clean === 'object') for (const k of Object.keys(clean)) {
          if (clean[k] === null) delete clean[k];
        }
        node[last] = clean;
      }

      // Prune ancestors the delete just emptied.
      for (let i = chain.length - 1; i >= 1; i--) {
        const parent = chain[i - 1];
        const key = parts[i - 1];
        if (parent[key] && typeof parent[key] === 'object' && !Object.keys(parent[key]).length) {
          delete parent[key];
        }
      }
    }

    this.version += 1;
    this.writes += 1;
    const stamp = `v${this.version}`;
    for (const held of this.etags.keys()) {
      if (held === path || held.startsWith(`${path}/`) || path.startsWith(`${held}/`)) {
        this.etags.set(held, stamp);
      }
    }
    this.etags.set(path, stamp);
  }

  async get(path) {
    this.reads += 1;
    return this.read(path);
  }

  async getWithEtag(path) {
    this.reads += 1;
    const etag = this.etags.get(path) || `v${this.version}`;
    this.etags.set(path, etag);
    return { value: this.read(path), etag };
  }

  async put(path, value, opts = {}) {
    if (this.beforeWrite) {
      const hook = this.beforeWrite;
      this.beforeWrite = null; // fire once
      await hook(this);
    }
    if (opts.etag) {
      const current = this.etags.get(path);
      if (current && current !== opts.etag) {
        this.conflicts += 1;
        throw new ConflictError(`ETag mismatch writing ${path}.`);
      }
    }
    this.write(path, value);
    return value;
  }

  async patch(path, value) {
    this.write(path, value, { merge: true });
    return value;
  }

  async remove(path) {
    this.write(path, null);
    return true;
  }

  async transaction(path, mutator, { retries = 6 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { value: current, etag } = await this.getWithEtag(path);
      const next = await mutator(current);
      if (next === undefined) return { committed: false, value: current };
      try {
        await this.put(path, next, { etag: etag || undefined });
        return { committed: true, value: next };
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Could not commit ${path}.`);
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

// ASCII markers on purpose: this is run from PowerShell as often as anywhere, and
// a code-page mismatch turning every tick into mojibake makes output unreadable.
function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label}${detail ? ' - ' + detail : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function suite(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    failures.push({ label: `${name} threw`, detail: err && err.stack });
    console.log(`  FAIL threw: ${err && err.message}`);
  }
}

/** Run `fn` and hand back the error it threw, or null. Every refusal path uses this. */
async function caught(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

const UID = 'test-uid-1';

/** A wallet with a known balance and no history. */
async function freshDb(balance = 0) {
  const db = new FakeRtdb();
  if (balance) await ledger.topUp(db, UID, balance, { note: 'test seed', byUid: 'admin' });
  return db;
}

/** Build the job record the way lib/api.js does, so the tests exercise real shapes. */
function makeJob(price, id) {
  const jobId = id || ledger.newJobId();
  return {
    id: jobId,
    uid: UID,
    price,
    unitPrice: price,
    pages: 1,
    copies: 1,
    color: false,
    filename: ledger.uniqueFilename('AssignmentCover_EEE417_24702008', jobId),
    status: 'reserving',
    createdAt: Date.now(),
  };
}

/**
 * Mint: write the job, the reconciler's working-set entry and the filename index,
 * then reserve the money — the same order as POST /api/print, which lays down the
 * paper trail before contacting UprintBD so a crash mid-mint leaves something the
 * reconciler can still find.
 */
async function mint(db, job) {
  await db.put(`jobs/${UID}/${job.id}`, job);
  await db.put(`openJobs/${job.id}`, {
    uid: UID,
    filename: job.filename,
    price: job.price,
    pages: job.pages,
    copies: job.copies,
    color: job.color,
    createdAt: job.createdAt,
  });
  await db.put(`printIndex/${ledger.fileKey(job.filename)}`, { uid: UID, jobId: job.id });
  const res = await ledger.hold(db, UID, job.id, job.price);
  await db.patch(`jobs/${UID}/${job.id}`, { status: 'reserved' });
  return res;
}

async function wallet(db) {
  const w = ledger.normalizeWallet(await db.get(`wallets/${UID}`));
  return { balance: w.balance, reserved: w.reserved, available: w.balance - w.reserved };
}

/** Every ledger row for the test user, as an array. */
async function rows(db) {
  return Object.values((await db.get(`ledger/${UID}`)) || {});
}

// ---------------------------------------------------------------------------
// 1. pricing
// ---------------------------------------------------------------------------
async function testPricing() {
  const pricing = { ...ledger.DEFAULT_PRICING };
  eq(pricing.mono, 3, 'default mono price is 3 taka');
  eq(pricing.color, 5, 'default colour price is 5 taka');

  // priceJob returns { unitPrice, price, pages, copies } — the row a job is built from.
  const one = (pages, copies, color) => ledger.priceJob({ pages, copies, color, pricing });
  eq(one(1, 1, false).price, 3, '1 b/w page costs 3');
  eq(one(1, 1, true).price, 5, '1 colour page costs 5');
  eq(one(4, 3, false).price, 36, '4 pages x 3 copies b/w costs 36');
  eq(one(1, 1, true).unitPrice, 5, 'the unit price is recorded alongside the total');

  // Garbage in must not produce a free print.
  eq(one(0, 0, false).price, 3, 'zero pages still bills one');
  eq(one(-5, 1, false).price, 3, 'negative pages cannot go free');
  eq(one('abc', null, false).price, 3, 'non-numeric input falls back to one page');
  eq(one(2.4, 1, false).price, 6, 'a fractional page count is rounded before pricing');

  // Filenames are the only join key back to a job, so they must be unique.
  const a = ledger.uniqueFilename('Cover_EEE417_24702008.pdf', 'job111');
  const b = ledger.uniqueFilename('Cover_EEE417_24702008.pdf', 'job222');
  ok(a !== b, 'same document from two jobs gets two filenames');
  ok(a.endsWith('.pdf') && b.endsWith('.pdf'), 'filenames keep the .pdf extension');
  ok(!/\s/.test(ledger.uniqueFilename('Lab Report 3', 'ccc333')), 'spaces are replaced');
  ok(!/[.$#[\]/]/.test(ledger.fileKey(a)), 'fileKey strips characters RTDB keys cannot hold');
  ok(
    ledger.fileKey(a) !== ledger.fileKey(b),
    'distinct filenames stay distinct after key-escaping'
  );

  // An entropy smoke check, not a proof: the suffix is 6 chars of a 32-symbol
  // alphabet, so 200 ids in one millisecond collide about once in 50,000 runs.
  // If this ever fails on its own it is a birthday collision, not a broken id.
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(ledger.newJobId());
  eq(ids.size, 200, '200 job ids minted in one tick are all distinct');
}

// ---------------------------------------------------------------------------
// 2. hold -> settle: the money path for a print that happened
// ---------------------------------------------------------------------------
async function testSettle() {
  const db = await freshDb(10);
  eq((await wallet(db)).available, 10, 'top-up of 10 gives 10 available');

  const job = makeJob(3);
  await mint(db, job);

  let w = await wallet(db);
  eq(w.balance, 10, 'holding does not reduce the balance');
  eq(w.reserved, 3, 'holding reserves the price');
  eq(w.available, 7, 'available drops by the price');
  eq(
    (await rows(db)).filter((e) => e.type === 'charge').length,
    0,
    'a hold writes no charge to the ledger'
  );

  // UprintBD reported the real cost as 2 Tk — that is our cost, not the price.
  await ledger.settle(db, UID, job, {
    actualCost: 2,
    deviceId: 'CU-KIOSK-1',
    historyAt: '2026-08-25 14:02',
  });

  w = await wallet(db);
  eq(w.balance, 7, 'settling takes the price off the balance');
  eq(w.reserved, 0, 'settling clears the reservation');
  eq(w.available, 7, 'available is unchanged by settling a job that was already held');

  const stored = await db.get(`jobs/${UID}/${job.id}`);
  eq(stored.status, 'printed', 'the job is marked printed');
  eq(stored.actualCost, 2, "UprintBD's real cost is recorded for margin reporting");
  eq(stored.deviceId, 'CU-KIOSK-1', 'the kiosk that printed it is recorded');
  eq(stored.price, 3, 'the price the student paid is left untouched by the cost');
  eq(stored.filename, job.filename, 'and the filename survives the patch');
  ok(stored.settledAt > 0, 'the settle is timestamped');

  const charges = (await rows(db)).filter((e) => e.type === 'charge');
  eq(charges.length, 1, 'exactly one charge row is written');
  eq(charges[0].amount, -3, 'the charge is the price, signed negative');
  eq(charges[0].balanceAfter, 7, 'the charge row records the balance after it');
  eq(charges[0].jobId, job.id, 'and points back at the job');
  eq(charges[0].filename, job.filename, 'and at the filename UprintBD printed');

  ok((await db.get(`openJobs/${job.id}`)) === null, 'the reconciler working set is cleaned up');
}

// ---------------------------------------------------------------------------
// 3. hold -> release: THE headline requirement
// ---------------------------------------------------------------------------
async function testRelease() {
  const db = await freshDb(10);
  const job = makeJob(3);
  await mint(db, job);
  eq((await wallet(db)).available, 7, 'the OTP is minted and the money is held');

  // The student never went to the kiosk. The code lapsed.
  await ledger.release(db, UID, job, 'expired', 'OTP expired unused');

  const w = await wallet(db);
  eq(w.balance, 10, 'an unused code leaves the balance exactly as it was');
  eq(w.reserved, 0, 'the reservation is gone');
  eq(w.available, 10, 'every taka is spendable again');

  eq(
    (await rows(db)).filter((e) => e.type === 'charge' || e.type === 'refund').length,
    0,
    'no charge and no refund: a print that never happened leaves no trace in the statement'
  );

  const stored = await db.get(`jobs/${UID}/${job.id}`);
  eq(stored.status, 'expired', 'the job is marked expired');
  eq(stored.reason, 'OTP expired unused', 'with the reason recorded');
  ok((await db.get(`openJobs/${job.id}`)) === null, 'the job leaves the working set');

  // A mint that failed at UprintBD releases the same way, under a different status.
  const db2 = await freshDb(10);
  const failed = makeJob(3);
  await mint(db2, failed);
  await ledger.release(db2, UID, failed, 'failed', 'UprintBD rejected the upload');
  eq((await wallet(db2)).available, 10, 'a failed mint costs nothing either');
  eq(
    (await db2.get(`jobs/${UID}/${failed.id}`)).status,
    'failed',
    'and reads Failed rather than Expired'
  );
}

// ---------------------------------------------------------------------------
// 4. idempotency — the crash-window guarantees
// ---------------------------------------------------------------------------
async function testIdempotency() {
  // Double-settle: the cron fires twice, or an admin clicks "force settle" twice.
  const db = await freshDb(10);
  const job = makeJob(3);
  await mint(db, job);
  await ledger.settle(db, UID, job, { actualCost: 2 });
  const first = await wallet(db);
  const again = await ledger.settle(db, UID, job, { actualCost: 2 });
  const second = await wallet(db);

  eq(second.balance, first.balance, 'settling twice charges once');
  eq(second.reserved, first.reserved, 'settling twice does not double-release the reservation');
  ok(again.alreadyApplied === true, 'the second settle reports itself as a replay');
  eq(
    (await rows(db)).filter((e) => e.type === 'charge').length,
    1,
    'the statement still shows one charge'
  );

  // Ten more for good measure: an admin leaning on the button cannot drain a wallet.
  for (let i = 0; i < 10; i++) await ledger.settle(db, UID, job, { actualCost: 2 });
  eq((await wallet(db)).balance, 7, 'twelve settles of one job cost 3 taka in total');

  // Double-release: cron and a user-initiated cancel racing.
  const db2 = await freshDb(10);
  const job2 = makeJob(3);
  await mint(db2, job2);
  await ledger.release(db2, UID, job2);
  await ledger.release(db2, UID, job2);
  const w2 = await wallet(db2);
  eq(w2.balance, 10, 'releasing twice does not invent money');
  eq(w2.reserved, 0, 'reserved cannot go below zero');
  eq(w2.available, 10, 'the student is made exactly whole');

  // Double-hold on the same job id: a client retry of one gesture.
  const db3 = await freshDb(10);
  const job3 = makeJob(3);
  await ledger.hold(db3, UID, job3.id, job3.price);
  const dupe = await ledger.hold(db3, UID, job3.id, job3.price);
  eq((await wallet(db3)).reserved, 3, 'the same job cannot be held twice');
  ok(dupe.alreadyApplied === true, 'the repeat hold reports itself as a replay');

  // The "printed as the code lapsed" race. The reconciler checks history before
  // expiry, so this ordering should not arise — but if it does, a page came out of
  // the printer and has to be paid for.
  const db4 = await freshDb(10);
  const job4 = makeJob(3);
  await mint(db4, job4);
  await ledger.release(db4, UID, job4);
  await ledger.settle(db4, UID, job4, { actualCost: 2 });
  const w4 = await wallet(db4);
  eq(w4.balance, 7, 'a settle after a release still charges the price');
  eq(w4.reserved, 0, 'and does not push reserved negative');
  eq(
    w4.available,
    7,
    'the money is taken from the balance, not from a reservation that is already gone'
  );

  // Two different jobs must not share a replay guard.
  const db5 = await freshDb(10);
  const a = makeJob(3, 'job-aaa');
  const b = makeJob(3, 'job-bbb');
  await mint(db5, a);
  await mint(db5, b);
  eq((await wallet(db5)).reserved, 6, 'two distinct jobs hold twice the money');
  await ledger.settle(db5, UID, a, { actualCost: 2 });
  await ledger.settle(db5, UID, b, { actualCost: 2 });
  eq((await wallet(db5)).balance, 4, 'and both settle independently');
}

// ---------------------------------------------------------------------------
// 5. insufficient funds
// ---------------------------------------------------------------------------
async function testInsufficient() {
  const db = await freshDb(2);
  const job = makeJob(3);
  const err = await caught(() => ledger.hold(db, UID, job.id, job.price));

  ok(err !== null, 'a hold beyond the balance is refused');
  eq(err && err.status, 402, 'refusal is HTTP 402, so the UI can offer a top-up');
  eq(err && err.code, 'INSUFFICIENT_BALANCE', 'with a code the client can branch on');
  eq(err && err.available, 2, 'and the available balance, so the message can be specific');
  const w = await wallet(db);
  eq(w.reserved, 0, 'a refused hold reserves nothing');
  eq(w.balance, 2, 'a refused hold leaves the balance alone');

  // Exactly enough must succeed — an off-by-one here would block a legitimate print.
  const db2 = await freshDb(3);
  await ledger.hold(db2, UID, 'exact', 3);
  eq((await wallet(db2)).available, 0, 'spending the last 3 taka is allowed');

  // Holds stack until the balance is gone, then stop.
  const db3 = await freshDb(9);
  await ledger.hold(db3, UID, 'j1', 3);
  await ledger.hold(db3, UID, 'j2', 3);
  await ledger.hold(db3, UID, 'j3', 3);
  eq((await wallet(db3)).available, 0, 'three holds consume nine taka');
  ok(
    (await caught(() => ledger.hold(db3, UID, 'j4', 3))) !== null,
    'a fourth hold with nothing available is refused'
  );
  eq((await wallet(db3)).reserved, 9, 'the refusal does not disturb the existing holds');

  // A wallet that has never existed is refused, not treated as unlimited.
  const db4 = new FakeRtdb();
  const broke = await caught(() => ledger.hold(db4, UID, 'first-ever', 3));
  eq(broke && broke.status, 402, 'a user who has never been topped up cannot print');
}

// ---------------------------------------------------------------------------
// 6. concurrency — two writers, one wallet
// ---------------------------------------------------------------------------
async function testConcurrency() {
  // Force the race: while hold #1 is between its read and its write, hold #2
  // completes. #1's ETag is now stale, so its PUT must 412 and retry against the
  // new state. Without CAS both would write `reserved: 3` and one page would be
  // free.
  const db = await freshDb(10);
  db.beforeWrite = (store) => ledger.hold(store, UID, 'racer-b', 3);
  await ledger.hold(db, UID, 'racer-a', 3);

  ok(db.conflicts > 0, 'the stale write was actually rejected (the race really happened)');
  const w = await wallet(db);
  eq(w.reserved, 6, 'both holds are counted — neither was lost');
  eq(w.available, 4, 'available reflects both');

  // The same race at the edge of the balance: the second hold must lose, not
  // overdraw. Two prints cannot spend the same last 3 taka.
  const db2 = await freshDb(3);
  db2.beforeWrite = (store) => ledger.hold(store, UID, 'edge-b', 3);
  const err = await caught(() => ledger.hold(db2, UID, 'edge-a', 3));

  ok(err !== null, 'the loser of a race for the last taka is refused');
  eq(err && err.status, 402, 'refused as 402, with no conflict error leaking to the caller');
  const w2 = await wallet(db2);
  eq(w2.reserved, 3, 'only one hold survives');
  ok(w2.balance - w2.reserved >= 0, 'available never goes negative');

  // A top-up landing while a hold is in flight must survive the retry.
  const db3 = await freshDb(3);
  db3.beforeWrite = (store) => ledger.topUp(store, UID, 20, { note: 'mid-flight', byUid: 'admin' });
  await ledger.hold(db3, UID, 'held-during-topup', 3);
  const w3 = await wallet(db3);
  eq(w3.balance, 23, 'the top-up is not lost when a hold retries over it');
  eq(w3.reserved, 3, 'and neither is the hold');
  eq(w3.available, 20, 'nothing is double-counted');
}

// ---------------------------------------------------------------------------
// 7. admin money movements
// ---------------------------------------------------------------------------
async function testAdmin() {
  const db = new FakeRtdb();

  const res = await ledger.topUp(db, UID, 50, { note: 'bKash TID 9AB7C2D1', byUid: 'admin-uid' });
  eq(res.available, 50, 'a top-up credits the balance');
  const topups = (await rows(db)).filter((e) => e.type === 'topup');
  eq(topups.length, 1, 'the top-up is recorded');
  eq(topups[0].amount, 50, 'for the full amount');
  eq(topups[0].method, 'bKash', 'with the payment method');
  eq(topups[0].byUid, 'admin-uid', 'and the admin who recorded it');
  ok(
    String(topups[0].note).includes('9AB7C2D1'),
    'the bKash transaction id survives into the ledger — the only link to the payment'
  );

  // Refund, then a correction downward.
  await ledger.adjust(db, UID, 5, { note: 'goodwill', byUid: 'admin-uid', type: 'refund' });
  eq((await wallet(db)).balance, 55, 'a positive adjustment adds balance');
  eq((await rows(db)).filter((e) => e.type === 'refund').length, 1, 'typed as a refund, not an adjustment');

  await ledger.adjust(db, UID, -15, { note: 'mistyped top-up', byUid: 'admin-uid' });
  eq((await wallet(db)).balance, 40, 'a negative adjustment takes balance back');

  // An adjustment past zero is refused outright rather than clamped: a silently
  // clamped clawback loses taka the admin believes they removed, and the ledger
  // row would disagree with the wallet.
  const over = await caught(() => ledger.adjust(db, UID, -1000, { note: 'clawback' }));
  ok(over !== null, 'an adjustment that would go below zero is refused');
  eq((await wallet(db)).balance, 40, 'and the balance is untouched by the refusal');
  eq(
    (await rows(db)).filter((e) => e.amount === -1000).length,
    0,
    'with nothing written to the statement'
  );

  // Down to exactly zero is fine.
  await ledger.adjust(db, UID, -40, { note: 'account closed' });
  const zeroed = await wallet(db);
  eq(zeroed.balance, 0, 'an adjustment down to exactly zero is allowed');
  eq(zeroed.available, 0, 'and leaves nothing available');

  // Rejected inputs.
  for (const bad of [0, -0, 'abc', null, undefined, NaN, Infinity, -25]) {
    ok(
      (await caught(() => ledger.topUp(db, UID, bad))) !== null,
      `a top-up of ${String(bad)} is rejected`
    );
  }
  ok(
    (await caught(() => ledger.adjust(db, UID, 0))) !== null,
    'an adjustment of zero is rejected rather than logged'
  );
  eq((await wallet(db)).balance, 0, 'none of the rejected inputs moved money');
}

// ---------------------------------------------------------------------------
// 8. limits
// ---------------------------------------------------------------------------
async function testLimits() {
  const limits = { ...ledger.DEFAULT_LIMITS };
  const pricing = { ...ledger.DEFAULT_PRICING };
  const db = await freshDb(1000);
  const check = (opts) => ledger.checkLimits(db, UID, { limits, pricing, ...opts });

  ok(
    (await caught(() => check({ pages: 1, copies: 1 }))) === null,
    'an ordinary one-page job passes the limits check'
  );
  ok(
    (await caught(() => check({ pages: limits.maxPagesPerJob + 1, copies: 1 }))) !== null,
    `a ${limits.maxPagesPerJob + 1}-page job is refused`
  );
  ok(
    (await caught(() => check({ pages: 1, copies: pricing.maxCopies + 1 }))) !== null,
    `${pricing.maxCopies + 1} copies at once is refused`
  );
  ok(
    (await caught(() => check({ pages: limits.maxPagesPerJob, copies: pricing.maxCopies }))) ===
      null,
    'the caps are inclusive — exactly at the limit is allowed'
  );

  // Open-hold cap: every mint spends real money at UprintBD even before a page
  // prints, so this is the brake on a runaway loop of unused codes.
  for (let i = 0; i < limits.maxOpenHolds; i++) await mint(db, makeJob(3, `open-${i}`));
  const capped = await caught(() => check({ pages: 1, copies: 1 }));
  ok(capped !== null, `a ${limits.maxOpenHolds + 1}th simultaneous open hold is refused`);
  eq(capped && capped.status, 429, 'refused as 429, not as a payment problem');
  eq(capped && capped.code, 'TOO_MANY_HOLDS', 'with a code the UI can explain');

  // Settling one frees a slot: the cap counts live codes, not lifetime prints.
  await ledger.settle(db, UID, makeJob(3, 'open-0'), { actualCost: 2 });
  ok(
    (await caught(() => check({ pages: 1, copies: 1 }))) === null,
    'printing one of them frees a slot immediately'
  );

  // Duplicate submissions: a retried POST must not mint a second OTP.
  const db2 = await freshDb(100);
  const dupJob = { ...makeJob(3, 'dup-1'), clientJobId: 'client-abc', status: 'reserved' };
  await db2.put(`jobs/${UID}/${dupJob.id}`, dupJob);
  const dup = await caught(() =>
    ledger.checkLimits(db2, UID, {
      limits,
      pricing,
      pages: 1,
      copies: 1,
      clientJobId: 'client-abc',
    })
  );
  ok(dup !== null, 'a repeat of the same clientJobId is refused');
  eq(dup && dup.status, 409, 'as a 409 conflict');
  eq(dup && dup.jobId, dupJob.id, 'pointing at the existing job, so the UI can re-show its code');

  // But a retry after a mint that FAILED must be allowed — otherwise a user whose
  // upload broke is stranded with no code and no way to ask for another.
  await db2.patch(`jobs/${UID}/${dupJob.id}`, { status: 'failed' });
  ok(
    (await caught(() =>
      ledger.checkLimits(db2, UID, {
        limits,
        pricing,
        pages: 1,
        copies: 1,
        clientJobId: 'client-abc',
      })
    )) === null,
    'retrying after a failed mint is allowed'
  );
}

// ---------------------------------------------------------------------------
// 9. the full story, end to end
// ---------------------------------------------------------------------------
async function testEndToEnd() {
  // Exactly the scenario in the plan's live kiosk test.
  const db = new FakeRtdb();
  await ledger.topUp(db, UID, 10, { note: 'bKash 10 Tk', byUid: 'admin' });

  // Round one: mint a code, walk away.
  const walked = makeJob(3, 'walked-away');
  await mint(db, walked);
  eq((await wallet(db)).available, 7, 'while the code is live, 3 taka is held');
  await ledger.release(db, UID, walked, 'expired', 'never used');
  eq((await wallet(db)).available, 10, 'walking away costs nothing');

  // Round two: mint a code and print it.
  const printed = makeJob(3, 'printed-it');
  await mint(db, printed);
  await ledger.settle(db, UID, printed, { actualCost: 2, deviceId: 'CU-KIOSK-1' });

  const w = await wallet(db);
  eq(w.balance, 7, 'printing costs the 3 taka price');
  eq(w.reserved, 0, 'with nothing left held');
  eq(w.available, 7, 'nothing is left held');

  const statement = await rows(db);
  eq(statement.length, 2, 'the statement has two rows: the top-up and the one charge');
  eq(statement.filter((e) => e.type === 'topup').length, 1, 'one top-up');
  eq(
    statement.filter((e) => e.type === 'charge').length,
    1,
    'one charge — for the page that printed'
  );

  // Both jobs are accounted for and neither is still open.
  eq((await db.get(`jobs/${UID}/${walked.id}`)).status, 'expired', 'the unused job reads Expired');
  eq((await db.get(`jobs/${UID}/${printed.id}`)).status, 'printed', 'the printed job reads Printed');
  ok((await db.get('openJobs')) === null, 'no holds are left in the working set');

  // The margin: we charged 3, UprintBD charged the institution 2.
  const printedJob = await db.get(`jobs/${UID}/${printed.id}`);
  eq(printedJob.price - printedJob.actualCost, 1, 'the recorded margin is 1 taka per b/w page');
}

// ---------------------------------------------------------------------------
(async function main() {
  console.log('Ledger tests — in-memory RTDB, no credentials, no network.');

  await suite('Pricing and filenames', testPricing);
  await suite('Hold then settle (the page printed)', testSettle);
  await suite('Hold then release (the code was never used)', testRelease);
  await suite('Idempotency under retries and crashes', testIdempotency);
  await suite('Insufficient funds', testInsufficient);
  await suite('Concurrency: compare-and-swap', testConcurrency);
  await suite('Admin top-ups and adjustments', testAdmin);
  await suite('Rate and volume limits', testLimits);
  await suite('End to end: walked away, then printed', testEndToEnd);

  console.log(`\n${'-'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`All ${passed} assertions passed.`);
    return;
  }
  console.log(`${passed} passed, ${failures.length} FAILED:\n`);
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? '\n      ' + f.detail : ''}`);
  // exitCode rather than process.exit(): when stdout is a pipe (npm test | tee,
  // or a CI log) Node writes asynchronously, and exiting outright can truncate
  // the very summary the exit code refers to.
  process.exitCode = 1;
})().catch((err) => {
  console.error('\nThe test harness itself threw:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
