/**
 * ledger.js — the wallet. Reserve on mint, settle on print, release on expiry.
 * -----------------------------------------------------------------------------
 * The product promise is exact: *"even if anyone generates OTP but does not
 * print, it will not deduce balance."* So minting an OTP never debits. It places
 * a **hold**, and exactly one of two things eventually happens to that hold:
 *
 *   settle  — /uprint/print_history/ shows the job Completed  -> balance drops
 *   release — the OTP expired unused                          -> money comes back
 *
 * `available = balance - reserved` is what the user may spend. That is the number
 * the UI shows, and the only one a hold is checked against.
 *
 * EXACTLY-ONCE, WITHOUT TRANSACTIONS
 * The database is Firebase RTDB reached over REST, so there is no multi-node
 * transaction. Two-step schemes all have a crash window: write the ledger first
 * and a crash gives away a free print, mutate the balance first and a retry
 * double-charges a student.
 *
 * The fix is to keep the idempotency key in the *same node as the money*. Every
 * wallet mutation carries an `opId` (`settle_<jobId>`, `release_<jobId>`, ...)
 * recorded into `wallet.applied` in the very same compare-and-swap that moves the
 * numbers. Re-running any operation is then a no-op by construction, at any point
 * of failure, with no coordination. `applied` is pruned on write, so it stays
 * small. The ledger row is written afterwards at a deterministic key, making it
 * safe to re-write and recoverable if a crash skipped it.
 *
 * Money is whole taka as integers throughout. No floats touch a balance.
 */

'use strict';

const { Rtdb } = require('./firebase-rest.js');

// ---------------------------------------------------------------------------
// Defaults — real values live in RTDB /config and are admin-editable.
// ---------------------------------------------------------------------------
const DEFAULT_PRICING = { mono: 3, color: 5, currency: 'BDT', maxCopies: 10 };
const DEFAULT_LIMITS = {
  maxOpenHolds: 3, // simultaneous unprinted OTPs per user
  maxJobsPerHour: 20, // abuse brake; each mint costs the institution real money
  maxPagesPerJob: 20,
  minTopUp: 5,
  maxTopUp: 2000,
  holdGraceSeconds: 300, // extra slack past OTP expiry before releasing
};

// Keep the replay guard bounded: holds live ~1 h, so a day is generous.
const APPLIED_TTL_MS = 24 * 60 * 60 * 1000;
const APPLIED_MAX = 100;

class LedgerError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// ids and keys
// ---------------------------------------------------------------------------
const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

