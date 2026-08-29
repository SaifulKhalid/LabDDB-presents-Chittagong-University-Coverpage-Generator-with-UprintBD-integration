/* =============================================================================
   labddb-config.js — one place for every environment value the browser needs.
   -----------------------------------------------------------------------------
   Two Firebase projects, on purpose:

     LabDDB-Pro  authentication + the DDB wallet. Shared by all LabDDB tools, so
                 one Google sign-in works everywhere.
     lddb-demo   the existing course/student catalogue. Left exactly where it is
                 so nothing about the cover generator has to be migrated.

   Users only ever sign in to LabDDB-Pro. lddb-demo stays public-read / no-write,
   and the coverpage admin writes to it with a short-lived custom token the bridge
   mints — see labddb-auth.js.

   Loaded before every other script on every page. Previously this config was
   copy-pasted into five files; changing a database URL meant five edits.
   ============================================================================= */
(function (global) {
  'use strict';

  var LabDDB = {
    /* -----------------------------------------------------------------------
       LabDDB-Pro — auth + wallet. Live config, copied from
       Firebase console -> LabDDB-Pro -> Project settings -> Your apps -> Web.

       These values are public by design: a Firebase web apiKey identifies the
       project, it does not authorise anything. What protects the wallet is
       firebase/labddb-pro.rules.json (".write": false on every path) plus the
       service account, which only the bridge holds and which bypasses rules.

       `databaseURL` is the one field the console snippet leaves out. It must
       match the instance URL on Realtime Database -> Data. The value below is
       the us-central1 default; a database created in another region has a
       different host, e.g.
       https://labddb-pro-default-rtdb.asia-southeast1.firebasedatabase.app
       ----------------------------------------------------------------------- */
    authConfig: {
      apiKey: 'AIzaSyCiIoMvVrLEjfhDiQM24n_Z8tzmrZhV7Y4',
      authDomain: 'labddb-pro.firebaseapp.com',
      databaseURL: 'https://labddb-pro-default-rtdb.firebaseio.com',
      projectId: 'labddb-pro',
      storageBucket: 'labddb-pro.firebasestorage.app',
      messagingSenderId: '145808196263',
      appId: '1:145808196263:web:cad2016a87acaf44381182',
    },

    /* lddb-demo — courses, students, assignments. Already live. */
    dataConfig: {
      apiKey: 'AIzaSyAhbgEBwvfFMVsGrahhG1jtdpguT6RTh_A',
      authDomain: 'lddb-demo.firebaseapp.com',
      databaseURL: 'https://lddb-demo-default-rtdb.firebaseio.com',
      projectId: 'lddb-demo',
      storageBucket: 'lddb-demo.firebasestorage.app',
      messagingSenderId: '188976453347',
      appId: '1:188976453347:web:c49ffcee015aa3248117d6',
    },

    /* The bridge. Empty means same-origin, which is how it is deployed. */
    bridgeUrl: (global.UPRINT_BRIDGE_URL || '').replace(/\/$/, ''),

    /* Fallback prices, replaced by the live values from GET /api/config. */
    pricing: { mono: 3, color: 5, currency: 'BDT', maxCopies: 10 },

    /** Has someone actually filled in the LabDDB-Pro config above? */
    isAuthConfigured: function () {
      return !/^REPLACE_WITH/.test(this.authConfig.apiKey || 'REPLACE_WITH');
    },

    api: function (path) {
      return this.bridgeUrl + path;
    },
  };

  global.LabDDB = LabDDB;
})(window);
