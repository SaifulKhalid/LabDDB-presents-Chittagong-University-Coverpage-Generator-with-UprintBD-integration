/**
 * lib/api/handlers/admin.js — Administrative API route handlers.
 * -----------------------------------------------------------------------------
 * Gated by verified email match (INVARIANT INV-14).
 * Provides overview metrics, student top-up, adjustments, forced actions,
 * pricing configuration, and audit access.
 */

'use strict';

const { json } = require('../response.js');
const { reconcile } = require('../../services/reconcile-service.js');
const { LedgerError, ValidationError } = require('../../domain/errors.js');
const { DEFAULT_LIMITS } = require('../../domain/pricing.js');
const { normalizeWallet } = require('../../ledger.js');

function str(v, max = 120) {
  return String(v == null ? '' : v).slice(0, max);
}

async function requireAdmin(request, ctx) {
  return ctx.authService.verifyAdminRequest(request);
}

async function handleAdminOverview(request, ctx) {
  await requireAdmin(request, ctx);
  const [users, wallets, openJobs, state, pricing, limits] = await Promise.all([
    ctx.rtdb.get('users'),
    ctx.rtdb.get('wallets'),
    ctx.rtdb.get('openJobs'),
    ctx.rtdb.get('admin/uprint'),
    ctx.walletService.loadPricing(),
    ctx.walletService.loadLimits(),
  ]);

  const walletList = Object.values(wallets || {}).map(normalizeWallet);
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
    const w = normalizeWallet((wallets || {})[uid]);
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
  if (!uid) throw new ValidationError('User ID is required for top-up.', 400);

  const target = await ctx.rtdb.get(`users/${uid}`);
  if (!target) throw new ValidationError('User not found.', 404);

  const limits = await ctx.walletService.loadLimits();
  const amount = Math.round(Number(body.amount));
  if (!(amount >= limits.minTopUp && amount <= limits.maxTopUp)) {
    throw new ValidationError(
      `Top-up amount must be between ৳${limits.minTopUp} and ৳${limits.maxTopUp}.`,
      400
    );
  }

  const res = await ctx.walletService.topUp(uid, amount, {
    note: str(body.note, 160),
    method: str(body.method, 30) || 'bKash',
    byUid: admin.uid,
  });

  const clientInfo = ctx.auditLogger.getClientInfo(request);
  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logAudit(ctx, {
      action: 'topup',
      actorUid: admin.uid,
      actorEmail: admin.email,
      targetUid: uid,
      details: { amount, method: body.method || 'bKash', note: body.note, ledgerId: res.entry.id },
      ...clientInfo,
    })
  );

  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logLedgerTx(ctx, {
      id: res.entry.id,
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

  return json({
    ok: true,
    uid,
    wallet: { ...res.wallet, available: res.available },
    ledgerId: res.entry.id,
  });
}

async function handleAdminAdjust(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const uid = str(body.uid, 64);
  if (!uid) throw new ValidationError('User ID is required for adjustment.', 400);
  if (!(await ctx.rtdb.get(`users/${uid}`))) throw new ValidationError('User not found.', 404);

  const res = await ctx.walletService.adjust(uid, Number(body.delta), {
    note: str(body.note, 160),
    byUid: admin.uid,
    type: body.type === 'refund' ? 'refund' : 'adjustment',
  });

  const clientInfo = ctx.auditLogger.getClientInfo(request);
  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logAudit(ctx, {
      action: body.type === 'refund' ? 'refund' : 'adjustment',
      actorUid: admin.uid,
      actorEmail: admin.email,
      targetUid: uid,
      details: { delta: Number(body.delta), note: body.note, ledgerId: res.entry.id },
      ...clientInfo,
    })
  );

  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logLedgerTx(ctx, {
      id: res.entry.id,
      uid,
      type: body.type === 'refund' ? 'refund' : 'adjustment',
      amount: Number(body.delta),
      balanceAfter: res.wallet.balance,
      note: str(body.note, 160),
      byUid: admin.uid,
      timestamp: Date.now(),
    })
  );

  return json({
    ok: true,
    uid,
    wallet: { ...res.wallet, available: res.available },
    ledgerId: res.entry.id,
  });
}

