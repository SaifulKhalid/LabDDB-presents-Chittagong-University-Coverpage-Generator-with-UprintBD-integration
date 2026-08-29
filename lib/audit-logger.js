/**
 * lib/audit-logger.js — Cloudflare D1 & R2 Audit, History & Document Tracking
 * -----------------------------------------------------------------------------
 * Records immutable user activity, financial transactions, and admin actions
 * into Cloudflare D1 (SQL), and archives generated PDF cover documents into
 * Cloudflare R2 object storage.
 *
 * Design principles:
 *   - Non-blocking: Logging errors are caught and logged, never bubbling up to
 *     disrupt the critical path of cover generation or kiosk OTP minting.
 *   - Isomorphic: Operates seamlessly on Cloudflare Workers (via env.DB / env.COVERS_BUCKET)
 *     and falls back cleanly in local Node dev environments.
 */

'use strict';

/**
 * Extract client IP and User-Agent from a standard Fetch Request.
 */
function getClientInfo(request) {
  if (!request || !request.headers) {
    return { ip: '127.0.0.1', userAgent: 'unknown' };
  }
  const headers = request.headers;
  const ip =
    headers.get('cf-connecting-ip') ||
    headers.get('x-forwarded-for') ||
    headers.get('x-real-ip') ||
    '127.0.0.1';
  const userAgent = headers.get('user-agent') || 'unknown';
  return { ip, userAgent };
}

/**
 * Safe JSON serializer for SQL metadata columns.
 */
function toJsonString(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val);
  } catch (_) {
    return String(val);
  }
}

/**
 * Helper to queue background work on Cloudflare Worker (ctx.waitUntil) or Node.
 */
function scheduleTask(ctx, promise) {
  if (ctx && ctx.workerCtx && typeof ctx.workerCtx.waitUntil === 'function') {
    ctx.workerCtx.waitUntil(promise);
  } else {
    promise.catch((err) => {
      console.warn('[audit-logger] background task warning:', err.message);
    });
  }
}

// ---------------------------------------------------------------------------
// D1 SQL Logging Operations
// ---------------------------------------------------------------------------

/**
 * Log an administrative or security-sensitive action.
 */
async function logAudit(ctx, entry) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO audit_logs (timestamp, action, actor_uid, actor_email, target_uid, details, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    await stmt
      .bind(
        now,
        entry.action || 'unknown',
        entry.actorUid || '',
        entry.actorEmail || '',
        entry.targetUid || null,
        toJsonString(entry.details),
        entry.ip || null,
        entry.userAgent || null
      )
      .run();
  } catch (err) {
    console.warn('[audit-logger] logAudit failed:', err.message);
  }
}

/**
 * Log user activity (sign-in, profile update, cover generation).
 */
async function logUserHistory(ctx, entry) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO user_history (timestamp, uid, email, display_name, action, metadata, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    await stmt
      .bind(
        now,
        entry.uid || '',
        entry.email || '',
        entry.displayName || '',
        entry.action || 'activity',
        toJsonString(entry.metadata),
        entry.ip || null,
        entry.userAgent || null
      )
      .run();
  } catch (err) {
    console.warn('[audit-logger] logUserHistory failed:', err.message);
  }
}

/**
 * Archive a print job into D1.
 */
async function logPrintJob(ctx, job) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO print_jobs_archive (
      job_id, uid, email, roll, course_code, title, tool,
      pages, copies, color, price, unit_price, uprint_estimate,
      actual_cost, otp, record_id, status, r2_pdf_key,
      created_at, expires_at, settled_at, released_at,
      device_id, failure_reason
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);

  try {
    await stmt
      .bind(
        job.jobId || job.id,
        job.uid,
        job.email || null,
        job.roll || null,
        job.courseCode || null,
        job.title || null,
        job.tool || null,
        job.pages || 1,
        job.copies || 1,
        job.color ? 1 : 0,
        job.price || 0,
        job.unitPrice || 0,
        job.uprintEstimate || null,
        job.actualCost || null,
        job.otp || null,
        job.recordId || null,
        job.status || 'reserving',
        job.r2PdfKey || null,
        job.createdAt || Date.now(),
        job.expiresAt || null,
        job.settledAt || null,
        job.releasedAt || null,
        job.deviceId || null,
        job.failureReason || null
      )
      .run();
  } catch (err) {
    console.warn('[audit-logger] logPrintJob failed:', err.message);
  }
}