function randomChars(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** Time-ordered job id, so RTDB key order is chronological. */
function newJobId() {
  return Date.now().toString(36) + randomChars(6);
}

function newLedgerId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomChars(4)}`;
}

/**
 * A filename unique across every user, forever.
 *
 * print_history has no record-id column, so the filename is the ONLY join key
 * back to a job — and the prototype's `AssignmentCover_EEE_417_24702008.pdf` is
 * reproducible by anyone holding that roll number. Two students printing the
 * same cover on the same day would be indistinguishable, and one of them would
 * pay for the other's page. The job-id suffix removes the collision.
 */
function uniqueFilename(baseName, jobId) {
  const stem = String(baseName || 'Document')
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 90);
  return `${stem}_${jobId.slice(-6).toUpperCase()}.pdf`;
}

/** RTDB keys may not contain . $ # [ ] / — filenames contain dots. */
function fileKey(filename) {
  return String(filename).replace(/[.$#[\]/]/g, '_');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
function intOr(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

async function loadPricing(rtdb) {
  const raw = (await rtdb.get('config/pricing')) || {};
  return {
    mono: Math.max(0, intOr(raw.mono, DEFAULT_PRICING.mono)),
    color: Math.max(0, intOr(raw.color, DEFAULT_PRICING.color)),
    currency: raw.currency || DEFAULT_PRICING.currency,
    maxCopies: Math.max(1, intOr(raw.maxCopies, DEFAULT_PRICING.maxCopies)),
  };
}

async function loadLimits(rtdb) {
  const raw = (await rtdb.get('config/limits')) || {};
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_LIMITS)) out[k] = intOr(raw[k], v);
  return out;
}

/** price = pages × copies × unit. Integer taka. */
function priceJob({ pages, copies, color, pricing }) {
  const p = Math.max(1, intOr(pages, 1));
  const c = Math.max(1, intOr(copies, 1));
  const unit = color ? pricing.color : pricing.mono;
  return { unitPrice: unit, price: p * c * unit, pages: p, copies: c };
}

// ---------------------------------------------------------------------------
// the one primitive every money movement goes through
// ---------------------------------------------------------------------------
function normalizeWallet(w) {
  return {
    balance: Math.max(0, intOr(w && w.balance, 0)),
    reserved: Math.max(0, intOr(w && w.reserved, 0)),
    applied: (w && w.applied) || {},
  };
}

function available(wallet) {
  const w = normalizeWallet(wallet);
  return Math.max(0, w.balance - w.reserved);
}

function pruneApplied(applied, now) {
  const entries = Object.entries(applied).filter(([, ts]) => now - Number(ts) < APPLIED_TTL_MS);
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return Object.fromEntries(entries.slice(0, APPLIED_MAX));
}

/**
 * Compare-and-swap a wallet, exactly once per opId.
 *
 * `mutate(wallet)` returns `{ balance, reserved }` for the new state, or throws a
 * LedgerError to refuse (insufficient funds). Returning `null` means "nothing to
 * do" and commits nothing.
 *
 * @returns {Promise<{applied: boolean, wallet: {balance,reserved}, available: number}>}
 */
async function applyToWallet(rtdb, uid, opId, mutate) {
  if (!uid) throw new LedgerError('Missing user.', 400);
  if (!opId) throw new LedgerError('Missing operation id.', 500);

  let alreadyApplied = false;
  let refused = null;

  const result = await rtdb.transaction(`wallets/${uid}`, (current) => {
    const w = normalizeWallet(current);

    // The replay guard. Same node, same CAS as the numbers themselves.
    if (Object.prototype.hasOwnProperty.call(w.applied, opId)) {
      alreadyApplied = true;
      return undefined; // abort, commit nothing
    }

    let next;
    try {
      next = mutate({ balance: w.balance, reserved: w.reserved });
    } catch (err) {
      refused = err;
      return undefined;
    }
    if (!next) return undefined;

    const now = Date.now();
    const balance = Math.max(0, Math.round(next.balance));
    const reserved = Math.max(0, Math.round(next.reserved));
    return {
      balance,
      reserved,
      updatedAt: now,
      applied: { ...pruneApplied(w.applied, now), [opId]: now },
    };
  });

  if (refused) throw refused;

  const wallet = normalizeWallet(result.value);
  return {
    applied: result.committed,
    alreadyApplied,
    wallet: { balance: wallet.balance, reserved: wallet.reserved },
    available: Math.max(0, wallet.balance - wallet.reserved),
  };
}

/** Ledger rows are the audit trail. Deterministic id => safe to re-write. */
async function writeLedger(rtdb, uid, id, entry) {
  await rtdb.put(`ledger/${uid}/${id}`, {
    createdAt: Date.now(),
    ...entry,
  });
  return id;
}

// ---------------------------------------------------------------------------
// hold / settle / release
// ---------------------------------------------------------------------------

/**
 * Reserve funds for a job that has not been sent to UprintBD yet.
 * Refuses with HTTP 402 and the available balance when there isn't enough.
 */
async function hold(rtdb, uid, jobId, price) {
  const amount = Math.max(0, Math.round(price));
  if (!amount) throw new LedgerError('Nothing to charge for.', 400);

  return applyToWallet(rtdb, uid, `hold_${jobId}`, (w) => {
    const avail = w.balance - w.reserved;
    if (avail < amount) {
      throw new LedgerError('Not enough DDB balance for this print.', 402, {
        code: 'INSUFFICIENT_BALANCE',
        required: amount,
        available: Math.max(0, avail),
        balance: w.balance,
        reserved: w.reserved,
      });
    }
    return { balance: w.balance, reserved: w.reserved + amount };
  });
}

/**
 * The print happened. Convert the hold into a real charge.
 * `actualCost` / `deviceId` come from UprintBD's own history row and are stored
 * for margin reporting — they never affect what the user pays.
 */
async function settle(rtdb, uid, job, { actualCost = null, deviceId = '', historyAt = '' } = {}) {
  const amount = Math.max(0, Math.round(job.price));
  const res = await applyToWallet(rtdb, uid, `settle_${job.id}`, (w) => ({
    balance: w.balance - amount,
    reserved: w.reserved - amount,
  }));

  // Written unconditionally: if a previous attempt moved the money but died
  // before recording it, this repairs the audit trail instead of skipping it.
  await writeLedger(rtdb, uid, `chg_${job.id}`, {
    type: 'charge',
    amount: -amount,
    balanceAfter: res.wallet.balance,
    jobId: job.id,
    note: `Print ${job.pages}p × ${job.copies} ${job.color ? 'colour' : 'b/w'}`,
    filename: job.filename || '',
  });

  await rtdb.patch(`jobs/${uid}/${job.id}`, {
    status: 'printed',
    settledAt: Date.now(),
    actualCost,
    deviceId,
    printedAt: historyAt || '',
  });
  await rtdb.remove(`openJobs/${job.id}`);

  return res;
}

/**
 * The OTP was never used (or the job failed before it existed). Give the money
 * back. No ledger row: nothing was ever charged, and a student's history should
 * not fill up with entries for prints that did not happen.
 */
async function release(rtdb, uid, job, status = 'expired', reason = '') {
  const amount = Math.max(0, Math.round(job.price));
  const res = await applyToWallet(rtdb, uid, `release_${job.id}`, (w) => ({
    balance: w.balance,
    reserved: w.reserved - amount,
  }));

  await rtdb.patch(`jobs/${uid}/${job.id}`, {
    status,
    releasedAt: Date.now(),
    reason: reason || '',
  });
  await rtdb.remove(`openJobs/${job.id}`);

  return res;
}

// ---------------------------------------------------------------------------
// admin money movements
// ---------------------------------------------------------------------------

/** Project admin credits a wallet after receiving bKash out of band. */
async function topUp(rtdb, uid, amount, { note = '', byUid = '', method = 'bKash' } = {}) {
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new LedgerError('Top-up amount must be a positive whole number of taka.', 400);
  }
  const id = newLedgerId('top');
  const res = await applyToWallet(rtdb, uid, id, (w) => ({
    balance: w.balance + amt,
    reserved: w.reserved,
  }));
  await writeLedger(rtdb, uid, id, {
    type: 'topup',
    amount: amt,
    balanceAfter: res.wallet.balance,
    method,
    note,
    byUid,
  });
  return { ...res, ledgerId: id };
}

/** Manual correction or goodwill refund. Signed: negative takes money back. */
async function adjust(rtdb, uid, delta, { note = '', byUid = '', type = 'adjustment' } = {}) {
  const amt = Math.round(Number(delta));
  if (!Number.isFinite(amt) || amt === 0) {
    throw new LedgerError('Adjustment must be a non-zero whole number of taka.', 400);
  }
  const id = newLedgerId(type === 'refund' ? 'ref' : 'adj');
  const res = await applyToWallet(rtdb, uid, id, (w) => {
    if (w.balance + amt < 0) {
      throw new LedgerError('That adjustment would take the balance below zero.', 400, {
        balance: w.balance,
      });
    }
    return { balance: w.balance + amt, reserved: w.reserved };
  });
  await writeLedger(rtdb, uid, id, {
    type,
    amount: amt,
    balanceAfter: res.wallet.balance,
    note,
    byUid,
  });
  return { ...res, ledgerId: id };
}

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

/**
 * A user's most recent jobs.
 *
 * The indexed query needs `.indexOn: "createdAt"` under `jobs/$uid` in the rules.
 * If that index is missing the REST API answers 400 — and this read sits in front
 * of every hold, so an undeployed rules file would block printing entirely. Hence
 * the fallback: read the node whole. A user has tens of jobs, not thousands.
 */
async function recentJobs(rtdb, uid, limitToLast = 40) {
  let raw = null;
  try {
    raw = await rtdb.get(`jobs/${uid}`, { orderBy: '"createdAt"', limitToLast });
  } catch (err) {
    if (!/index/i.test(String(err && err.message))) throw err;
    raw = await rtdb.get(`jobs/${uid}`);
  }
  const jobs = Object.entries(raw || {}).map(([id, j]) => ({ id, ...j }));
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.slice(0, limitToLast);
}

/**
 * Brakes that protect the institutional account, checked before a hold.
 * Every mint spends real money at UprintBD even when nothing prints, so an
 * unbounded loop of mints is expensive regardless of the wallet.
 */
async function checkLimits(rtdb, uid, { limits, pages, copies, pricing, clientJobId }) {
  if (pages > limits.maxPagesPerJob) {
    throw new LedgerError(
      `That document is ${pages} pages; the limit is ${limits.maxPagesPerJob} per job.`,
      400
    );
  }
  if (copies > pricing.maxCopies) {
    throw new LedgerError(`You can print at most ${pricing.maxCopies} copies at once.`, 400);
  }

  const jobs = await recentJobs(rtdb, uid, 40);
  const hourAgo = Date.now() - 3600 * 1000;

  // A retried POST (flaky network, double tap) must not mint a second OTP.
  // Only jobs that still hold a code, or already printed, count as duplicates: a
  // mint that failed outright left nothing behind, and refusing that retry would
  // strand the user for ten minutes with no code and no explanation.
  if (clientJobId) {
    const dupe = jobs.find(
      (j) =>
        j.clientJobId === clientJobId &&
        (j.status === 'reserving' || j.status === 'reserved' || j.status === 'printed') &&
        Date.now() - (j.createdAt || 0) < 10 * 60 * 1000
    );
    if (dupe) {
      throw new LedgerError('This print was already submitted.', 409, {
        code: 'DUPLICATE',
        jobId: dupe.id,
      });
    }
  }

  const openHolds = jobs.filter((j) => j.status === 'reserved' || j.status === 'reserving').length;
  if (openHolds >= limits.maxOpenHolds) {
    throw new LedgerError(
      `You already have ${openHolds} unused kiosk code${openHolds === 1 ? '' : 's'}. ` +
        `Print or let ${openHolds === 1 ? 'it' : 'one'} expire before making another.`,
      429,
      { code: 'TOO_MANY_HOLDS' }
    );
  }

  const lastHour = jobs.filter((j) => (j.createdAt || 0) > hourAgo).length;
  if (lastHour >= limits.maxJobsPerHour) {
    throw new LedgerError('Too many prints in the last hour. Please try again later.', 429, {
      code: 'RATE_LIMITED',
    });
  }

  return { openHolds, lastHour };
}

module.exports = {
  LedgerError,
  DEFAULT_PRICING,
  DEFAULT_LIMITS,
  loadPricing,
  loadLimits,
  priceJob,
  available,
  normalizeWallet,
  applyToWallet,
  writeLedger,
  hold,
  settle,
  release,
  topUp,
  adjust,
  checkLimits,
  recentJobs,
  newJobId,
  newLedgerId,
  uniqueFilename,
  fileKey,
  randomChars,
};