async function handleAdminUserFlags(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const uid = str(body.uid, 64);
  if (!uid) throw new ValidationError('User ID is required.', 400);
  const target = await ctx.rtdb.get(`users/${uid}`);
  if (!target) throw new ValidationError('User not found.', 404);

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
  if (!Object.keys(changes).length) throw new ValidationError('No flags specified to change.', 400);

  const clientInfo = ctx.auditLogger.getClientInfo(request);
  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logAudit(ctx, {
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

  const emails = async () => {
    const users = (await ctx.rtdb.get('users')) || {};
    const out = {};
    for (const [uid, u] of Object.entries(users)) out[uid] = (u && u.email) || '';
    return out;
  };

  if (scope === 'open') {
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

async function handleAdminJobAction(request, ctx) {
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const jobId = str(body.jobId, 60);
  const uid = str(body.uid, 64);
  const action = str(body.action, 20);
  if (!jobId || !uid) throw new ValidationError('Job ID and UID are required.', 400);

  const job = await ctx.rtdb.get(`jobs/${uid}/${jobId}`);
  if (!job) throw new ValidationError('Job not found.', 404);
  const full = { ...job, id: jobId };
  const clientInfo = ctx.auditLogger.getClientInfo(request);

  if (action === 'settle') {
    const res = await ctx.walletService.settle(uid, full, {
      actualCost: job.actualCost ?? null,
      deviceId: job.deviceId || '',
    });

    ctx.auditLogger.scheduleTask(
      ctx,
      ctx.auditLogger.updatePrintJobStatus(ctx, jobId, {
        status: 'printed',
        settledAt: Date.now(),
      })
    );

    ctx.auditLogger.scheduleTask(
      ctx,
      ctx.auditLogger.logAudit(ctx, {
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
    const res = await ctx.walletService.release(
      uid,
      full,
      'expired',
      `Forced by admin ${admin.email}.`
    );

    ctx.auditLogger.scheduleTask(
      ctx,
      ctx.auditLogger.updatePrintJobStatus(ctx, jobId, {
        status: 'expired',
        releasedAt: Date.now(),
        failureReason: `Forced by admin ${admin.email}`,
      })
    );

    ctx.auditLogger.scheduleTask(
      ctx,
      ctx.auditLogger.logAudit(ctx, {
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

  throw new ValidationError(`Unknown action '${action}'.`, 400);
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
  rows.sort((a, b) => (b.createdAt || b.at || 0) - (a.createdAt || a.at || 0));

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
  const admin = await requireAdmin(request, ctx);
  const body = await request.json().catch(() => ({}));
  const patch = {};

  for (const key of ['mono', 'color', 'maxCopies']) {
    if (body[key] != null) {
      const n = Math.round(Number(body[key]));
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        throw new ValidationError(`${key} must be a whole number between 0 and 1000.`, 400);
      }
      patch[key] = n;
    }
  }
  if (Object.keys(patch).length) await ctx.rtdb.patch('config/pricing', patch);

  const limitPatch = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (body[key] != null) {
      const n = Math.round(Number(body[key]));
      if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${key} must be >= 0.`, 400);
      limitPatch[key] = n;
    }
  }
  if (Object.keys(limitPatch).length) await ctx.rtdb.patch('config/limits', limitPatch);

  const clientInfo = ctx.auditLogger.getClientInfo(request);
  ctx.auditLogger.scheduleTask(
    ctx,
    ctx.auditLogger.logAudit(ctx, {
      action: 'pricing_change',
      actorUid: admin.uid,
      actorEmail: admin.email,
      details: { pricing: patch, limits: limitPatch },
      ...clientInfo,
    })
  );

  return json({
    ok: true,
    pricing: await ctx.walletService.loadPricing(),
    limits: await ctx.walletService.loadLimits(),
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
    if (!key) throw new ValidationError('Which unmatched record?', 400);
    await ctx.rtdb.remove(`admin/uprint/unmatched/${key}`);

    const clientInfo = ctx.auditLogger.getClientInfo(request);
    ctx.auditLogger.scheduleTask(
      ctx,
      ctx.auditLogger.logAudit(ctx, {
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

async function handleAdminAuditLogs(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const result = await ctx.auditLogger.getAuditLogs(ctx, {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    action: url.searchParams.get('action'),
    search: url.searchParams.get('search'),
  });
  return json(result);
}

async function handleAdminAnalyticsSummary(request, ctx) {
  await requireAdmin(request, ctx);
  const result = await ctx.auditLogger.getAnalyticsSummary(ctx);
  return json(result);
}

async function handleAdminUserHistory(request, ctx) {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const uid = str(url.searchParams.get('uid'), 64);
  if (!uid) throw new ValidationError('User ID is required.', 400);
  const result = await ctx.auditLogger.getUserActivityHistory(ctx, uid, url.searchParams.get('limit'));
  return json(result);
}

async function handleAdminUprint(request, ctx) {
  await requireAdmin(request, ctx);
  const out = { ok: true };
  try {
    out.balance = await ctx.enqueue(() => ctx.session.getAccountBalance());
  } catch (err) {
    out.balance = null;
    out.balanceError = err.message;
  }
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    out.history = await ctx.enqueue(() => ctx.session.getPrintHistory({ sinceMs: sevenDaysAgo }));
  } catch (err) {
    out.history = [];
    out.historyError = err.message;
  }
  return json(out);
}

module.exports = {
  handleAdminOverview,
  handleAdminUsers,
  handleAdminTopUp,
  handleAdminAdjust,
  handleAdminUserFlags,
  handleAdminJobs,
  handleAdminJobAction,
  handleAdminLedger,
  handleAdminPricing,
  handleAdminReconcile,
  handleAdminUnmatched,
  handleAdminAuditLogs,
  handleAdminAnalyticsSummary,
  handleAdminUserHistory,
  handleAdminUprint,
};
