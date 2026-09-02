/**
 * lib/domain/wallet.js — Authoritative wallet & ledger domain logic.
 * -----------------------------------------------------------------------------
 * Enforces financial correctness:
 *   - available = balance - reserved
 *   - Integer taka only (no floating point calculations)
 *   - Replay prevention via atomic applied[opId] tracking
 *   - Non-negative balances and overdraw refusal (INV-5)
 */

'use strict';

const { LedgerError } = require('./errors.js');

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
const APPLIED_TTL_MS = 24 * 60 * 60 * 1000;
const APPLIED_MAX = 100;

function randomChars(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

function newJobId() {
  return Date.now().toString(36) + randomChars(6);
}

function newLedgerId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomChars(4)}`;
}

/**
 * INVARIANT INV-9: Server-generated unique filename as the settlement join key.
 * stem + '_' + last 6 chars of jobId in uppercase + '.pdf'
 */
function uniqueFilename(baseName, jobId) {
  const stem = String(baseName || 'Document')
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 90);
  return `${stem}_${String(jobId || '').slice(-6).toUpperCase()}.pdf`;
}

/**
 * Strip invalid Firebase Realtime Database path characters (. $ # [ ] /)
 */
function fileKey(filename) {
  return String(filename || '').replace(/[.$#[\]/]/g, '_');
}

/**
 * INVARIANT INV-4: Whole integer taka only.
 */
function toIntegerTaka(val, fallback = 0) {
  const n = Number(val);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.round(n);
}

/**
 * Calculate available balance.
 */
function calculateAvailable(wallet) {
  if (!wallet) return 0;
  const balance = toIntegerTaka(wallet.balance, 0);
  const reserved = toIntegerTaka(wallet.reserved, 0);
  return Math.max(0, balance - reserved);
}

/**
 * INVARIANT INV-19: Prune expired applied keys without silent eviction while live.
 */
function pruneApplied(applied, ttlMs = APPLIED_TTL_MS, maxCount = APPLIED_MAX) {
  if (!applied || typeof applied !== 'object') return {};
  const out = {};
  const cutoff = Date.now() - ttlMs;
  const entries = Object.entries(applied).filter(([, ts]) => Number(ts) > cutoff);

  // If still above max, keep the most recent
  if (entries.length > maxCount) {
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    entries.length = maxCount;
  }

  for (const [k, v] of entries) {
    out[k] = v;
  }
  return out;
}

class Wallet {
  constructor(data = {}) {
    this.balance = toIntegerTaka(data.balance, 0);
    this.reserved = Math.max(0, toIntegerTaka(data.reserved, 0));
    this.applied = data.applied && typeof data.applied === 'object' ? { ...data.applied } : {};
    this.updatedAt = data.updatedAt ? Number(data.updatedAt) : Date.now();
  }

  get available() {
    return Math.max(0, this.balance - this.reserved);
  }

  hasApplied(opId) {
    return !!(this.applied && this.applied[opId]);
  }

  markApplied(opId, timestamp = Date.now()) {
    this.applied[opId] = timestamp;
    this.applied = pruneApplied(this.applied);
    this.updatedAt = timestamp;
  }

  /**
   * INVARIANT INV-5: Hold funds against available balance. Refuses overdraw.
   */
  hold(jobId, price) {
    const opId = `hold_${jobId}`;
    if (this.hasApplied(opId)) {
      return { committed: false, alreadyApplied: true };
    }
    const cost = toIntegerTaka(price, 0);
    if (cost < 0) {
      throw new LedgerError('Hold price cannot be negative.', 400);
    }
    if (this.available < cost) {
      throw new LedgerError(
        `Insufficient balance. That print costs ${cost} Tk, but you have ${this.available} Tk available.`,
        402,
        {
          code: 'INSUFFICIENT_BALANCE',
          required: cost,
          available: this.available,
          balance: this.balance,
          reserved: this.reserved,
        }
      );
    }

    this.reserved += cost;
    this.markApplied(opId);
    return { committed: true, alreadyApplied: false };
  }

  /**
   * INVARIANT INV-1 & INV-2: Settle printed job.
   */
  settle(jobId, price) {
    const opId = `settle_${jobId}`;
    if (this.hasApplied(opId)) {
      return { committed: false, alreadyApplied: true };
    }
    const cost = toIntegerTaka(price, 0);
    this.balance -= cost;
    this.reserved = Math.max(0, this.reserved - cost);
    this.markApplied(opId);
    return { committed: true, alreadyApplied: false };
  }

  /**
   * INVARIANT INV-1: Release reservation for unprinted / expired / cancelled job.
   */
  release(jobId, price) {
    const opId = `release_${jobId}`;
    if (this.hasApplied(opId)) {
      return { committed: false, alreadyApplied: true };
    }
    const cost = toIntegerTaka(price, 0);
    this.reserved = Math.max(0, this.reserved - cost);
    this.markApplied(opId);
    return { committed: true, alreadyApplied: false };
  }

  /**
   * Top up wallet balance.
   */
  topUp(opId, amount) {
    if (this.hasApplied(opId)) {
      return { committed: false, alreadyApplied: true };
    }
    const delta = toIntegerTaka(amount, 0);
    if (delta <= 0) {
      throw new LedgerError('Top-up amount must be a positive integer.', 400);
    }
    this.balance += delta;
    this.markApplied(opId);
    return { committed: true, alreadyApplied: false };
  }

  /**
   * Adjust wallet balance (+ or -).
   */
  adjust(opId, delta) {
    if (this.hasApplied(opId)) {
      return { committed: false, alreadyApplied: true };
    }
    const change = toIntegerTaka(delta, 0);
    if (change === 0) {
      throw new LedgerError('Adjustment amount cannot be zero.', 400);
    }
    if (this.balance + change < 0) {
      throw new LedgerError(
        `Cannot adjust balance below zero. Current: ${this.balance} Tk, requested: ${change} Tk.`,
        400
      );
    }
    this.balance += change;
    this.markApplied(opId);
    return { committed: true, alreadyApplied: false };
  }

  toObject() {
    return {
      balance: this.balance,
      reserved: this.reserved,
      applied: { ...this.applied },
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = {
  Wallet,
  calculateAvailable,
  toIntegerTaka,
  pruneApplied,
  newJobId,
  newLedgerId,
  uniqueFilename,
  fileKey,
  APPLIED_TTL_MS,
  APPLIED_MAX,
};
