/**
 * lib/services/print-service.js — Complete print job lifecycle orchestrator.
 * -----------------------------------------------------------------------------
 * Orchestrates:
 *   1. Validation of document bytes and server-side page counting.
 *   2. Atomic reservation of funds in student wallet.
 *   3. Writing the audit paper trail BEFORE contacting UprintBD.
 *   4. Dispatching document to PrintProvider.
 *   5. Failure compensation: immediate hold release if provider fails.
 *   6. Success completion: stamping OTP and status reserved.
 */

'use strict';

const { PrintJob, JobStatus } = require('../domain/print-job.js');
const { countPdfPages, priceJob, checkLimits } = require('../domain/pricing.js');
const { uniqueFilename, fileKey, newJobId } = require('../domain/wallet.js');
const { ValidationError, LedgerError, ProviderError } = require('../domain/errors.js');
const auditLogger = require('./audit-service.js');

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB

function base64ToUint8Array(b64) {
  const clean = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isPdf(bytes) {
  return (
    bytes &&
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d    // -
  );
}

function sanitizeStr(v, max = 120) {
  return String(v == null ? '' : v).slice(0, max);
}

class PrintService {
  constructor({ rtdb, walletService, printProvider, auditService = auditLogger }) {
    this.rtdb = rtdb;
    this.walletService = walletService;
    this.provider = printProvider;
    this.audit = auditService;
  }

  /**
   * Request a print job: validate, hold funds, lay paper trail, dispatch to provider.
   */
  async requestPrint(ctx, identity, user, body, request = null) {
    if (user && user.disabled) {
      throw new LedgerError('This account has been disabled. Please contact the admin.', 403);
    }

    if (!body || !body.pdfBase64) {
      throw new ValidationError('No document was received.', 400);
    }

    const bytes = base64ToUint8Array(body.pdfBase64);
    if (!bytes.length) throw new ValidationError('The document was empty.', 400);
    if (bytes.length > MAX_PDF_BYTES) throw new ValidationError('That document is too large.', 413);
    if (!isPdf(bytes)) throw new ValidationError('That file is not a PDF.', 400);

    const [pricing, limits] = await Promise.all([
      this.walletService.loadPricing(),
      this.walletService.loadLimits(),
    ]);

    const color = !!body.color;
    const pages = countPdfPages(bytes);
    const quote = priceJob({ pages, copies: body.copies, color, pricing });

    // Enforce quotas, volume limits, and duplicate clientJobId protection
    const [userJobs, openJobs] = await Promise.all([
      this.rtdb.get(`jobs/${identity.uid}`),
      this.rtdb.get('openJobs'),
    ]);

    let activeHoldsCount = 0;
    if (openJobs && typeof openJobs === 'object') {
      activeHoldsCount = Object.values(openJobs).filter((j) => j && j.uid === identity.uid).length;
    }

    let recentJobsCount = 0;
    let existingDuplicateJob = null;
    const oneHourAgo = Date.now() - 3600 * 1000;

    if (userJobs && typeof userJobs === 'object') {
      for (const j of Object.values(userJobs)) {
        if (!j) continue;
        if (Number(j.createdAt || 0) > oneHourAgo) recentJobsCount++;
        if (body.clientJobId && j.clientJobId === body.clientJobId) existingDuplicateJob = j;
      }
    }

    checkLimits({
      limits,
      pages: quote.pages,
      copies: quote.copies,
      activeHoldsCount,
      recentJobsCount,
      clientJobId: sanitizeStr(body.clientJobId, 60),
      existingDuplicateJob,
    });

    const jobId = newJobId();
    const filename = uniqueFilename(body.filename || 'Document', jobId);
    const meta = body.meta || {};
    const now = Date.now();
    const clientInfo = this.audit.getClientInfo(request);

    // 1. ATOMIC HOLD: Reserve funds in student wallet
    const held = await this.walletService.hold(identity.uid, jobId, quote.price);

    const job = new PrintJob({
      id: jobId,
      uid: identity.uid,
      status: JobStatus.RESERVING,
      price: quote.price,
      unitPrice: quote.unitPrice,
      pages: quote.pages,
      copies: quote.copies,
      color,
      filename,
      createdAt: now,
      clientJobId: sanitizeStr(body.clientJobId, 60),
      tool: sanitizeStr(meta.tool, 40),
      title: sanitizeStr(meta.title, 120),
      courseCode: sanitizeStr(meta.courseCode, 40),
      roll: sanitizeStr(meta.roll, 40),
    });

    // 2. INVARIANT INV-10: Persist job, openJobs, and printIndex BEFORE contacting provider
    await Promise.all([
      this.rtdb.put(`jobs/${identity.uid}/${jobId}`, job.toDatabaseRecord()),
      this.rtdb.put(`openJobs/${jobId}`, {
        id: jobId,
        uid: identity.uid,
        filename,
        price: quote.price,
        pages: quote.pages,
        copies: quote.copies,
        color,
        createdAt: now,
        recordId: null,
        expiresAt: null,
      }),
      this.rtdb.put(`printIndex/${fileKey(filename)}`, {
        uid: identity.uid,
        jobId,
        at: now,
      }),
    ]);

    // Archive job metadata in D1
    this.audit.scheduleTask(
      ctx,
      this.audit.logPrintJob(ctx, {
        jobId,
        uid: identity.uid,
        email: identity.email,
        roll: job.roll,
        courseCode: job.courseCode,
        title: job.title,
        tool: job.tool,
        pages: quote.pages,
        copies: quote.copies,
        color,
        price: quote.price,
        unitPrice: quote.unitPrice,
        status: JobStatus.RESERVING,
        createdAt: now,
      })
    );

    this.audit.scheduleTask(
      ctx,
      this.audit.logUserHistory(ctx, {
        uid: identity.uid,
        email: identity.email,
        displayName: identity.displayName,
        action: 'PRINT_REQUESTED',
        metadata: {
          jobId,
          pages: quote.pages,
          copies: quote.copies,
          price: quote.price,
          courseCode: job.courseCode,
          tool: job.tool,
        },
        ...clientInfo,
      })
    );

    // Archive PDF to R2 if bucket is bound
    this.audit.scheduleTask(
      ctx,
      this.audit.archivePdfToR2(ctx, {
        jobId,
        uid: identity.uid,
        filename,
        pdfBytes: bytes,
        roll: job.roll,
        courseCode: job.courseCode,
      })
    );

    // 3. DISPATCH TO PRINT PROVIDER
    let result;
    try {
      result = await this.provider.uploadAndQueue(bytes, {
        filename,
        copies: quote.copies,
        color,
      });
    } catch (err) {
      // INVARIANT INV-1 & INV-16: Release hold immediately on provider failure
      await this.walletService
        .release(identity.uid, job, JobStatus.FAILED, err.message)
        .catch(() => {});

      this.audit.scheduleTask(
        ctx,
        this.audit.updatePrintJobStatus(ctx, jobId, {
          status: JobStatus.FAILED,
          failureReason: err.message,
          releasedAt: Date.now(),
        })
      );

      this.audit.scheduleTask(
        ctx,
        this.audit.logUserHistory(ctx, {
          uid: identity.uid,
          email: identity.email,
          displayName: identity.displayName,
          action: 'PRINT_FAILED',
          metadata: {
            jobId,
            error: err.message,
            courseCode: job.courseCode,
          },
          ...clientInfo,
        })
      );

      const friendly = /insufficient|balance/i.test(err.message)
        ? 'The kiosk service is temporarily out of credit. Please contact the administrator.'
        : 'The kiosk service could not create an OTP right now. Your balance was not touched.';
      throw new ProviderError(friendly, 502, { detail: err.message });
    }

    const expiresAt = Date.now() + (result.validForSeconds || 3600) * 1000;

    // 4. UPDATE STATUS TO RESERVED
    job.transitionTo(JobStatus.RESERVED, {
      otp: result.otp,
      recordId: result.recordId,
      expiresAt,
    });

    await Promise.all([
      this.rtdb.patch(`jobs/${identity.uid}/${jobId}`, {
        status: JobStatus.RESERVED,
        otp: result.otp,
        recordId: result.recordId,
        expiresAt,
        uprintEstimate: result.cost,
        reservedAt: Date.now(),
      }),
      this.rtdb.patch(`openJobs/${jobId}`, {
        recordId: result.recordId,
        expiresAt,
      }),
    ]);

    this.audit.scheduleTask(
      ctx,
      this.audit.updatePrintJobStatus(ctx, jobId, {
        status: JobStatus.RESERVED,
        otp: result.otp,
        recordId: result.recordId,
        expiresAt,
        uprintEstimate: result.cost,
      })
    );

    this.audit.scheduleTask(
      ctx,
      this.audit.logUserHistory(ctx, {
        uid: identity.uid,
        email: identity.email,
        displayName: identity.displayName,
        action: 'PRINT_OTP_CREATED',
        metadata: {
          jobId,
          pages: quote.pages,
          copies: quote.copies,
          price: quote.price,
          courseCode: job.courseCode,
        },
        ...clientInfo,
      })
    );

    this.audit.scheduleTask(
      ctx,
      this.audit.logAudit(ctx, {
        action: 'PRINT_OTP_CREATED',
        actorUid: identity.uid,
        actorEmail: identity.email,
        details: {
          jobId,
          pages: quote.pages,
          copies: quote.copies,
          price: quote.price,
          courseCode: job.courseCode,
        },
        ...clientInfo,
      })
    );

    return {
      ok: true,
      jobId,
      otp: result.otp,
      recordId: result.recordId,
      filename,
      pages: quote.pages,
      copies: quote.copies,
      color,
      cost: quote.price,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      validForSeconds: result.validForSeconds,
      expiresAt,
      wallet: {
        balance: held.wallet.balance,
        reserved: held.wallet.reserved,
        available: held.available,
      },
    };
  }

  /**
   * User-initiated cancellation.
   * INVARIANT INV-6: Deletes print request at provider FIRST before releasing funds.
   */
  async cancelPrint(ctx, identity, jobId) {
    const job = await this.rtdb.get(`jobs/${identity.uid}/${jobId}`);
    if (!job) {
      throw new ValidationError('That print job could not be found.', 404);
    }
    if (job.status !== JobStatus.RESERVED && job.status !== JobStatus.RESERVING) {
      throw new ValidationError(`This print job is already ${job.status}.`, 409);
    }

    if (job.recordId) {
      const deleted = await this.provider.deletePrintRequest(job.recordId).catch(() => false);
      if (!deleted) {
        throw new ProviderError(
          'Could not cancel the code at the kiosk service. It will expire on its own and your balance will be returned.',
          502
        );
      }
    }

    const res = await this.walletService.release(
      identity.uid,
      { ...job, id: jobId },
      JobStatus.CANCELLED,
      'Cancelled by user.'
    );

      this.audit.scheduleTask(
        ctx,
        this.audit.updatePrintJobStatus(ctx, jobId, {
          status: JobStatus.CANCELLED,
          releasedAt: Date.now(),
          failureReason: 'Cancelled by user',
        })
      );

      const clientInfo = this.audit.getClientInfo(ctx && ctx.request);
      this.audit.scheduleTask(
        ctx,
        this.audit.logUserHistory(ctx, {
          uid: identity.uid,
          email: identity.email,
          displayName: identity.displayName,
          action: 'PRINT_CANCELLED',
          metadata: {
            jobId,
            courseCode: job.courseCode,
          },
          ...clientInfo,
        })
      );
      this.audit.scheduleTask(
        ctx,
        this.audit.logAudit(ctx, {
          action: 'PRINT_CANCELLED',
          actorUid: identity.uid,
          actorEmail: identity.email,
          details: {
            jobId,
            courseCode: job.courseCode,
          },
          ...clientInfo,
        })
      );

    return {
      ok: true,
      jobId,
      wallet: { ...res.wallet, available: res.available },
    };
  }
}

module.exports = {
  PrintService,
  base64ToUint8Array,
  isPdf,
  sanitizeStr,
};
