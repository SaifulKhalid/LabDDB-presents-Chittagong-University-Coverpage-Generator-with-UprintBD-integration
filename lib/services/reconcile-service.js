/**
 * lib/services/reconcile-service.js — Settle & release reconciliation engine.
 * -----------------------------------------------------------------------------
 * Decides, after the fact, who actually printed.
 *
 * It trusts exactly one source: UprintBD's own print history.
 * A row with `Print Status: Completed` means paper came out of a printer.
 * Anything else ends in a release, and the student keeps their money.
 *
 * Invariants enforced:
 *   - Settle before expire: always check history first.
 *   - Delete before release: delete code from UprintBD before freeing money.
 *   - No history -> no decisions: bail out safely if history fetch errors.
 *   - Audit logs recorded reliably without undefined scope references.
 */

'use strict';

const ledger = require('../ledger.js');
const auditLogger = require('./audit-service.js');

const LOCK_PATH = 'admin/uprint/lock';
const STATE_PATH = 'admin/uprint';
const LOCK_TTL_MS = 90 * 1000;
const STALE_AFTER_MS = 3 * 60 * 1000;

async function isStale(rtdb) {
  const last = await rtdb.get(`${STATE_PATH}/lastReconcileAt`);
  return !last || Date.now() - Number(last) > STALE_AFTER_MS;
}

async function acquireLock(rtdb, owner) {
  const res = await rtdb.transaction(LOCK_PATH, (current) => {
    if (current && current.at && Date.now() - Number(current.at) < LOCK_TTL_MS) {
      return undefined; // Lock held by another pass
    }
    return { at: Date.now(), owner };
  });
  return res.committed;
}

async function releaseLock(rtdb) {
  try {
    await rtdb.remove(LOCK_PATH);
  } catch (_) {
    /* TTL will expire it */
  }
}