/**
 * Update status of an existing print job in D1.
 */
async function updatePrintJobStatus(ctx, jobId, patch) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const fields = [];
  const bindings = [];

  if (patch.status) {
    fields.push('status = ?');
    bindings.push(patch.status);
  }
  if (patch.otp) {
    fields.push('otp = ?');
    bindings.push(patch.otp);
  }
  if (patch.recordId) {
    fields.push('record_id = ?');
    bindings.push(patch.recordId);
  }
  if (patch.expiresAt) {
    fields.push('expires_at = ?');
    bindings.push(patch.expiresAt);
  }
  if (patch.uprintEstimate !== undefined) {
    fields.push('uprint_estimate = ?');
    bindings.push(patch.uprintEstimate);
  }
  if (patch.actualCost !== undefined) {
    fields.push('actual_cost = ?');
    bindings.push(patch.actualCost);
  }
  if (patch.deviceId !== undefined) {
    fields.push('device_id = ?');
    bindings.push(patch.deviceId);
  }
  if (patch.settledAt) {
    fields.push('settled_at = ?');
    bindings.push(patch.settledAt);
  }
  if (patch.releasedAt) {
    fields.push('released_at = ?');
    bindings.push(patch.releasedAt);
  }
  if (patch.failureReason !== undefined) {
    fields.push('failure_reason = ?');
    bindings.push(patch.failureReason);
  }
  if (patch.r2PdfKey !== undefined) {
    fields.push('r2_pdf_key = ?');
    bindings.push(patch.r2PdfKey);
  }

  if (!fields.length) return;

  bindings.push(jobId);
  const sql = `UPDATE print_jobs_archive SET ${fields.join(', ')} WHERE job_id = ?`;

  try {
    await db.prepare(sql).bind(...bindings).run();
  } catch (err) {
    console.warn('[audit-logger] updatePrintJobStatus failed:', err.message);
  }
}

/**
 * Archive wallet ledger transaction into D1.
 */
