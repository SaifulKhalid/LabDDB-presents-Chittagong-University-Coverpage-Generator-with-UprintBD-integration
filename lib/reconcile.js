/**
 * reconcile.js — decides, after the fact, who actually printed.
 * -----------------------------------------------------------------------------
 * Holds are placed when an OTP is minted; nothing is charged there. This engine
 * is what closes them, and it is the only place a user's balance ever drops.
 *
 * It trusts exactly one source: UprintBD's own /uprint/print_history/. A row with
 * `Print Status: Completed` means paper came out of a printer. Anything else —
 * an OTP that sat unused, a kiosk that was offline, a student who changed their
 * mind — ends in a release, and the student keeps their money.
 *
 * Two orderings in here are load-bearing:
 *
 *   1. Settle before expire. A job can be past its expiry AND printed (the
 *      history row lands a moment after the code was used). Checking history
 *      first means we never release money for a page that was printed.
 *
 *   2. Delete the UprintBD record BEFORE releasing the hold. Reversed, there is a
 *      window where the OTP still works at a kiosk but we have already given the
 *      money back — the institution eats the cost. Deleting first closes it, and
 *      if the delete fails we simply keep the hold and retry next cycle.
 *
 * Runs from a Cron Trigger every minute, and lazily on /api/print when the last
 * run is stale, so a broken cron can never permanently lock a student's funds.
 */

'use strict';

const ledger = require('./ledger.js');
const auditLogger = require('./audit-logger.js');

const LOCK_PATH = 'admin/uprint/lock';
const STATE_PATH = 'admin/uprint';
const LOCK_TTL_MS = 90 * 1000;

/** How stale the last run may be before /api/print reconciles inline. */
const STALE_AFTER_MS = 3 * 60 * 1000;

async function isStale(rtdb) {
  const last = await rtdb.get(`${STATE_PATH}/lastReconcileAt`);
  return !last || Date.now() - Number(last) > STALE_AFTER_MS;
}

/**
 * Take a short lease so the cron trigger and an inline call cannot process the
 * same job twice. Not strictly required — every wallet mutation is idempotent by
 * opId — but it saves duplicated scraping of the live site.
 */
async function acquireLock(rtdb, owner) {
  const res = await rtdb.transaction(LOCK_PATH, (current) => {
    if (current && current.at && Date.now() - Number(current.at) < LOCK_TTL_MS) {
      return undefined; // someone else holds it
    }
    return { at: Date.now(), owner };
  });
  return res.committed;
}

async function releaseLock(rtdb) {
  try {
    await rtdb.remove(LOCK_PATH);
  } catch (_) {
    /* the TTL will clear it */
  }
}