function normName(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * Run a full reconciliation pass.
 *
 * @param {object} ctx Context containing { rtdb, session, env, workerCtx }
 * @param {object} [opts] Options { force, reason }
 * @returns {Promise<object>} Summary suitable for admin dashboard
 */
async function reconcile(ctx, opts = {}) {
  const { rtdb, session } = ctx;
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
    const jobList = Object.entries(openJobs)
      .filter(([, j]) => j && typeof j === 'object')
      .map(([id, j]) => ({ ...j, id }));

    summary.openJobs = jobList.length;

    const limits = await ledger.loadLimits(rtdb);
    const graceMs = (limits.holdGraceSeconds || 300) * 1000;

    let accountBalance = null;
    try {
      accountBalance = await session.getAccountBalance();
    } catch (e) {
      summary.errors.push(`account balance: ${e.message}`);
    }

    if (!jobList.length) {
      await writeState(rtdb, { lastRun: summary, accountBalance });
      return summary;
    }

    // Determine history query range
    let oldestMs = Date.now();
    for (const j of jobList) {
      const at = Number(j.createdAt) || 0;
      if (at > 0 && at < oldestMs) oldestMs = at;
    }

    // INVARIANT INV-7: If history fetch fails, bail out immediately.
    let historyRows;
    try {
      historyRows = await session.getPrintHistory({ sinceMs: oldestMs - 24 * 3600 * 1000 });
    } catch (err) {
      summary.errors.push(`print_history fetch failed: ${err.message}`);
      await writeState(rtdb, { lastRun: summary, accountBalance, lastError: err.message });
      return summary;
    }

    // Build completed map: first Completed row per normalized filename wins
    const completed = new Map();
    for (const row of historyRows) {
      if (!row || !row.status || !/complete/i.test(row.status)) continue;
      const key = normName(row.filename);
      if (key && !completed.has(key)) {
        completed.set(key, row);
      }
    }

    // Lazy load queued IDs only if needed
    let queuedIds = null;
    const getQueued = async () => {
      if (!queuedIds) {
        try {
          queuedIds = await session.getQueuedRecordIds();
        } catch (_) {
          queuedIds = new Set();
        }
      }
      return queuedIds;
    };

    // Reconcile each open job
    for (const job of jobList) {
      try {
        const row = completed.get(normName(job.filename));

        // 1. CONFIRMED PRINT: Settle charge
        if (row) {
          const settleRes = await ledger.settle(rtdb, job.uid, job, {
            actualCost: row.cost,
            deviceId: row.deviceId,
            historyAt: row.dateTime,
          });
          summary.settled++;

          // Log audit records reliably with valid ctx
          auditLogger.scheduleTask(
            ctx,
            auditLogger.updatePrintJobStatus(ctx, job.id, {
              status: 'printed',
              actualCost: row.cost,
              deviceId: row.deviceId,
              settledAt: Date.now(),
            })
          );
          auditLogger.scheduleTask(
            ctx,
            auditLogger.logLedgerTx(ctx, {
              id: `chg_${job.id}`,
              uid: job.uid,
              type: 'charge',
              amount: -Math.round(job.price),
              balanceAfter: settleRes.wallet.balance,
              jobId: job.id,
              note: `Print ${job.pages || 1}p × ${job.copies || 1} ${job.color ? 'colour' : 'b/w'}`,
              timestamp: Date.now(),
            })
          );
          auditLogger.scheduleTask(
            ctx,
            auditLogger.logUserHistory(ctx, {
              uid: job.uid,
              email: job.email,
              action: 'PRINT_COMPLETED',
              metadata: {
                jobId: job.id,
                pages: job.pages,
                copies: job.copies,
                cost: row.cost,
                deviceId: row.deviceId,
              },
            })
          );
          auditLogger.scheduleTask(
            ctx,
            auditLogger.logAudit(ctx, {
              action: 'PRINT_COMPLETED',
              actorUid: job.uid,
              actorEmail: job.email,
              details: {
                jobId: job.id,
                cost: row.cost,
                deviceId: row.deviceId,
              },
            })
          );
          continue;
        }

        // 2. STALE UNISSUED OTP: Release failed mint (>3min)
        const createdAt = Number(job.createdAt) || 0;
        if (!job.recordId) {
          if (Date.now() - createdAt > 3 * 60 * 1000) {
            const relRes = await ledger.release(rtdb, job.uid, job, 'failed', 'No OTP was issued.');
            summary.released++;
            auditLogger.scheduleTask(
              ctx,
              auditLogger.updatePrintJobStatus(ctx, job.id, {
                status: 'failed',
                releasedAt: Date.now(),
                failureReason: 'No OTP was issued',
              })
            );
            auditLogger.scheduleTask(
              ctx,
              auditLogger.logUserHistory(ctx, {
                uid: job.uid,
                email: job.email,
                action: 'PRINT_FAILED',
                metadata: {
                  jobId: job.id,
                  reason: 'No OTP was issued',
                },
              })
            );
            auditLogger.scheduleTask(
              ctx,
              auditLogger.logLedgerTx(ctx, {
                id: `release_${job.id}`,
                uid: job.uid,
                type: 'release',
                amount: Math.round(job.price),
                balanceAfter: relRes.wallet.balance,
                jobId: job.id,
                note: 'Released failed mint (no OTP)',
                timestamp: Date.now(),
              })
            );
          }
          continue;
        }

        // 3. EXPIRED UNUSED OTP: Delete at provider before releasing funds
        const expiresAt = Number(job.expiresAt) || createdAt + 3600 * 1000;
        if (Date.now() < expiresAt + graceMs) {
          // Still within validity window + grace period
          continue;
        }

        const stillQueued = (await getQueued()).has(String(job.recordId));
        if (stillQueued) {
          const deleted = await session.deletePrintRequest(job.recordId).catch(() => false);
          if (!deleted) {
            // INVARIANT INV-6: If delete fails, keep hold for next pass
            summary.failedDeletes++;
            continue;
          }
        }

        const expRes = await ledger.release(rtdb, job.uid, job, 'expired', 'Kiosk code expired unused.');
        summary.released++;
        auditLogger.scheduleTask(
          ctx,
          auditLogger.updatePrintJobStatus(ctx, job.id, {
            status: 'expired',
            releasedAt: Date.now(),
            failureReason: 'Kiosk code expired unused',
          })
        );
        auditLogger.scheduleTask(
          ctx,
          auditLogger.logUserHistory(ctx, {
            uid: job.uid,
            email: job.email,
            action: 'PRINT_EXPIRED',
            metadata: {
              jobId: job.id,
              reason: 'Kiosk code expired unused',
            },
          })
        );
        auditLogger.scheduleTask(
          ctx,
          auditLogger.logAudit(ctx, {
            action: 'PRINT_EXPIRED',
            actorUid: job.uid,
            actorEmail: job.email,
            details: {
              jobId: job.id,
            },
          })
        );
        auditLogger.scheduleTask(
          ctx,
          auditLogger.logLedgerTx(ctx, {
            id: `release_${job.id}`,
            uid: job.uid,
            type: 'release',
            amount: Math.round(job.price),
            balanceAfter: expRes.wallet.balance,
            jobId: job.id,
            note: 'Released expired unused OTP hold',
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        summary.errors.push(`job ${job.id}: ${err.message}`);
      }
    }

    // INVARIANT INV-17: Leak detector — record any completed prints missing from printIndex
    for (const [key, row] of completed.entries()) {
      try {
        const found = await rtdb.get(`printIndex/${ledger.fileKey(key)}`);
        if (!found) {
          summary.unmatched++;
          await rtdb.put(`admin/uprint/unmatched/${ledger.fileKey(key)}`, {
            ...row,
            detectedAt: Date.now(),
          });
        }
      } catch (_) {}
    }

    await writeState(rtdb, { lastRun: summary, accountBalance });
  } finally {
    await releaseLock(rtdb);
  }

  return summary;
}

async function writeState(rtdb, { lastRun, accountBalance, lastError = null }) {
  const patch = {
    lastReconcileAt: Date.now(),
    lastRun,
  };
  if (accountBalance != null) patch.accountBalance = accountBalance;
  if (lastError !== undefined) patch.lastError = lastError;
  try {
    await rtdb.patch(STATE_PATH, patch);
  } catch (_) {}
}

async function reconcileIfStale(ctx) {
  if (!ctx || !ctx.rtdb || !ctx.session) return null;
  try {
    if (await isStale(ctx.rtdb)) {
      return await reconcile(ctx, { reason: 'lazy' });
    }
  } catch (err) {
    console.warn('[reconcile-service] lazy reconcile warning:', err.message);
  }
  return null;
}

module.exports = {
  reconcile,
  reconcileIfStale,
  isStale,
  acquireLock,
  releaseLock,
  normName,
};
