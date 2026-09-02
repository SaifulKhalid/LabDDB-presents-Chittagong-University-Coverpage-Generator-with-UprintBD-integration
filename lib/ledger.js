/**
 * lib/ledger.js — Facade for domain wallet and wallet application service.
 * -----------------------------------------------------------------------------
 * Bridges legacy call sites directly to the domain and service layers while
 * maintaining 100% backward compatibility for all existing tests and imports.
 */

'use strict';

const {
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
} = require('./domain/wallet.js');

const { LedgerError } = require('./domain/errors.js');
const { DEFAULT_PRICING, DEFAULT_LIMITS, priceJob, checkLimits: domainCheckLimits } = require('./domain/pricing.js');
const { applyToWallet, WalletService } = require('./services/wallet-service.js');

function normalizeWallet(w) {
  return {
    balance: Math.max(0, toIntegerTaka(w && w.balance, 0)),
    reserved: Math.max(0, toIntegerTaka(w && w.reserved, 0)),
    applied: (w && w.applied) || {},
  };
}

function available(wallet) {
  const w = normalizeWallet(wallet);
  return Math.max(0, w.balance - w.reserved);
}

async function writeLedger(rtdb, uid, id, entry) {
  await rtdb.put(`ledger/${uid}/${id}`, entry);
}

async function hold(rtdb, uid, jobId, price) {
  const service = new WalletService(rtdb);
  return service.hold(uid, jobId, price);
}

async function settle(rtdb, uid, job, opts = {}) {
  const service = new WalletService(rtdb);
  return service.settle(uid, job, opts);
}

async function release(rtdb, uid, job, status = 'expired', reason = null) {
  const service = new WalletService(rtdb);
  return service.release(uid, job, status, reason);
}

async function topUp(rtdb, uid, amount, opts = {}) {
  const service = new WalletService(rtdb);
  return service.topUp(uid, amount, opts);
}

async function adjust(rtdb, uid, delta, opts = {}) {
  const service = new WalletService(rtdb);
  return service.adjust(uid, delta, opts);
}

async function loadPricing(rtdb) {
  const service = new WalletService(rtdb);
  return service.loadPricing();
}

async function loadLimits(rtdb) {
  const service = new WalletService(rtdb);
  return service.loadLimits();
}

async function recentJobs(rtdb, uid, limit = 25) {
  const service = new WalletService(rtdb);
  return service.getRecentJobs(uid, limit);
}

async function checkLimits(rtdb, uid, { limits, pages, copies, pricing, clientJobId } = {}) {
  const [userJobs, openJobs] = await Promise.all([
    rtdb.get(`jobs/${uid}`),
    rtdb.get('openJobs'),
  ]);

  let activeHoldsCount = 0;
  if (openJobs && typeof openJobs === 'object') {
    activeHoldsCount = Object.values(openJobs).filter((j) => j && j.uid === uid).length;
  }

  let recentJobsCount = 0;
  let existingDuplicateJob = null;
  const oneHourAgo = Date.now() - 3600 * 1000;

  if (userJobs && typeof userJobs === 'object') {
    for (const j of Object.values(userJobs)) {
      if (!j) continue;
      if (Number(j.createdAt || 0) > oneHourAgo) {
        recentJobsCount++;
      }
      if (clientJobId && j.clientJobId === clientJobId) {
        existingDuplicateJob = j;
      }
    }
  }

  return domainCheckLimits({
    limits,
    pages,
    copies,
    activeHoldsCount,
    recentJobsCount,
    clientJobId,
    existingDuplicateJob,
  });
}

module.exports = {
  LedgerError,
  DEFAULT_PRICING,
  DEFAULT_LIMITS,
  APPLIED_TTL_MS,
  APPLIED_MAX,
  newJobId,
  newLedgerId,
  uniqueFilename,
  fileKey,
  available,
  pruneApplied,
  applyToWallet,
  hold,
  settle,
  release,
  topUp,
  adjust,
  loadPricing,
  loadLimits,
  recentJobs,
  priceJob,
  checkLimits,
  normalizeWallet,
  writeLedger,
};