/** Normalize a print_history filename for comparison. */
function normName(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * @param {object} deps { rtdb, session }
 * @param {object} [opts] { force, reason }
 * @returns {Promise<object>} a summary suitable for the admin console
 */
async function reconcile({ rtdb, session }, opts = {}) {
  const startedAt = Date.now();
  const summary = {
    startedAt,
    ranAt: startedAt,
    reason: opts.reason || 'cron',
    openJobs: 0,
    settled: 0,
    released: 0,
    failedDeletes: 0,
    unmatched: 0,
    skipped: false,
    errors: [],
  };

  const owner = opts.reason || 'cron';
  if (!opts.force && !(await acquireLock(rtdb, owner))) {
    summary.skipped = true;
    summary.note = 'Another reconcile pass is already running.';
    return summary;
  }

  try {
    const openJobs = (await rtdb.get('openJobs')) || {};
    const entries = Object.entries(openJobs).map(([id, j]) => ({ id, ...j }));
    summary.openJobs = entries.length;

    const limits = await ledger.loadLimits(rtdb);
    const graceMs = Math.max(0, limits.holdGraceSeconds) * 1000;

    // Always refresh the institutional balance — it is the single number that
    // tells the admin whether the whole service is about to stop working.
    try {
      const bal = await session.getAccountBalance();
      if (bal !== null) summary.accountBalance = bal;
    } catch (err) {
      summary.errors.push(`balance: ${err.message}`);
    }

    if (!entries.length) {
      await writeState(rtdb, summary);
      return summary;
    }

    // Ask history only as far back as the oldest thing we are still waiting on.
    const oldest = entries.reduce(
      (min, j) => Math.min(min, Number(j.createdAt) || startedAt),
      startedAt
    );
    let history = [];
    try {
      history = await session.getPrintHistory({ sinceMs: oldest - 24 * 3600 * 1000 });
    } catch (err) {
      // Without history we cannot settle anything, and we must not expire
      // anything either — a printed job would look unprinted. Bail out.
      summary.errors.push(`print_history: ${err.message}`);
      summary.note = 'Could not read print history; holds left untouched.';
      await writeState(rtdb, summary);
      return summary;
    }

    const completed = new Map();
    for (const row of history) {
      if (!/complete/i.test(row.status)) continue;
      // Keep the earliest Completed row per filename.
      const key = normName(row.filename);
      if (!completed.has(key)) completed.set(key, row);
    }

    let queued = null;
    const getQueued = async () => {
      if (queued) return queued;
      try {
        queued = await session.getQueuedRecordIds();
      } catch (err) {
        summary.errors.push(`dashboard: ${err.message}`);
        queued = new Set();
      }
      return queued;
    };

    for (const job of entries) {
      try {
        const row = completed.get(normName(job.filename));

        // ---- 1. It printed. Charge for it. -----------------------------------
        if (row) {
          const settleRes = await ledger.settle(rtdb, job.uid, job, {
            actualCost: row.cost,
            deviceId: row.deviceId,
            historyAt: row.dateTime,
          });
          summary.settled++;
          auditLogger.scheduleTask(deps, auditLogger.updatePrintJobStatus(deps, job.id, {
            status: 'printed',
            actualCost: row.cost,
            deviceId: row.deviceId,
            settledAt: Date.now(),
          }));
          auditLogger.scheduleTask(deps, auditLogger.logLedgerTx(deps, {
            id: `chg_${job.id}`,
            uid: job.uid,
            type: 'charge',
            amount: -Math.round(job.price),
            balanceAfter: settleRes.wallet.balance,
            jobId: job.id,
            note: `Print ${job.pages || 1}p × ${job.copies || 1} ${job.color ? 'colour' : 'b/w'}`,
            timestamp: Date.now(),
          }));
          continue;
        }

        // ---- 2. Jobs that never got an OTP (crash mid-mint). ----------------
        const createdAt = Number(job.createdAt) || 0;
        if (!job.recordId) {
          if (Date.now() - createdAt > 3 * 60 * 1000) {
            const relRes = await ledger.release(rtdb, job.uid, job, 'failed', 'No OTP was issued.');
            summary.released++;
            auditLogger.scheduleTask(deps, auditLogger.updatePrintJobStatus(deps, job.id, {
              status: 'failed',
              releasedAt: Date.now(),
              failureReason: 'No OTP was issued',
            }));
            auditLogger.scheduleTask(deps, auditLogger.logLedgerTx(deps, {
              id: `release_${job.id}`,
              uid: job.uid,
              type: 'release',
              amount: Math.round(job.price),
              balanceAfter: relRes.wallet.balance,
              jobId: job.id,
              note: 'Released failed mint (no OTP)',
              timestamp: Date.now(),
            }));
          }
          continue;
        }

        // ---- 3. Expired unused. Give the money back. ------------------------
        const expiresAt = Number(job.expiresAt) || createdAt + 3600 * 1000;
        if (Date.now() < expiresAt + graceMs) continue; // still claimable

        // Kill the code at UprintBD before freeing the funds, so it cannot be
        // used after we stop holding money for it.
        const stillQueued = (await getQueued()).has(String(job.recordId));
        if (stillQueued) {
          const deleted = await session
            .deletePrintRequest(job.recordId)
            .catch(() => false);
          if (!deleted) {
            summary.failedDeletes++;
            continue; // keep the hold; try again next pass
          }
        }

        const expRes = await ledger.release(rtdb, job.uid, job, 'expired', 'Kiosk code expired unused.');
        summary.released++;
        auditLogger.scheduleTask(deps, auditLogger.updatePrintJobStatus(deps, job.id, {
          status: 'expired',
          releasedAt: Date.now(),
          failureReason: 'Kiosk code expired unused',
        }));
        auditLogger.scheduleTask(deps, auditLogger.logLedgerTx(deps, {
          id: `release_${job.id}`,
          uid: job.uid,
          type: 'release',
          amount: Math.round(job.price),
          balanceAfter: expRes.wallet.balance,
          jobId: job.id,
          note: 'Released expired unused OTP hold',
          timestamp: Date.now(),
        }));
      } catch (err) {
        summary.errors.push(`job ${job.id}: ${err.message}`);
      }
    }

    // ---- 4. Leak detector -------------------------------------------------
    // Every filename we ever sent to UprintBD is recorded in /printIndex. A
    // Completed row that is not in there was printed against the institutional
    // account by something outside this app — nobody's wallet covered it. This
    // counter must stay at zero.
    for (const row of completed.values()) {
      try {
        const key = ledger.fileKey(row.filename);
        const known = await rtdb.get(`printIndex/${key}`);
        if (known) continue;
        await rtdb.put(`${STATE_PATH}/unmatched/${key}`, {
          filename: row.filename,
          cost: row.cost,
          pages: row.pages,
          copies: row.copies,
          deviceId: row.deviceId,
          at: row.dateTime,
          seenAt: Date.now(),
        });
        summary.unmatched++;
      } catch (err) {
        summary.errors.push(`unmatched ${row.filename}: ${err.message}`);
      }
    }

    await writeState(rtdb, summary);
    return summary;
  } finally {
    summary.durationMs = Date.now() - startedAt;
    if (!opts.force) await releaseLock(rtdb);
  }
}

async function writeState(rtdb, summary) {
  const patch = {
    lastReconcileAt: Date.now(),
    lastRun: {
      at: Date.now(),
      reason: summary.reason,
      openJobs: summary.openJobs,
      settled: summary.settled,
      released: summary.released,
      failedDeletes: summary.failedDeletes,
      unmatched: summary.unmatched,
      durationMs: Date.now() - summary.startedAt,
    },
    lastError: summary.errors.length ? summary.errors.slice(0, 4).join(' | ') : null,
  };
  if (typeof summary.accountBalance === 'number') {
    patch.accountBalance = summary.accountBalance;
    patch.accountBalanceAt = Date.now();
  }
  try {
    await rtdb.patch(STATE_PATH, patch);
  } catch (_) {
    /* reporting must never break reconciliation */
  }
}

/** Cheap wrapper for /api/print: only runs when the last pass is stale. */
async function reconcileIfStale(deps) {
  try {
    if (!(await isStale(deps.rtdb))) return null;
    return await reconcile(deps, { reason: 'lazy' });
  } catch (_) {
    return null; // never block a print because reconciliation had a bad day
  }
}

module.exports = { reconcile, reconcileIfStale, isStale };
