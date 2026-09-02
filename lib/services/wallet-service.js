/**
 * lib/services/wallet-service.js — Financial ledger application service.
 * -----------------------------------------------------------------------------
 * Orchestrates wallet mutations via Compare-And-Swap (CAS) against Firebase RTDB.
 * Enforces exactly-once execution, idempotency, and double-entry consistency.
 */

'use strict';

const { Wallet, pruneApplied, calculateAvailable, newLedgerId, newJobId, uniqueFilename, fileKey } = require('../domain/wallet.js');
const { LedgerError, ConflictError } = require('../domain/errors.js');
const { DEFAULT_PRICING, DEFAULT_LIMITS, priceJob, checkLimits } = require('../domain/pricing.js');

const WALLETS_PATH = 'wallets';
const LEDGER_PATH = 'ledger';
const JOBS_PATH = 'jobs';
const OPEN_JOBS_PATH = 'openJobs';

/**
 * Apply a mutation function to a user's wallet with CAS (ETag) concurrency control.
 *
 * @param {object} rtdb
 * @param {string} uid
 * @param {string} opId
 * @param {(wallet: Wallet) => Wallet|undefined} mutateFn
 * @param {object} [opts]
 * @returns {Promise<{ committed: boolean, alreadyApplied: boolean, wallet: object, available: number }>}
 */
async function applyToWallet(rtdb, uid, opId, mutateFn, { retries = 6 } = {}) {
  const path = `${WALLETS_PATH}/${uid}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { value: rawWallet, etag } = await rtdb.getWithEtag(path);
    const wallet = new Wallet(rawWallet || {});

    // Replay guard: if already applied, return immediately without writing
    if (wallet.hasApplied(opId)) {
      return {
        committed: false,
        applied: false,
        alreadyApplied: true,
        wallet: wallet.toObject(),
        available: wallet.available,
      };
    }

    // Run the domain mutation
    const mutated = mutateFn(wallet);
    if (mutated === undefined) {
      return {
        committed: false,
        applied: false,
        alreadyApplied: false,
        wallet: wallet.toObject(),
        available: wallet.available,
      };
    }

    try {
      await rtdb.put(path, mutated.toObject(), { etag: etag || undefined });
      return {
        committed: true,
        applied: true,
        alreadyApplied: false,
        wallet: mutated.toObject(),
        available: mutated.available,
      };
    } catch (err) {
      if (err.name !== 'ConflictError' && !(err instanceof ConflictError)) {
        throw err;
      }
      lastErr = err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + attempt * 7));
    }
  }

  throw new LedgerError('Could not update the wallet due to concurrent modifications. Please try again.', 500);
}

class WalletService {
  constructor(rtdb) {
    this.rtdb = rtdb;
  }

  async getWallet(uid) {
    const raw = await this.rtdb.get(`${WALLETS_PATH}/${uid}`);
    const wallet = new Wallet(raw || {});
    return {
      balance: wallet.balance,
      reserved: wallet.reserved,
      available: wallet.available,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * INVARIANT INV-10: Place hold on funds before contacting print provider.
   */
  async hold(uid, jobId, price) {
    const opId = `hold_${jobId}`;
    return applyToWallet(this.rtdb, uid, opId, (wallet) => {
      wallet.hold(jobId, price);
      return wallet;
    });
  }

  /**
   * INVARIANT INV-1: Settle printed job.
   */
  async settle(uid, job, { actualCost, deviceId, historyAt } = {}) {
    const opId = `settle_${job.id}`;
    const res = await applyToWallet(this.rtdb, uid, opId, (wallet) => {
      wallet.settle(job.id, job.price);
      return wallet;
    });

    const now = Date.now();
    // Append-only ledger charge row
    const chargeRow = {
      id: `chg_${job.id}`,
      type: 'charge',
      amount: -Math.round(job.price),
      balanceAfter: res.wallet.balance,
      jobId: job.id,
      filename: job.filename,
      actualCost: actualCost != null ? Number(actualCost) : null,
      deviceId: deviceId || null,
      printedAt: historyAt || null,
      at: now,
    };
    await this.rtdb.put(`${LEDGER_PATH}/${uid}/${chargeRow.id}`, chargeRow);

    // Patch job status to printed
    await this.rtdb.patch(`${JOBS_PATH}/${uid}/${job.id}`, {
      status: 'printed',
      settledAt: now,
      actualCost: actualCost != null ? Number(actualCost) : null,
      deviceId: deviceId || null,
      printedAt: historyAt || null,
    });

    // Remove from openJobs active working set
    await this.rtdb.remove(`${OPEN_JOBS_PATH}/${job.id}`);
    return res;
  }

  /**
   * INVARIANT INV-1 & INV-16: Release unused or failed reservation.
   * Failed mints/holds write NO ledger row.
   */
  async release(uid, job, status, reason) {
    const opId = `release_${job.id}`;
    const res = await applyToWallet(this.rtdb, uid, opId, (wallet) => {
      wallet.release(job.id, job.price);
      return wallet;
    });

    const now = Date.now();
    await this.rtdb.patch(`${JOBS_PATH}/${uid}/${job.id}`, {
      status: status || 'expired',
      releasedAt: now,
      reason: reason || null,
    });

    await this.rtdb.remove(`${OPEN_JOBS_PATH}/${job.id}`);
    return res;
  }

  /**
   * Admin top-up crediting student balance.
   */
  async topUp(uid, amount, { note, byUid, method = 'bKash' } = {}) {
    const opId = newLedgerId('top');
    const res = await applyToWallet(this.rtdb, uid, opId, (wallet) => {
      wallet.topUp(opId, amount);
      return wallet;
    });

    const now = Date.now();
    const entry = {
      id: opId,
      type: 'topup',
      amount: Math.round(amount),
      balanceAfter: res.wallet.balance,
      method,
      byUid: byUid || 'admin',
      note: note || '',
      at: now,
    };
    await this.rtdb.put(`${LEDGER_PATH}/${uid}/${opId}`, entry);
    return { ...res, entry };
  }

  /**
   * Admin balance adjustment.
   */
  async adjust(uid, delta, { note, byUid, type = 'adjustment' } = {}) {
    const prefix = delta >= 0 ? 'ref' : 'adj';
    const opId = newLedgerId(prefix);
    const res = await applyToWallet(this.rtdb, uid, opId, (wallet) => {
      wallet.adjust(opId, delta);
      return wallet;
    });

    const now = Date.now();
    const entry = {
      id: opId,
      type: delta >= 0 ? 'refund' : type,
      amount: Math.round(delta),
      balanceAfter: res.wallet.balance,
      byUid: byUid || 'admin',
      note: note || '',
      at: now,
    };
    await this.rtdb.put(`${LEDGER_PATH}/${uid}/${opId}`, entry);
    return { ...res, entry };
  }

  async loadPricing() {
    const raw = await this.rtdb.get('config/pricing');
    return Object.assign({}, DEFAULT_PRICING, raw || {});
  }

  async loadLimits() {
    const raw = await this.rtdb.get('config/limits');
    return Object.assign({}, DEFAULT_LIMITS, raw || {});
  }

  async getRecentJobs(uid, limit = 25) {
    const raw = (await this.rtdb.get(`${JOBS_PATH}/${uid}`)) || {};
    const jobs = Object.values(raw);
    jobs.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return jobs.slice(0, limit);
  }
}

module.exports = {
  applyToWallet,
  WalletService,
  uniqueFilename,
  fileKey,
  newJobId,
  newLedgerId,
  priceJob,
  checkLimits,
};
