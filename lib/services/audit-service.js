/**
 * lib/services/audit-service.js — D1 & R2 Audit, History & Document Tracking Service.
 * -----------------------------------------------------------------------------
 * Records immutable user activity, financial transactions, and admin actions
 * into Cloudflare D1 (SQL), and archives generated PDF documents into Cloudflare
 * R2 object storage.
 *
 * Design principles:
 *   - Non-blocking: Logging errors are caught and logged, never bubbling up to
 *     disrupt the critical path of cover generation or kiosk OTP minting.
 *   - Isomorphic: Operates seamlessly on Cloudflare Workers (via env.DB / env.COVERS_BUCKET)
 *     and falls back cleanly in local Node dev environments.
 */

'use strict';

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

function toJsonString(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val);
  } catch (_) {
    return String(val);
  }
}

function scheduleTask(ctx, promise) {
  if (ctx && ctx.workerCtx && typeof ctx.workerCtx.waitUntil === 'function') {
    ctx.workerCtx.waitUntil(promise);
  } else if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      console.warn('[audit-service] background task warning:', err.message);
    });
  }
}

async function logAudit(ctx, entry = {}) {
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
    console.warn('[audit-service] logAudit failed:', err.message);
  }
}

async function logUserHistory(ctx, entry = {}) {
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
    console.warn('[audit-service] logUserHistory failed:', err.message);
  }
}

async function logPrintJob(ctx, job = {}) {
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
        job.jobId || '',
        job.uid || '',
        job.email || '',
        job.roll || '',
        job.courseCode || '',
        job.title || '',
        job.tool || '',
        job.pages || 1,
        job.copies || 1,
        job.color ? 1 : 0,
        job.price || 0,
        job.unitPrice || 0,
        job.uprintEstimate != null ? job.uprintEstimate : null,
        job.actualCost != null ? job.actualCost : null,
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
    console.warn('[audit-service] logPrintJob failed:', err.message);
  }
}

async function updatePrintJobStatus(ctx, jobId, updates = {}) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') return;

  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.otp !== undefined) {
    fields.push('otp = ?');
    values.push(updates.otp);
  }
  if (updates.recordId !== undefined) {
    fields.push('record_id = ?');
    values.push(updates.recordId);
  }
  if (updates.expiresAt !== undefined) {
    fields.push('expires_at = ?');
    values.push(updates.expiresAt);
  }
  if (updates.settledAt !== undefined) {
    fields.push('settled_at = ?');
    values.push(updates.settledAt);
  }
  if (updates.releasedAt !== undefined) {
    fields.push('released_at = ?');
    values.push(updates.releasedAt);
  }
  if (updates.actualCost !== undefined) {
    fields.push('actual_cost = ?');
    values.push(updates.actualCost);
  }
  if (updates.deviceId !== undefined) {
    fields.push('device_id = ?');
    values.push(updates.deviceId);
  }
  if (updates.failureReason !== undefined) {
    fields.push('failure_reason = ?');
    values.push(updates.failureReason);
  }
  if (updates.r2PdfKey !== undefined) {
    fields.push('r2_pdf_key = ?');
    values.push(updates.r2PdfKey);
  }

  if (!fields.length) return;
  values.push(jobId);

  const query = `UPDATE print_jobs_archive SET ${fields.join(', ')} WHERE job_id = ?`;
  try {
    await db.prepare(query).bind(...values).run();
  } catch (err) {
    console.warn('[audit-service] updatePrintJobStatus failed:', err.message);
  }
}

async function logLedgerTx(ctx, entry = {}) {
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
        entry.id || `tx_${Date.now()}`,
        entry.uid || '',
        entry.type || 'tx',
        entry.amount || 0,
        entry.balanceAfter != null ? entry.balanceAfter : entry.balance_after || 0,
        entry.jobId || entry.job_id || null,
        entry.note || null,
        entry.byUid || entry.by_uid || null,
        entry.method || null,
        entry.timestamp || Date.now()
      )
      .run();
  } catch (err) {
    console.warn('[audit-service] logLedgerTx failed:', err.message);
  }
}

/**
 * Upload generated PDF to Cloudflare R2 bucket.
 */
async function archivePdfToR2(ctx, optsOrJobId, maybeBytes, maybeMeta) {
  const bucket = ctx && ctx.env && ctx.env.COVERS_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') return null;

  let jobId, uid, filename, pdfBytes, roll, courseCode;
  if (typeof optsOrJobId === 'object' && optsOrJobId !== null) {
    jobId = optsOrJobId.jobId;
    uid = optsOrJobId.uid;
    filename = optsOrJobId.filename;
    pdfBytes = optsOrJobId.pdfBytes;
    roll = optsOrJobId.roll;
    courseCode = optsOrJobId.courseCode;
  } else {
    jobId = optsOrJobId;
    pdfBytes = maybeBytes;
    uid = maybeMeta && maybeMeta.uid;
    filename = maybeMeta && maybeMeta.filename;
    roll = maybeMeta && maybeMeta.roll;
    courseCode = maybeMeta && maybeMeta.courseCode;
  }

  const safeFilename = String(filename || 'cover.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
  const key = `covers/${uid || 'user'}/${jobId}_${safeFilename}`;

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
    console.warn('[audit-service] archivePdfToR2 failed:', err.message);
    return null;
  }
}

async function getAuditLogs(ctx, opts = {}) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: true, logs: [], count: 0, d1Available: false };
  }

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 50));
  const action = opts.action ? String(opts.action).trim() : null;
  const search = opts.search ? String(opts.search).trim() : null;

  let query = 'SELECT * FROM audit_logs';
  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (search) {
    conditions.push('(actor_email LIKE ? OR actor_uid LIKE ? OR target_uid LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  try {
    const res = await db.prepare(query).bind(...params).all();
    const logs = (res.results || []).map((row) => ({
      ...row,
      details: row.details ? JSON.parse(row.details) : null,
    }));
    return { ok: true, logs, count: logs.length, d1Available: true };
  } catch (err) {
    console.warn('[audit-service] getAuditLogs failed:', err.message);
    return { ok: false, logs: [], count: 0, d1Available: false, error: err.message };
  }
}

async function getUserActivityHistory(ctx, uidOrOpts, limitVal = 50) {
  const db = ctx && ctx.env && ctx.env.DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: true, history: [], d1Available: false };
  }

  const uid = typeof uidOrOpts === 'object' && uidOrOpts ? uidOrOpts.uid : uidOrOpts;
  const limit = Math.min(
    100,
    Math.max(1, Number(typeof uidOrOpts === 'object' && uidOrOpts ? uidOrOpts.limit : limitVal) || 50)
  );

  let query = 'SELECT * FROM user_history';
  const params = [];

  if (uid) {
    query += ' WHERE uid = ?';
    params.push(uid);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  try {
    const res = await db.prepare(query).bind(...params).all();
    const history = (res.results || []).map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
    return { ok: true, history, d1Available: true };
  } catch (err) {
    console.warn('[audit-service] getUserActivityHistory failed:', err.message);
    return { ok: false, history: [], d1Available: false, error: err.message };
  }
}

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
    console.warn('[audit-service] getAnalyticsSummary failed:', err.message);
    return { ok: false, d1Available: false, error: err.message };
  }
}

module.exports = {
  getClientInfo,
  toJsonString,
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
