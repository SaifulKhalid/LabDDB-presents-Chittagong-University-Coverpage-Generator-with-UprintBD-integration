/**
 * api.js — every HTTP route, written once for both runtimes.
 * -----------------------------------------------------------------------------
 * Cloudflare Workers (`src/worker.js`) is production; the Node server
 * (`server.js`) is local development. Both are thin adapters over this module,
 * which speaks plain Fetch `Request` -> `Response`. Anything that moves money or
 * touches UprintBD lives here exactly once, so the two runtimes cannot drift
 * apart — a bug fixed locally is a bug fixed in production.
 *
 * Auth model:
 *   - anonymous: /api/health, /api/config
 *   - signed in: /api/me, /api/print, /api/jobs, /api/cancel, /api/cover-token
 *   - project admin (one hard-coded email): /api/admin/*
 *
 * The one shared UprintBD session is serialized: uploads are stateful (the site
 * hands back a record id per upload) so two concurrent mints through one cookie
 * jar could cross wires. Everything else runs in parallel.
 */

'use strict';

const { UprintSession, countPdfPages } = require('./uprint-bridge.js');
const { ServiceAccount, Rtdb } = require('./firebase-rest.js');
const { AuthError, requireUser, isProjectAdmin } = require('./auth-verify.js');
const ledger = require('./ledger.js');
const { LedgerError } = ledger;
const { reconcile, reconcileIfStale } = require('./reconcile.js');
const auditLogger = require('./audit-logger.js');

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function corsHeaders(env, request) {
  const allowed = (env && env.ALLOWED_ORIGIN) || '*';
  const origin = request ? request.headers.get('origin') : null;
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? origin || '*' : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
  });
}

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
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function emailKey(email) {
  return String(email || '').toLowerCase().replace(/[.$#[\]/@]/g, '_');
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max || 120);
}

// ---------------------------------------------------------------------------
// Context — built once per isolate, reused across requests
// ---------------------------------------------------------------------------
function createContext(env, workerCtx = null) {
  let session = null;
  let rtdb = null;
  let coverSa = null;
  let chain = Promise.resolve();

  const missing = [];
  if (!env.UPRINT_EMAIL || !env.UPRINT_PASSWORD) missing.push('UPRINT_EMAIL/UPRINT_PASSWORD');
  if (!env.FIREBASE_API_KEY) missing.push('FIREBASE_API_KEY');
  if (!env.LABDDB_DATABASE_URL) missing.push('LABDDB_DATABASE_URL');
  if (!env.LABDDB_SERVICE_ACCOUNT) missing.push('LABDDB_SERVICE_ACCOUNT');

  return {
    env,
    workerCtx,
    missing,

    get adminEmail() {
      return env.ADMIN_EMAIL || 'htmlwithkhalid@gmail.com';
    },

    get authOpts() {
      return {
        apiKey: env.FIREBASE_API_KEY,
        projectId: env.LABDDB_PROJECT_ID || null,
        adminEmail: this.adminEmail,
      };
    },

    /** The wallet/auth database (LabDDB-Pro). */
    get rtdb() {
      if (!rtdb) {
        if (!env.LABDDB_SERVICE_ACCOUNT || !env.LABDDB_DATABASE_URL) {
          throw new LedgerError('The wallet database is not configured on the server.', 503);
        }
        rtdb = new Rtdb({
          databaseURL: env.LABDDB_DATABASE_URL,
          serviceAccount: new ServiceAccount(env.LABDDB_SERVICE_ACCOUNT),
        });
      }
      return rtdb;
    },

    /** Service account for lddb-demo, used only to mint coverAdmin tokens. */
    get coverServiceAccount() {
      if (!coverSa) {
        if (!env.LDDB_DEMO_SERVICE_ACCOUNT) {
          throw new LedgerError('Coverpage admin access is not configured on the server.', 503);
        }
        coverSa = new ServiceAccount(env.LDDB_DEMO_SERVICE_ACCOUNT);
      }
      return coverSa;
    },

    get session() {
      if (!session) {
        if (!env.UPRINT_EMAIL || !env.UPRINT_PASSWORD) {
          throw new LedgerError('The kiosk bridge is not configured on the server.', 503);
        }
        session = new UprintSession({
          email: env.UPRINT_EMAIL,
          password: env.UPRINT_PASSWORD,
          baseUrl: env.UPRINT_BASE_URL,
        });
      }
      return session;
    },

    /**
     * Serialize work that drives the shared UprintBD cookie jar. An upload's
     * record id comes back on the redirect, so overlapping uploads could
     * attribute the wrong id — and therefore the wrong OTP — to a job.
     */
    enqueue(task) {
      const run = chain.then(task, task);
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },

    /** Upsert the user row on every authenticated call. */
    async ensureUser(identity, request = null) {
      const path = `users/${identity.uid}`;
      const existing = (await this.rtdb.get(path)) || null;
      const now = Date.now();
      const patch = {
        email: identity.email,
        displayName: identity.displayName,
        photoURL: identity.photoURL,
        lastSeenAt: now,
      };
      const clientInfo = auditLogger.getClientInfo(request);

      if (!existing) {
        patch.createdAt = now;
        patch.disabled = false;
        await this.rtdb.patch(path, patch);
        // Give a brand-new wallet real zeros so the UI never shows a blank.
        await this.rtdb.transaction(`wallets/${identity.uid}`, (cur) =>
          cur ? undefined : { balance: 0, reserved: 0, updatedAt: now, applied: {} }
        );
        await this.rtdb.put(`adminIndex/byEmail/${emailKey(identity.email)}`, identity.uid);
        auditLogger.scheduleTask(this, auditLogger.logUserHistory(this, {
          uid: identity.uid,
          email: identity.email,
          displayName: identity.displayName,
          action: 'sign_up',
          metadata: { provider: identity.provider },
          ...clientInfo,
        }));
      } else {
        await this.rtdb.patch(path, patch);
        if (existing.email !== identity.email) {
          await this.rtdb.put(`adminIndex/byEmail/${emailKey(identity.email)}`, identity.uid);
        }
        auditLogger.scheduleTask(this, auditLogger.logUserHistory(this, {
          uid: identity.uid,
          email: identity.email,
          displayName: identity.displayName,
          action: 'sign_in',
          ...clientInfo,
        }));
      }
      return existing ? { ...existing, ...patch } : patch;
    },
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(ctx) {
  return json({
    ok: ctx.missing.length === 0,
    service: 'labddb-uprint-bridge',
    version: 2,
    time: new Date().toISOString(),
    configured: {
      kiosk: !!(ctx.env.UPRINT_EMAIL && ctx.env.UPRINT_PASSWORD),
      auth: !!ctx.env.FIREBASE_API_KEY,
      wallet: !!(ctx.env.LABDDB_SERVICE_ACCOUNT && ctx.env.LABDDB_DATABASE_URL),
      coverAdmin: !!ctx.env.LDDB_DEMO_SERVICE_ACCOUNT,
    },
    missing: ctx.missing,
  });
}

/** Public: lets the anonymous cost calculator show the real prices. */
async function handleConfig(ctx) {
  let pricing = ledger.DEFAULT_PRICING;
  let limits = ledger.DEFAULT_LIMITS;
  try {
    pricing = await ledger.loadPricing(ctx.rtdb);
    limits = await ledger.loadLimits(ctx.rtdb);
  } catch (_) {
    // Fall back to defaults so the generator still prices correctly offline.
  }
  return json({
    ok: true,
    pricing,
    limits: { maxCopies: pricing.maxCopies, maxPagesPerJob: limits.maxPagesPerJob },
  });
}

async function handleMe(request, ctx) {
  const identity = await requireUser(request, ctx.authOpts);
  const user = await ctx.ensureUser(identity, request);
  const [wallet, roles, pricing] = await Promise.all([
    ctx.rtdb.get(`wallets/${identity.uid}`),
    ctx.rtdb.get(`roles/${identity.uid}`),
    ledger.loadPricing(ctx.rtdb),
  ]);
  const w = ledger.normalizeWallet(wallet);
  return json({
    ok: true,
    user: {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      photoURL: identity.photoURL,
      disabled: !!user.disabled,
    },
    wallet: { balance: w.balance, reserved: w.reserved, available: w.balance - w.reserved },
    roles: {
      coverAdmin: !!(roles && roles.coverAdmin),
      projectAdmin: isProjectAdmin(identity, ctx.adminEmail),
    },
    pricing,
  });
}

/**
 * The whole point of the service. Mint a kiosk OTP against a hold, never a charge.
 */
async function handlePrint(request, ctx) {
  const identity = await requireUser(request, ctx.authOpts);
  const user = await ctx.ensureUser(identity, request);
  if (user.disabled) {
    throw new LedgerError('This account has been disabled. Please contact the admin.', 403);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.pdfBase64) {
    throw new LedgerError('No document was received.', 400);
  }

  const bytes = base64ToUint8Array(body.pdfBase64);
  if (!bytes.length) throw new LedgerError('The document was empty.', 400);
  if (bytes.length > MAX_PDF_BYTES) throw new LedgerError('That document is too large.', 413);
  if (!isPdf(bytes)) throw new LedgerError('That file is not a PDF.', 400);

  // A stale reconciler must never permanently lock a student's money, so top it
  // up here as well as from cron. Failures inside are swallowed by design.
  await reconcileIfStale({ rtdb: ctx.rtdb, session: ctx.session, env: ctx.env, workerCtx: ctx.workerCtx });

  const [pricing, limits] = await Promise.all([
    ledger.loadPricing(ctx.rtdb),
    ledger.loadLimits(ctx.rtdb),
  ]);

  const color = !!body.color;
  const pages = countPdfPages(bytes);
  const quote = ledger.priceJob({ pages, copies: body.copies, color, pricing });

  await ledger.checkLimits(ctx.rtdb, identity.uid, {
    limits,
    pages: quote.pages,
    copies: quote.copies,
    pricing,
    clientJobId: str(body.clientJobId, 60),
  });

  const jobId = ledger.newJobId();
  const filename = ledger.uniqueFilename(body.filename || 'Document', jobId);
  const meta = body.meta || {};
  const now = Date.now();
  const clientInfo = auditLogger.getClientInfo(request);

  // 1. Reserve. Throws 402 with the available balance if there isn't enough.
  const held = await ledger.hold(ctx.rtdb, identity.uid, jobId, quote.price);

  const job = {
    id: jobId,
    uid: identity.uid,
    status: 'reserving',
    price: quote.price,
    unitPrice: quote.unitPrice,
    pages: quote.pages,
    copies: quote.copies,
    color,
    filename,
    createdAt: now,
    clientJobId: str(body.clientJobId, 60),
    tool: str(meta.tool, 40),
    title: str(meta.title, 120),
    courseCode: str(meta.courseCode, 40),
    roll: str(meta.roll, 40),
  };

  // 2. Persist the job, the reconciler's working set, and the filename index
  //    BEFORE talking to UprintBD. If the mint crashes half-way, the hold is
  //    still discoverable and the filename is still attributable — which is what
  //    keeps a crash from looking like an unexplained print later.
  await ctx.rtdb.put(`jobs/${identity.uid}/${jobId}`, job);
  await ctx.rtdb.put(`openJobs/${jobId}`, {
    uid: identity.uid,
    filename,
    price: quote.price,
    pages: quote.pages,
    copies: quote.copies,
    color,
    createdAt: now,
    recordId: null,
    expiresAt: null,
  });
  await ctx.rtdb.put(`printIndex/${ledger.fileKey(filename)}`, {
    uid: identity.uid,
    jobId,
    at: now,
  });

  // Archive job metadata in Cloudflare D1 (saving storage: PDF binary is not stored)
  auditLogger.scheduleTask(
    ctx,
    auditLogger.logPrintJob(ctx, {
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
      status: 'reserving',
      createdAt: now,
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logLedgerTx(ctx, {
      id: `hold_${jobId}`,
      uid: identity.uid,
      type: 'hold',
      amount: -quote.price,
      balanceAfter: held.wallet.balance - quote.price,
      jobId,
      note: `Hold for ${quote.pages}p × ${quote.copies} ${color ? 'colour' : 'b/w'}`,
      timestamp: now,
    })
  );

  // 3. Mint the OTP at UprintBD.
  let result;
  try {
    result = await ctx.enqueue(() =>
      ctx.session.printAndGetOtp(bytes, {
        filename,
        copies: quote.copies,
        color,
      })
    );
  } catch (err) {
    // Nothing was queued, so nothing can print. Hand the money straight back.
    await ledger.release(ctx.rtdb, identity.uid, job, 'failed', err.message).catch(() => {});
    auditLogger.scheduleTask(
      ctx,
      auditLogger.updatePrintJobStatus(ctx, jobId, {
        status: 'failed',
        failureReason: err.message,
        releasedAt: Date.now(),
      })
    );
    auditLogger.scheduleTask(
      ctx,
      auditLogger.logLedgerTx(ctx, {
        id: `release_${jobId}`,
        uid: identity.uid,
        type: 'release',
        amount: quote.price,
        balanceAfter: held.wallet.balance,
        jobId,
        note: `Released failed hold: ${err.message}`,
        timestamp: Date.now(),
      })
    );
    const friendly = /insufficient|balance/i.test(err.message)
      ? 'The kiosk service is temporarily out of credit. Please tell the admin.'
      : 'The kiosk service could not create a code right now. Your balance was not touched.';
    throw new LedgerError(friendly, 502, { detail: err.message });
  }

  const expiresAt = Date.now() + result.validForSeconds * 1000;
  const patch = {
    status: 'reserved',
    otp: result.otp,
    recordId: result.recordId,
    expiresAt,
    uprintEstimate: result.cost,
    reservedAt: Date.now(),
  };
  await ctx.rtdb.patch(`jobs/${identity.uid}/${jobId}`, patch);
  await ctx.rtdb.patch(`openJobs/${jobId}`, {
    recordId: result.recordId,
    expiresAt,
  });

  auditLogger.scheduleTask(
    ctx,
    auditLogger.updatePrintJobStatus(ctx, jobId, {
      status: 'reserved',
      otp: result.otp,
      recordId: result.recordId,
      expiresAt,
      uprintEstimate: result.cost,
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logUserHistory(ctx, {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      action: 'otp_mint',
      metadata: {
        jobId,
        otp: result.otp,
        pages: quote.pages,
        cost: quote.price,
        courseCode: job.courseCode,
      },
      ...clientInfo,
    })
  );

  return json({
    ok: true,
    jobId,
    otp: result.otp,
    recordId: result.recordId,
    filename,
    pages: quote.pages,
    copies: quote.copies,
    color,
    cost: quote.price, // what the user pays
    unitPrice: quote.unitPrice,
    currency: pricing.currency,
    validForSeconds: result.validForSeconds,
    expiresAt,
    wallet: {
      balance: held.wallet.balance,
      reserved: held.wallet.reserved,
      available: held.available,
    },
  });
}

/** A user's own recent jobs. The history drawer reads this. */
async function handleJobs(request, ctx) {
  const identity = await requireUser(request, ctx.authOpts);
  const jobs = (await ledger.recentJobs(ctx.rtdb, identity.uid, 25)).map((j) => ({
    id: j.id,
    status: j.status,
    otp: j.status === 'reserved' ? j.otp : null, // expired codes are useless
    price: j.price,
    pages: j.pages,
    copies: j.copies,
    color: !!j.color,
    title: j.title || '',
    courseCode: j.courseCode || '',
    filename: j.filename,
    createdAt: j.createdAt,
    expiresAt: j.expiresAt || null,
    settledAt: j.settledAt || null,
    actualCost: j.actualCost ?? null,
  }));
  return json({ ok: true, jobs });
}

/** Cancel one of your own unused codes and get the hold back immediately. */
async function handleCancel(request, ctx) {
  const identity = await requireUser(request, ctx.authOpts);
  const body = await request.json().catch(() => ({}));
  const jobId = str(body.jobId, 60);
  const job = jobId ? await ctx.rtdb.get(`jobs/${identity.uid}/${jobId}`) : null;

  if (!job) throw new LedgerError('That print could not be found.', 404);
  if (job.status !== 'reserved' && job.status !== 'reserving') {
    throw new LedgerError(`This print is already ${job.status}.`, 409);
  }

  // Kill the code before freeing the money — same ordering rule as the
  // reconciler, for the same reason.
  if (job.recordId) {
    const deleted = await ctx
      .enqueue(() => ctx.session.deletePrintRequest(job.recordId))
      .catch(() => false);
    if (!deleted) {
      throw new LedgerError(
        'Could not cancel the code at the kiosk service. It will expire on its own and your balance will be returned.',
        502
      );
    }
  }

  const res = await ledger.release(
    ctx.rtdb,
    identity.uid,
    { ...job, id: jobId },
    'cancelled',
    'Cancelled by user.'
  );

  const clientInfo = auditLogger.getClientInfo(request);
  auditLogger.scheduleTask(
    ctx,
    auditLogger.updatePrintJobStatus(ctx, jobId, {
      status: 'cancelled',
      releasedAt: Date.now(),
      failureReason: 'Cancelled by user',
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logLedgerTx(ctx, {
      id: `release_${jobId}`,
      uid: identity.uid,
      type: 'release',
      amount: Math.round(job.price),
      balanceAfter: res.wallet.balance,
      jobId,
      note: 'Cancelled by user',
      timestamp: Date.now(),
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logUserHistory(ctx, {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      action: 'job_cancel',
      metadata: { jobId },
      ...clientInfo,
    })
  );

  return json({
    ok: true,
    jobId,
    wallet: { ...res.wallet, available: res.available },
  });
}

/**
 * Mint a scoped write token for the lddb-demo project (courses/students).
 *
 * Open to all users/visitors as requested, so anyone can manage the course catalogue
 * from the Catalogue Admin panel.
 */
async function handleCoverToken(request, ctx) {
  let uid = 'public_admin';
  let email = 'admin@cu.ac.bd';
  try {
    const identity = await requireUser(request, ctx.authOpts);
    if (identity && identity.uid) {
      uid = identity.uid;
      email = identity.email || email;
    }
  } catch (_) {
    // Open to all without requiring sign-in
  }
  const token = await ctx.coverServiceAccount.createCustomToken(uid, {
    coverAdmin: true,
    email,
  });
  return json({ ok: true, token, expiresIn: 3600 });
}

// ---------------------------------------------------------------------------
// Project admin
// ---------------------------------------------------------------------------
async function requireAdmin(request, ctx) {
  const identity = await requireUser(request, ctx.authOpts);
  if (!isProjectAdmin(identity, ctx.adminEmail)) {
    throw new AuthError('This area is restricted.', 403);
  }
  return identity;
}

async function handleAdminOverview(request, ctx) {
  await requireAdmin(request, ctx);
  const [users, wallets, openJobs, state, pricing, limits] = await Promise.all([
    ctx.rtdb.get('users'),
    ctx.rtdb.get('wallets'),
    ctx.rtdb.get('openJobs'),
    ctx.rtdb.get('admin/uprint'),
    ledger.loadPricing(ctx.rtdb),
    ledger.loadLimits(ctx.rtdb),
  ]);

  const walletList = Object.values(wallets || {}).map(ledger.normalizeWallet);
  const open = Object.values(openJobs || {});
  const unmatched = Object.keys((state && state.unmatched) || {}).length;

  return json({
    ok: true,
    uprint: {
      accountBalance: (state && state.accountBalance) ?? null,
      accountBalanceAt: (state && state.accountBalanceAt) ?? null,
      lastReconcileAt: (state && state.lastReconcileAt) ?? null,
      lastRun: (state && state.lastRun) || null,
      lastError: (state && state.lastError) || null,
      unmatchedPrints: unmatched,
    },
    totals: {
      users: Object.keys(users || {}).length,
      floatHeld: walletList.reduce((s, w) => s + w.balance, 0),
      reserved: walletList.reduce((s, w) => s + w.reserved, 0),
      openHolds: open.length,
      openHoldValue: open.reduce((s, j) => s + (Number(j.price) || 0), 0),
    },
    pricing,
    limits,
  });
}

async function handleAdminUsers(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  const [users, wallets, roles] = await Promise.all([
    ctx.rtdb.get('users'),
    ctx.rtdb.get('wallets'),
    ctx.rtdb.get('roles'),
  ]);

  let list = Object.entries(users || {}).map(([uid, u]) => {
    const w = ledger.normalizeWallet((wallets || {})[uid]);
    return {
      uid,
      email: u.email || '',
      displayName: u.displayName || '',
      photoURL: u.photoURL || '',
      disabled: !!u.disabled,
      createdAt: u.createdAt || 0,
      lastSeenAt: u.lastSeenAt || 0,
      balance: w.balance,
      reserved: w.reserved,
      available: w.balance - w.reserved,
      coverAdmin: !!((roles || {})[uid] && (roles || {})[uid].coverAdmin),
    };
  });

  if (q) {
    list = list.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.uid === q
    );
  }
  list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  return json({ ok: true, users: list.slice(0, 200), count: list.length });
}

async function handleAdminTopUp(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const uid = str(body.uid, 64);
  if (!uid) throw new LedgerError('Which user?', 400);

  const target = await ctx.rtdb.get(`users/${uid}`);
  if (!target) throw new LedgerError('No such user.', 404);

  const limits = await ledger.loadLimits(ctx.rtdb);
  const amount = Math.round(Number(body.amount));
  if (!(amount >= limits.minTopUp && amount <= limits.maxTopUp)) {
    throw new LedgerError(
      `Top-up must be between ৳${limits.minTopUp} and ৳${limits.maxTopUp}.`,
      400
    );
  }

  const res = await ledger.topUp(ctx.rtdb, uid, amount, {
    note: str(body.note, 160), // bKash TID goes here
    method: str(body.method, 30) || 'bKash',
    byUid: admin.uid,
  });

  const clientInfo = auditLogger.getClientInfo(request);
  auditLogger.scheduleTask(
    ctx,
    auditLogger.logAudit(ctx, {
      action: 'topup',
      actorUid: admin.uid,
      actorEmail: admin.email,
      targetUid: uid,
      details: { amount, method: body.method || 'bKash', note: body.note, ledgerId: res.ledgerId },
      ...clientInfo,
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logLedgerTx(ctx, {
      id: res.ledgerId,
      uid,
      type: 'topup',
      amount,
      balanceAfter: res.wallet.balance,
      note: str(body.note, 160),
      byUid: admin.uid,
      method: str(body.method, 30) || 'bKash',
      timestamp: Date.now(),
    })
  );

  return json({ ok: true, uid, wallet: { ...res.wallet, available: res.available }, ledgerId: res.ledgerId });
}

async function handleAdminAdjust(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const uid = str(body.uid, 64);
  if (!uid) throw new LedgerError('Which user?', 400);
  if (!(await ctx.rtdb.get(`users/${uid}`))) throw new LedgerError('No such user.', 404);

  const res = await ledger.adjust(ctx.rtdb, uid, Number(body.delta), {
    note: str(body.note, 160),
    byUid: admin.uid,
    type: body.type === 'refund' ? 'refund' : 'adjustment',
  });

  const clientInfo = auditLogger.getClientInfo(request);
  auditLogger.scheduleTask(
    ctx,
    auditLogger.logAudit(ctx, {
      action: body.type === 'refund' ? 'refund' : 'adjustment',
      actorUid: admin.uid,
      actorEmail: admin.email,
      targetUid: uid,
      details: { delta: Number(body.delta), note: body.note, ledgerId: res.ledgerId },
      ...clientInfo,
    })
  );

  auditLogger.scheduleTask(
    ctx,
    auditLogger.logLedgerTx(ctx, {
      id: res.ledgerId,
      uid,
      type: body.type === 'refund' ? 'refund' : 'adjustment',
      amount: Number(body.delta),
      balanceAfter: res.wallet.balance,
      note: str(body.note, 160),
      byUid: admin.uid,
      timestamp: Date.now(),
    })
  );

  return json({ ok: true, uid, wallet: { ...res.wallet, available: res.available }, ledgerId: res.ledgerId });
}

async function handleAdminUserFlags(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const uid = str(body.uid, 64);
  if (!uid) throw new LedgerError('Which user?', 400);
  const target = await ctx.rtdb.get(`users/${uid}`);
  if (!target) throw new LedgerError('No such user.', 404);

  const changes = {};
  if (typeof body.disabled === 'boolean') {
    await ctx.rtdb.patch(`users/${uid}`, {
      disabled: body.disabled,
      disabledBy: body.disabled ? admin.uid : null,
      disabledAt: body.disabled ? Date.now() : null,
    });
    changes.disabled = body.disabled;
  }
  if (typeof body.coverAdmin === 'boolean') {
    // The project admin's own access is by email and cannot be revoked here.
    if (body.coverAdmin) {
      await ctx.rtdb.put(`roles/${uid}`, {
        coverAdmin: true,
        grantedBy: admin.uid,
        grantedAt: Date.now(),
      });
    } else {
      await ctx.rtdb.remove(`roles/${uid}`);
    }
    changes.coverAdmin = body.coverAdmin;
  }
  if (!Object.keys(changes).length) throw new LedgerError('Nothing to change.', 400);

  const clientInfo = auditLogger.getClientInfo(request);
  auditLogger.scheduleTask(
    ctx,
    auditLogger.logAudit(ctx, {
      action: 'user_flags',
      actorUid: admin.uid,
      actorEmail: admin.email,
      targetUid: uid,
      details: changes,
      ...clientInfo,
    })
  );

  return json({ ok: true, uid, changes });
}

async function handleAdminJobs(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') || 'open';

  // Email rather than a raw uid: the admin is usually looking at this table
  // because a specific person said their code did not work.
  const emails = async () => {
    const users = (await ctx.rtdb.get('users')) || {};
    const out = {};
    for (const [uid, u] of Object.entries(users)) out[uid] = (u && u.email) || '';
    return out;
  };

  if (scope === 'open') {
    // `openJobs` is the reconciler's working set, so it deliberately carries only
    // what the reconciler needs — no status, no OTP. Join the full job record back
    // in so the admin can see the code they are being asked about. Presence in
    // `openJobs` is itself the status: settle and release both remove the entry.
    const [open, all, byUid] = await Promise.all([
      ctx.rtdb.get('openJobs'),
      ctx.rtdb.get('jobs'),
      emails(),
    ]);
    const jobs = Object.entries(open || {}).map(([id, j]) => {
      const full = (((all || {})[j.uid] || {})[id]) || {};
      return { ...full, ...j, id, status: full.status || 'reserving', email: byUid[j.uid] || '' };
    });
    jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ ok: true, scope, jobs, count: jobs.length });
  }

  // Recent activity across everyone. Fine at this scale; if the user count grows
  // this becomes a per-day index instead of a full scan.
  const [all, byUid] = await Promise.all([ctx.rtdb.get('jobs'), emails()]);
  const jobs = [];
  for (const [uid, byId] of Object.entries(all || {})) {
    for (const [id, j] of Object.entries(byId || {})) {
      jobs.push({ id, uid, email: byUid[uid] || '', ...j });
    }
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ ok: true, scope: 'all', jobs: jobs.slice(0, 200), count: jobs.length });
}

/**
 * Manual override for a stuck job. `settle` charges it, `expire` refunds it —
 * both go through the same idempotent ledger paths the reconciler uses, so an
 * admin cannot double-charge by clicking twice.
 */
async function handleAdminJobAction(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const jobId = str(body.jobId, 60);
  const uid = str(body.uid, 64);
  const action = str(body.action, 20);
  if (!jobId || !uid) throw new LedgerError('Which job?', 400);

  const job = await ctx.rtdb.get(`jobs/${uid}/${jobId}`);
  if (!job) throw new LedgerError('No such job.', 404);
  const full = { ...job, id: jobId };
  const clientInfo = auditLogger.getClientInfo(request);

  if (action === 'settle') {
    const res = await ledger.settle(ctx.rtdb, uid, full, {
      actualCost: job.actualCost ?? null,
      deviceId: job.deviceId || '',
    });

    auditLogger.scheduleTask(
      ctx,
      auditLogger.updatePrintJobStatus(ctx, jobId, {
        status: 'printed',
        settledAt: Date.now(),
      })
    );

    auditLogger.scheduleTask(
      ctx,
      auditLogger.logAudit(ctx, {
        action: 'force_settle',
        actorUid: admin.uid,
        actorEmail: admin.email,
        targetUid: uid,
        details: { jobId, price: job.price },
        ...clientInfo,
      })
    );

    return json({ ok: true, action, wallet: { ...res.wallet, available: res.available } });
  }

  if (action === 'expire' || action === 'cancel') {
    if (job.recordId) {
      await ctx.enqueue(() => ctx.session.deletePrintRequest(job.recordId)).catch(() => false);
    }
    const res = await ledger.release(
      ctx.rtdb,
      uid,
      full,
      'expired',
      `Forced by admin ${admin.email}.`
    );

    auditLogger.scheduleTask(
      ctx,
      auditLogger.updatePrintJobStatus(ctx, jobId, {
        status: 'expired',
        releasedAt: Date.now(),
        failureReason: `Forced by admin ${admin.email}`,
      })
    );

    auditLogger.scheduleTask(
      ctx,
      auditLogger.logAudit(ctx, {
        action: 'force_expire',
        actorUid: admin.uid,
        actorEmail: admin.email,
        targetUid: uid,
        details: { jobId },
        ...clientInfo,
      })
    );

    return json({ ok: true, action, wallet: { ...res.wallet, available: res.available } });
  }

  throw new LedgerError('Unknown action.', 400);
}

async function handleAdminLedger(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const uid = str(url.searchParams.get('uid'), 64);

  const rows = [];
  if (uid) {
    const byId = (await ctx.rtdb.get(`ledger/${uid}`)) || {};
    for (const [id, e] of Object.entries(byId)) rows.push({ id, uid, ...e });
  } else {
    const all = (await ctx.rtdb.get('ledger')) || {};
    for (const [u, byId] of Object.entries(all)) {
      for (const [id, e] of Object.entries(byId || {})) rows.push({ id, uid: u, ...e });
    }
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const totals = rows.reduce(
    (t, r) => {
      if (r.type === 'topup') t.topups += r.amount;
      else if (r.type === 'charge') t.revenue += Math.abs(r.amount);
      else t.adjustments += r.amount;
      return t;
    },
    { topups: 0, revenue: 0, adjustments: 0 }
  );

  return json({ ok: true, entries: rows.slice(0, 500), count: rows.length, totals });
}

async function handleAdminPricing(request, ctx) {
  await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const patch = {};

  for (const key of ['mono', 'color', 'maxCopies']) {
    if (body[key] != null) {
      const n = Math.round(Number(body[key]));
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        throw new LedgerError(`${key} must be a whole number between 0 and 1000.`, 400);
      }
      patch[key] = n;
    }
  }
  if (Object.keys(patch).length) await ctx.rtdb.patch('config/pricing', patch);

  const limitPatch = {};
  for (const key of Object.keys(ledger.DEFAULT_LIMITS)) {
    if (body[key] != null) {
      const n = Math.round(Number(body[key]));
      if (!Number.isFinite(n) || n < 0) throw new LedgerError(`${key} must be >= 0.`, 400);
      limitPatch[key] = n;
    }
  }
  if (Object.keys(limitPatch).length) await ctx.rtdb.patch('config/limits', limitPatch);

  const clientInfo = auditLogger.getClientInfo(request);
  auditLogger.scheduleTask(
    ctx,
    auditLogger.logAudit(ctx, {
      action: 'pricing_change',
      actorUid: admin.uid,
      actorEmail: admin.email,
      details: { pricing: patch, limits: limitPatch },
      ...clientInfo,
    })
  );

  return json({
    ok: true,
    pricing: await ledger.loadPricing(ctx.rtdb),
    limits: await ledger.loadLimits(ctx.rtdb),
  });
}

async function handleAdminReconcile(request, ctx) {
  await requireAdmin(request, ctx);
  const summary = await reconcile(
    { rtdb: ctx.rtdb, session: ctx.session, env: ctx.env, workerCtx: ctx.workerCtx },
    { reason: 'admin', force: true }
  );
  return json({ ok: true, summary });
}

async function handleAdminUnmatched(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const key = str(body.key, 200);
    if (!key) throw new LedgerError('Which row?', 400);
    await ctx.rtdb.remove(`admin/uprint/unmatched/${key}`);

    const clientInfo = auditLogger.getClientInfo(request);
    auditLogger.scheduleTask(
      ctx,
      auditLogger.logAudit(ctx, {
        action: 'unmatched_clear',
        actorUid: admin.uid,
        actorEmail: admin.email,
        details: { key },
        ...clientInfo,
      })
    );

    return json({ ok: true, cleared: key });
  }
  const rows = (await ctx.rtdb.get('admin/uprint/unmatched')) || {};
  return json({
    ok: true,
    rows: Object.entries(rows).map(([key, r]) => ({ key, ...r })),
  });
}

/** Admin audit log query endpoint (D1). */
async function handleAdminAuditLogs(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const result = await auditLogger.getAuditLogs(ctx, {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    action: url.searchParams.get('action'),
    search: url.searchParams.get('search'),
  });
  return json(result);
}

/** Admin analytics summary endpoint (D1). */
async function handleAdminAnalyticsSummary(request, ctx) {
  await requireAdmin(request, ctx);
  const result = await auditLogger.getAnalyticsSummary(ctx);
  return json(result);
}

/** Admin user activity history endpoint (D1). */
async function handleAdminUserHistory(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const uid = str(url.searchParams.get('uid'), 64);
  if (!uid) throw new LedgerError('Which user?', 400);
  const result = await auditLogger.getUserActivityHistory(ctx, uid, url.searchParams.get('limit'));
  return json(result);
}

/** The institutional UprintBD account itself. Admin-only: it is our cost side. */
async function handleAdminUprint(request, ctx) {
  await requireAdmin(request, ctx);
  const out = { ok: true };
  try {
    out.balance = await ctx.enqueue(() => ctx.session.getAccountBalance());
  } catch (err) {
    out.balanceError = err.message;
  }
  try {
    out.history = (await ctx.enqueue(() => ctx.session.getPrintHistory({ sinceMs: Date.now() - 7 * 864e5 }))).slice(
      0,
      100
    );
  } catch (err) {
    out.historyError = err.message;
  }
  return json(out);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const ROUTES = [
  ['GET', '/api/health', (req, ctx) => handleHealth(ctx)],
  ['GET', '/api/config', (req, ctx) => handleConfig(ctx)],
  ['GET', '/api/me', handleMe],
  ['POST', '/api/print', handlePrint],
  ['GET', '/api/jobs', handleJobs],
  ['POST', '/api/cancel', handleCancel],
  ['POST', '/api/cover-token', handleCoverToken],
  ['GET', '/api/admin/overview', handleAdminOverview],
  ['GET', '/api/admin/users', handleAdminUsers],
  ['POST', '/api/admin/topup', handleAdminTopUp],
  ['POST', '/api/admin/adjust', handleAdminAdjust],
  ['POST', '/api/admin/user-flags', handleAdminUserFlags],
  ['GET', '/api/admin/jobs', handleAdminJobs],
  ['POST', '/api/admin/job-action', handleAdminJobAction],
  ['GET', '/api/admin/ledger', handleAdminLedger],
  ['POST', '/api/admin/pricing', handleAdminPricing],
  ['POST', '/api/admin/reconcile', handleAdminReconcile],
  ['GET', '/api/admin/unmatched', handleAdminUnmatched],
  ['POST', '/api/admin/unmatched', handleAdminUnmatched],
  ['GET', '/api/admin/uprint', handleAdminUprint],
  ['GET', '/api/admin/audit-logs', handleAdminAuditLogs],
  ['GET', '/api/admin/analytics/summary', handleAdminAnalyticsSummary],
  ['GET', '/api/admin/user-history', handleAdminUserHistory],
];

/**
 * Handle an API request. Returns null for non-API paths so the caller can serve
 * static assets.
 */
async function handleApi(request, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  const cors = corsHeaders(ctx.env, request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const route = ROUTES.find(([method, path]) => path === url.pathname && method === request.method);
  if (!route) {
    const pathExists = ROUTES.some(([, path]) => path === url.pathname);
    return json(
      { ok: false, error: pathExists ? 'Method not allowed.' : 'Unknown endpoint.' },
      pathExists ? 405 : 404,
      cors
    );
  }

  try {
    const res = await route[2](request, ctx);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    const known = err instanceof AuthError || err instanceof LedgerError;
    if (!known) console.error(`[api] ${url.pathname}:`, err && err.stack ? err.stack : err);
    const payload = {
      ok: false,
      error: known ? err.message : 'Something went wrong on our side. Please try again.',
    };
    // Structured extras the UI needs (available balance on a 402, etc.).
    for (const key of ['code', 'required', 'available', 'balance', 'reserved', 'jobId']) {
      if (err && err[key] !== undefined) payload[key] = err[key];
    }
    return json(payload, status, cors);
  }
}

module.exports = {
  createContext,
  handleApi,
  corsHeaders,
  json,
  base64ToUint8Array,
  isPdf,
  emailKey,
  reconcile,
  MAX_PDF_BYTES,
};
