/**
 * src/worker.js — Cloudflare Worker entry point (production runtime).
 * -----------------------------------------------------------------------------
 * Deliberately thin. Every route, every rule about money, and the reconciler all
 * live in lib/api.js so that this and server.js (local dev) cannot drift.
 *
 * Two entry points:
 *   fetch()     — API routes, then static assets from public/
 *   scheduled() — the Cron Trigger that settles printed jobs and releases
 *                 expired holds. This is what makes "no print, no charge" true
 *                 without the user having to come back to the site.
 */

import api from '../lib/api.js';

const { createContext, handleApi, reconcile, json } = api;

// One context per isolate: it caches the OAuth access token, the imported RSA
// key, and the logged-in UprintBD cookie jar. Rebuilding those per request would
// blow the CPU budget and hammer UprintBD's login endpoint.
let cached = null;
function contextFor(env, workerCtx = null) {
  if (!cached || cached.env !== env) {
    cached = createContext(env, workerCtx);
  } else if (workerCtx) {
    cached.workerCtx = workerCtx;
  }
  return cached;
}

export default {
  async fetch(request, env, ctx) {
    const context = contextFor(env, ctx);

    const apiResponse = await handleApi(request, context);
    if (apiResponse) return apiResponse;

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('LabDDB UprintBD bridge', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },

  /**
   * Cron Trigger. Charges the jobs that printed, refunds the ones that did not.
   * Errors are logged rather than thrown: a failed pass must simply be retried a
   * minute later, and holds stay put in the meantime.
   */
  async scheduled(event, env, ctx) {
    const context = contextFor(env, ctx);
    try {
      const summary = await reconcile(
        { rtdb: context.rtdb, session: context.session, env, workerCtx: ctx },
        { reason: 'cron' }
      );
      console.log(
        `[cron] open=${summary.openJobs} settled=${summary.settled} ` +
          `released=${summary.released} unmatched=${summary.unmatched}` +
          (summary.skipped ? ' (skipped: lock held)' : '') +
          (summary.errors.length ? ` errors=${summary.errors.length}` : '')
      );
    } catch (err) {
      console.error('[cron] reconcile failed:', err && err.stack ? err.stack : err);
    }
  },
};
