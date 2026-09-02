/**
 * lib/api/context.js — Dependency injection context builder.
 * -----------------------------------------------------------------------------
 * Built once per runtime isolate, caching OAuth tokens, database connections,
 * and authenticated session instances.
 */

'use strict';

const { ServiceAccount } = require('../infrastructure/firebase/service-account.js');
const { Rtdb } = require('../infrastructure/firebase/rtdb-client.js');
const { UprintBDAdapter } = require('../infrastructure/uprint/adapter.js');
const { WalletService } = require('../services/wallet-service.js');
const { AuthService } = require('../services/auth-service.js');
const { PrintService } = require('../services/print-service.js');
const { CatalogueService } = require('../services/catalogue-service.js');
const auditLogger = require('../services/audit-service.js');
const { LedgerError } = require('../domain/errors.js');

function createContext(env, workerCtx = null) {
  let rtdb = null;
  let coverSa = null;
  let session = null;
  let walletService = null;
  let authService = null;
  let printService = null;
  let catalogueService = null;

  const missing = [];
  if (!env.UPRINT_EMAIL || !env.UPRINT_PASSWORD) missing.push('UPRINT_EMAIL/UPRINT_PASSWORD');
  if (!env.FIREBASE_API_KEY) missing.push('FIREBASE_API_KEY');
  if (!env.LABDDB_DATABASE_URL) missing.push('LABDDB_DATABASE_URL');
  if (!env.LABDDB_SERVICE_ACCOUNT) missing.push('LABDDB_SERVICE_ACCOUNT');

  const adminEmail = env.ADMIN_EMAIL || 'htmlwithkhalid@gmail.com';
  const allowPublicCatalogue = env.ALLOW_PUBLIC_CATALOGUE_EDIT === 'true' || env.ALLOW_PUBLIC_CATALOGUE_EDIT === true;

  const ctx = {
    env,
    workerCtx,
    missing,
    adminEmail,

    get authOpts() {
      return {
        apiKey: env.FIREBASE_API_KEY,
        projectId: env.LABDDB_PROJECT_ID || null,
        adminEmail,
      };
    },

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
        session = new UprintBDAdapter({
          email: env.UPRINT_EMAIL,
          password: env.UPRINT_PASSWORD,
          baseUrl: env.UPRINT_BASE_URL,
        });
      }
      return session;
    },

    get walletService() {
      if (!walletService) {
        walletService = new WalletService(this.rtdb);
      }
      return walletService;
    },

    get authService() {
      if (!authService) {
        authService = new AuthService(this.rtdb, this.authOpts);
      }
      return authService;
    },

    get printService() {
      if (!printService) {
        printService = new PrintService({
          rtdb: this.rtdb,
          walletService: this.walletService,
          printProvider: this.session,
          auditService: auditLogger,
        });
      }
      return printService;
    },

    get catalogueService() {
      if (!catalogueService) {
        catalogueService = new CatalogueService(
          env.LDDB_DEMO_SERVICE_ACCOUNT ? this.coverServiceAccount : null,
          this.rtdb,
          this.authService,
          allowPublicCatalogue
        );
      }
      return catalogueService;
    },

    get auditLogger() {
      return auditLogger;
    },

    enqueue(task) {
      return this.session.queue.enqueue(task);
    },

    async ensureUser(identity, request) {
      return this.authService.ensureUser(identity, request);
    },
  };

  return ctx;
}

module.exports = {
  createContext,
};
