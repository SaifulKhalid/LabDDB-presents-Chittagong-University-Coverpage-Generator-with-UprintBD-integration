/**
 * scripts/test-audit.js — Unit and integration tests for D1 & R2 Audit Logger
 * -----------------------------------------------------------------------------
 * Tests D1 SQL preparation, parameter binding, R2 PDF archiving, and query APIs
 * using in-memory mock bindings without requiring a live Cloudflare account.
 *
 * Run: node scripts/test-audit.js
 */

'use strict';

const assert = require('assert');
const auditLogger = require('../lib/audit-logger.js');

// ---------------------------------------------------------------------------
// Mock Cloudflare D1 Engine
// ---------------------------------------------------------------------------
class MockD1Database {
  constructor() {
    this.tables = {
      audit_logs: [],
      user_history: [],
      print_jobs_archive: [],
      wallet_ledger_archive: [],
    };
    this.autoInc = 1;
  }

  prepare(sql) {
    const db = this;
    return {
      _sql: sql,
      _bindings: [],
      bind(...args) {
        this._bindings = args;
        return this;
      },
      async run() {
        const s = this._sql.trim();
        if (s.startsWith('INSERT INTO audit_logs')) {
          const row = {
            id: db.autoInc++,
            timestamp: this._bindings[0],
            action: this._bindings[1],
            actor_uid: this._bindings[2],
            actor_email: this._bindings[3],
            target_uid: this._bindings[4],
            details: this._bindings[5],
            ip: this._bindings[6],
            user_agent: this._bindings[7],
          };
          db.tables.audit_logs.push(row);
          return { success: true };
        }
        if (s.startsWith('INSERT INTO user_history')) {
          const row = {
            id: db.autoInc++,
            timestamp: this._bindings[0],
            uid: this._bindings[1],
            email: this._bindings[2],
            display_name: this._bindings[3],
            action: this._bindings[4],
            metadata: this._bindings[5],
            ip: this._bindings[6],
            user_agent: this._bindings[7],
          };
          db.tables.user_history.push(row);
          return { success: true };
        }
        if (s.includes('INSERT OR REPLACE INTO print_jobs_archive')) {
          const jobId = this._bindings[0];
          const row = {
            job_id: jobId,
            uid: this._bindings[1],
            email: this._bindings[2],
            roll: this._bindings[3],
            course_code: this._bindings[4],
            title: this._bindings[5],
            tool: this._bindings[6],
            pages: this._bindings[7],
            copies: this._bindings[8],
            color: this._bindings[9],
            price: this._bindings[10],
            unit_price: this._bindings[11],
            uprint_estimate: this._bindings[12],
            actual_cost: this._bindings[13],
            otp: this._bindings[14],
            record_id: this._bindings[15],
            status: this._bindings[16],
            r2_pdf_key: this._bindings[17],
            created_at: this._bindings[18],
            expires_at: this._bindings[19],
            settled_at: this._bindings[20],
            released_at: this._bindings[21],
            device_id: this._bindings[22],
            failure_reason: this._bindings[23],
          };
          const idx = db.tables.print_jobs_archive.findIndex((j) => j.job_id === jobId);
          if (idx !== -1) db.tables.print_jobs_archive[idx] = row;
          else db.tables.print_jobs_archive.push(row);
          return { success: true };
        }
        if (s.startsWith('UPDATE print_jobs_archive')) {
          const jobId = this._bindings[this._bindings.length - 1];
          const job = db.tables.print_jobs_archive.find((j) => j.job_id === jobId);
          if (job) {
            const setClause = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE '));
            const cols = setClause.split(',').map((c) => c.split('=')[0].trim());
            cols.forEach((col, i) => {
              job[col] = this._bindings[i];
            });
          }
          return { success: true };
        }
        if (s.includes('INSERT OR REPLACE INTO wallet_ledger_archive')) {
          const row = {
            id: this._bindings[0],
            uid: this._bindings[1],
            type: this._bindings[2],
            amount: this._bindings[3],
            balance_after: this._bindings[4],
            job_id: this._bindings[5],
            note: this._bindings[6],
            by_uid: this._bindings[7],
            method: this._bindings[8],
            timestamp: this._bindings[9],
          };
          db.tables.wallet_ledger_archive.push(row);
          return { success: true };
        }
        return { success: true };
      },
      async first() {
        const s = this._sql.trim();
        if (s.includes('FROM audit_logs')) {
          return { total: db.tables.audit_logs.length };
        }
        if (s.includes('FROM print_jobs_archive')) {
          const printed = db.tables.print_jobs_archive.filter((j) => j.status === 'printed');
          return {
            total_jobs: db.tables.print_jobs_archive.length,
            printed_jobs: printed.length,
            expired_jobs: db.tables.print_jobs_archive.filter((j) => j.status === 'expired').length,
            cancelled_jobs: db.tables.print_jobs_archive.filter((j) => j.status === 'cancelled').length,
            total_charged_bdt: printed.reduce((s, j) => s + (j.price || 0), 0),
            total_cost_bdt: printed.reduce((s, j) => s + (j.actual_cost || 0), 0),
          };
        }
        if (s.includes('FROM wallet_ledger_archive')) {
          const topups = db.tables.wallet_ledger_archive.filter((w) => w.type === 'topup');
          const uids = new Set(db.tables.wallet_ledger_archive.map((w) => w.uid));
          return {
            total_topups_bdt: topups.reduce((s, w) => s + (w.amount || 0), 0),
            unique_active_users: uids.size,
          };
        }
        return null;
      },
      async all() {
        const s = this._sql.trim();
        if (s.includes('FROM audit_logs')) {
          return { results: [...db.tables.audit_logs].reverse() };
        }
        if (s.includes('FROM user_history')) {
          const uid = this._bindings[0];
          return { results: db.tables.user_history.filter((u) => u.uid === uid) };
        }
        return { results: [] };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Mock Cloudflare R2 Bucket
// ---------------------------------------------------------------------------
class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, opts = {}) {
    this.objects.set(key, { body, opts });
    return { key };
  }

  async get(key) {
    return this.objects.get(key) || null;
  }
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function ok(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

async function runTests() {
  console.log('\n--- D1 & R2 Audit Logger Tests ---');

  const mockDb = new MockD1Database();
  const mockBucket = new MockR2Bucket();
  const ctx = {
    env: {
      DB: mockDb,
      COVERS_BUCKET: mockBucket,
    },
  };

  // 1. Audit Logging
  console.log('\nAudit logs:');
  await auditLogger.logAudit(ctx, {
    action: 'topup',
    actorUid: 'admin123',
    actorEmail: 'admin@cu.ac.bd',
    targetUid: 'user456',
    details: { amount: 50, method: 'bKash', note: 'TID12345' },
    ip: '103.25.12.1',
    userAgent: 'Mozilla/5.0',
  });
  ok(mockDb.tables.audit_logs.length === 1, 'admin topup logged into D1');
  ok(mockDb.tables.audit_logs[0].action === 'topup', 'action recorded correctly');
  ok(mockDb.tables.audit_logs[0].actor_email === 'admin@cu.ac.bd', 'actor email preserved');

  const logs = await auditLogger.getAuditLogs(ctx);
  ok(logs.ok === true && logs.logs.length === 1, 'getAuditLogs returns inserted record');
  ok(logs.logs[0].details.amount === 50, 'details parsed back as JSON');

  // 2. User History
  console.log('\nUser history:');
  await auditLogger.logUserHistory(ctx, {
    uid: 'user456',
    email: 'student@cu.ac.bd',
    displayName: 'Md. Khalid',
    action: 'otp_mint',
    metadata: { jobId: 'job_001', otp: '123456', cost: 3 },
    ip: '103.25.12.1',
  });
  ok(mockDb.tables.user_history.length === 1, 'user activity logged into D1');

  const history = await auditLogger.getUserActivityHistory(ctx, 'user456');
  ok(history.ok === true && history.history.length === 1, 'getUserActivityHistory queries correctly');
  ok(history.history[0].metadata.otp === '123456', 'metadata JSON parsed correctly');

  // 3. Print Jobs Archiving & Status Updates
  console.log('\nPrint jobs archive:');
  await auditLogger.logPrintJob(ctx, {
    jobId: 'job_001',
    uid: 'user456',
    email: 'student@cu.ac.bd',
    roll: '24702008',
    courseCode: 'EEE 418',
    title: 'Lab Report 1',
    pages: 1,
    copies: 1,
    color: false,
    price: 3,
    unitPrice: 3,
    status: 'reserving',
  });
  ok(mockDb.tables.print_jobs_archive.length === 1, 'print job archived into D1');

  await auditLogger.updatePrintJobStatus(ctx, 'job_001', {
    status: 'printed',
    settledAt: Date.now(),
    actualCost: 2.0,
  });
  const updatedJob = mockDb.tables.print_jobs_archive.find((j) => j.job_id === 'job_001');
  ok(updatedJob.status === 'printed', 'job status updated to printed');

  // 4. Ledger Transaction Archiving
  console.log('\nLedger archive:');
  await auditLogger.logLedgerTx(ctx, {
    id: 'top_001',
    uid: 'user456',
    type: 'topup',
    amount: 50,
    balanceAfter: 50,
    note: 'Initial topup',
    byUid: 'admin123',
  });
  ok(mockDb.tables.wallet_ledger_archive.length === 1, 'ledger transaction archived into D1');

  // 5. Cloudflare R2 Document Archiving
  console.log('\nR2 object storage:');
  const dummyPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const key = await auditLogger.archivePdfToR2(ctx, {
    jobId: 'job_001',
    uid: 'user456',
    filename: 'AssignmentCover.pdf',
    pdfBytes: dummyPdf,
    roll: '24702008',
    courseCode: 'EEE 418',
  });
  ok(typeof key === 'string' && key.startsWith('covers/user456/'), 'PDF uploaded to R2 with structured key');
  const storedObj = await mockBucket.get(key);
  ok(storedObj !== null, 'R2 object exists in bucket');
  ok(storedObj.opts.httpMetadata.contentType === 'application/pdf', 'R2 Content-Type header set');
  ok(storedObj.opts.customMetadata.roll === '24702008', 'R2 custom metadata preserved');

  // 6. Analytics Summary
  console.log('\nAnalytics summary:');
  const summary = await auditLogger.getAnalyticsSummary(ctx);
  ok(summary.ok === true && summary.d1Available === true, 'getAnalyticsSummary succeeds');
  ok(summary.analytics.jobs.printed === 1, 'printed jobs counted in analytics');
  ok(summary.analytics.financials.totalTopUps === 50, 'financial totals computed');

  // 7. Graceful Fallback when D1/R2 are missing
  console.log('\nGraceful fallback without D1/R2:');
  const emptyCtx = { env: {} };
  await auditLogger.logAudit(emptyCtx, { action: 'test' });
  const r2Fallback = await auditLogger.archivePdfToR2(emptyCtx, { jobId: 'j', uid: 'u', pdfBytes: dummyPdf });
  ok(r2Fallback === null, 'archivePdfToR2 safely returns null when R2 is missing');
  const logsFallback = await auditLogger.getAuditLogs(emptyCtx);
  ok(logsFallback.d1Available === false && logsFallback.logs.length === 0, 'getAuditLogs reports d1Available: false without crashing');

  console.log(`\n------------------------------------------------------------`);
  console.log(`Result: ${passed} passed, ${failed} failed.\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('[test-audit] Unhandled error:', err);
  process.exit(1);
});