async function logLedgerTx(ctx, entry) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wallet_ledger_archive (
      id, uid, type, amount, balance_after, job_id, note, by_uid, method, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    await stmt
      .bind(
        entry.id,
        entry.uid,
        entry.type || 'tx',
        entry.amount || 0,
        entry.balanceAfter || 0,
        entry.jobId || null,
        entry.note || null,
        entry.byUid || null,
        entry.method || null,
        entry.timestamp || Date.now()
      )
      .run();
  } catch (err) {
    console.warn('[audit-logger] logLedgerTx failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// R2 Object Storage Archiving
// ---------------------------------------------------------------------------

/**
 * Upload generated PDF to Cloudflare R2 bucket.
 * Returns the object key, or null if R2 is not configured.
 */
async function archivePdfToR2(ctx, { jobId, uid, filename, pdfBytes, roll, courseCode }) {
  const bucket = ctx && ctx.env && ctx.env.COVERS_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') return null;

  const date = new Date();
  const yearMonth = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const safeFilename = String(filename || 'cover.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
  const key = `covers/${uid}/${yearMonth}/${jobId}_${safeFilename}`;

  try {
    await bucket.put(key, pdfBytes, {
      httpMetadata: {
        contentType: 'application/pdf',
        contentDisposition: `attachment; filename="${safeFilename}"`,
      },
      customMetadata: {
        jobId: String(jobId || ''),
        uid: String(uid || ''),
        roll: String(roll || ''),
        courseCode: String(courseCode || ''),
        archivedAt: new Date().toISOString(),
      },
    });
    return key;
  } catch (err) {
    console.warn('[audit-logger] archivePdfToR2 failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// D1 Query APIs for Project Admin
// ---------------------------------------------------------------------------

/**
 * Query audit logs with pagination and search.
 */
async function getAuditLogs(ctx, opts = {}) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: true, logs: [], count: 0, d1Available: false };
  }

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const action = opts.action ? String(opts.action).trim() : '';
  const search = opts.search ? String(opts.search).trim() : '';

  let whereClause = '';
  const bindings = [];

  const conditions = [];
  if (action) {
    conditions.push('action = ?');
    bindings.push(action);
  }
  if (search) {
    conditions.push('(actor_email LIKE ? OR target_uid LIKE ? OR details LIKE ?)');
    const searchPattern = `%${search}%`;
    bindings.push(searchPattern, searchPattern, searchPattern);
  }

  if (conditions.length) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  try {
    const countSql = `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`;
    const countRes = await db.prepare(countSql).bind(...bindings).first();
    const total = countRes ? countRes.total : 0;

    const listSql = `
      SELECT id, timestamp, action, actor_uid, actor_email, target_uid, details, ip, user_agent
      FROM audit_logs
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;
    const rows = await db.prepare(listSql).bind(...bindings, limit, offset).all();

    const logs = (rows && rows.results ? rows.results : []).map((r) => {
      let detailsObj = r.details;
      try {
        if (typeof r.details === 'string') detailsObj = JSON.parse(r.details);
      } catch (_) {}
      return { ...r, details: detailsObj };
    });

    return { ok: true, logs, count: total, limit, offset, d1Available: true };
  } catch (err) {
    console.warn('[audit-logger] getAuditLogs failed:', err.message);
    return { ok: false, error: err.message, logs: [], count: 0, d1Available: true };
  }
}

/**
 * Query user activity history from D1.
 */
async function getUserActivityHistory(ctx, uid, limit = 50) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: true, history: [], d1Available: false };
  }

  try {
    const rows = await db
      .prepare(
        `SELECT id, timestamp, uid, email, display_name, action, metadata, ip, user_agent
         FROM user_history
         WHERE uid = ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .bind(uid, Math.min(100, Math.max(1, limit)))
      .all();

    const history = (rows && rows.results ? rows.results : []).map((r) => {
      let meta = r.metadata;
      try {
        if (typeof r.metadata === 'string') meta = JSON.parse(r.metadata);
      } catch (_) {}
      return { ...r, metadata: meta };
    });

    return { ok: true, history, d1Available: true };
  } catch (err) {
    return { ok: false, error: err.message, history: [], d1Available: true };
  }
}

/**
 * Summary analytics computed from D1 print_jobs_archive & wallet_ledger_archive.
 */
async function getAnalyticsSummary(ctx) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: true, d1Available: false, analytics: null };
  }

  try {
    const [jobStats, revStats, recentActivity] = await Promise.all([
      db.prepare(`
        SELECT
          COUNT(*) as total_jobs,
          SUM(CASE WHEN status = 'printed' THEN 1 ELSE 0 END) as printed_jobs,
          SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_jobs,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_jobs,
          SUM(CASE WHEN status = 'printed' THEN price ELSE 0 END) as total_charged_bdt,
          SUM(CASE WHEN status = 'printed' THEN actual_cost ELSE 0 END) as total_cost_bdt
        FROM print_jobs_archive
      `).first(),

      db.prepare(`
        SELECT
          SUM(CASE WHEN type = 'topup' THEN amount ELSE 0 END) as total_topups_bdt,
          COUNT(DISTINCT uid) as unique_active_users
        FROM wallet_ledger_archive
      `).first(),

      db.prepare(`
        SELECT action, count(*) as count
        FROM user_history
        WHERE timestamp > ?
        GROUP BY action
      `).bind(Date.now() - 24 * 3600 * 1000).all()
    ]);

    const totalCharged = (jobStats && jobStats.total_charged_bdt) || 0;
    const totalCost = (jobStats && jobStats.total_cost_bdt) || 0;
    const grossMargin = totalCharged - totalCost;

    return {
      ok: true,
      d1Available: true,
      analytics: {
        jobs: {
          total: (jobStats && jobStats.total_jobs) || 0,
          printed: (jobStats && jobStats.printed_jobs) || 0,
          expired: (jobStats && jobStats.expired_jobs) || 0,
          cancelled: (jobStats && jobStats.cancelled_jobs) || 0,
        },
        financials: {
          totalTopUps: (revStats && revStats.total_topups_bdt) || 0,
          totalCharged,
          totalCost,
          grossMargin,
        },
        users: {
          uniqueActive: (revStats && revStats.unique_active_users) || 0,
        },
        recentActivity24h: recentActivity && recentActivity.results ? recentActivity.results : [],
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, d1Available: true };
  }
}

module.exports = {
  getClientInfo,
  scheduleTask,
  logAudit,
  logUserHistory,
  logPrintJob,
  updatePrintJobStatus,
  logLedgerTx,
  archivePdfToR2,
  getAuditLogs,
  getUserActivityHistory,
  getAnalyticsSummary,
};
