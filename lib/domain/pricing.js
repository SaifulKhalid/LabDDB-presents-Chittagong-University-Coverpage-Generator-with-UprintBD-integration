/**
 * lib/domain/pricing.js — Pricing determination, PDF page counting & quota limits.
 * -----------------------------------------------------------------------------
 * Enforces:
 *   - Server-side page counting directly from PDF bytes (INV-11)
 *   - Historical price snapshotting onto jobs
 *   - Volume, rate, and duplicate submission limits
 */

'use strict';

const { LedgerError } = require('./errors.js');

const DEFAULT_PRICING = Object.freeze({
  mono: 3,
  color: 5,
  currency: 'BDT',
  maxCopies: 10,
});

const DEFAULT_LIMITS = Object.freeze({
  maxOpenHolds: 3,        // simultaneous unprinted OTPs per student
  maxJobsPerHour: 20,     // abuse brake
  maxPagesPerJob: 20,     // maximum pages per print job
  minTopUp: 5,            // minimum top-up in Tk
  maxTopUp: 2000,         // maximum top-up in Tk
  holdGraceSeconds: 300,  // extra grace period past OTP expiry before release
});

/**
 * INVARIANT INV-11: Count pages server-side from raw PDF bytes.
 * Never trust a client-supplied page count.
 */
function countPdfPages(bytes) {
  if (!bytes || !bytes.length) return 1;
  try {
    // Decode with latin1 to keep 1:1 byte mapping for binary streams
    let text;
    if (typeof Buffer !== 'undefined') {
      text = Buffer.from(bytes).toString('latin1');
    } else {
      text = new TextDecoder('latin1').decode(bytes);
    }

    // Check for explicit /Count N on page trees
    const countMatches = text.match(/\/Count\s+(\d+)/g);
    if (countMatches && countMatches.length) {
      let max = 0;
      for (const m of countMatches) {
        const val = parseInt(m.replace(/\/Count\s+/, ''), 10);
        if (Number.isFinite(val) && val > max) max = val;
      }
      if (max > 0) return max;
    }

    // Fallback: count /Type /Page objects (distinct from /Type /Pages)
    const pageMatches = text.match(/\/Type\s*\/Page\b/g);
    if (pageMatches && pageMatches.length) {
      return pageMatches.length;
    }
  } catch (_) {
    // Degrade safely to 1
  }
  return 1;
}

/**
 * Calculate the authoritative cost of a print job.
 */
function priceJob({ pages, copies, color, pricing } = {}) {
  const p = Object.assign({}, DEFAULT_PRICING, pricing || {});

  const rawPages = Number(pages);
  const safePages =
    !Number.isFinite(rawPages) || rawPages <= 0 ? 1 : Math.round(rawPages);

  const rawCopies = Number(copies);
  const safeCopies =
    !Number.isFinite(rawCopies) || rawCopies <= 0 ? 1 : Math.round(rawCopies);

  const unitPrice = color ? p.color : p.mono;
  const price = safePages * safeCopies * unitPrice;

  return {
    price,
    unitPrice,
    pages: safePages,
    copies: safeCopies,
    color: !!color,
    currency: p.currency || 'BDT',
  };
}

/**
 * Check limits and return structured errors when exceeded.
 */
function checkLimits({ limits, pages, copies, activeHoldsCount = 0, recentJobsCount = 0, clientJobId = null, existingDuplicateJob = null } = {}) {
  const l = Object.assign({}, DEFAULT_LIMITS, limits || {});

  if (pages > l.maxPagesPerJob) {
    throw new LedgerError(
      `That document has ${pages} pages. The maximum per job is ${l.maxPagesPerJob}.`,
      400
    );
  }

  const maxCopies = limits && limits.maxCopies ? limits.maxCopies : DEFAULT_PRICING.maxCopies;
  if (copies > maxCopies) {
    throw new LedgerError(
      `You requested ${copies} copies. The maximum is ${maxCopies}.`,
      400
    );
  }

  // Duplicate submission protection: if clientJobId is active within 10 min
  if (existingDuplicateJob) {
    const isRecent = Date.now() - Number(existingDuplicateJob.createdAt || 0) < 10 * 60 * 1000;
    const isPending =
      existingDuplicateJob.status === 'reserving' ||
      existingDuplicateJob.status === 'reserved' ||
      existingDuplicateJob.status === 'printed';

    if (isRecent && isPending) {
      throw new LedgerError(
        'That print request was already sent. You can view your kiosk codes below.',
        409,
        {
          code: 'DUPLICATE',
          jobId: existingDuplicateJob.id || existingDuplicateJob.jobId,
        }
      );
    }
  }

  if (activeHoldsCount >= l.maxOpenHolds) {
    throw new LedgerError(
      `You already have ${activeHoldsCount} active kiosk codes waiting to be printed. ` +
        `Please print or cancel one before creating another.`,
      429,
      { code: 'TOO_MANY_HOLDS', openCount: activeHoldsCount, limit: l.maxOpenHolds }
    );
  }

  if (recentJobsCount >= l.maxJobsPerHour) {
    throw new LedgerError(
      `Hourly limit reached (${l.maxJobsPerHour} prints/hour). Please wait before trying again.`,
      429,
      { code: 'RATE_LIMITED', limit: l.maxJobsPerHour }
    );
  }

  return true;
}

module.exports = {
  DEFAULT_PRICING,
  DEFAULT_LIMITS,
  countPdfPages,
  priceJob,
  checkLimits,
};
