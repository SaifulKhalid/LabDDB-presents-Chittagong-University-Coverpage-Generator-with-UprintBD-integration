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

  /**
   * Catalogue data and selection layer.
   * Centralizes ordering metadata and default placeholder resolution across all generators.
   */
  LabDDB.catalogue = {
    /**
     * Determine the latest added course code from a list of candidate codes.
     * Uses existing creation/ordering metadata:
     *   1. createdAt (timestamp number)
     *   2. updatedAt (ServerValue.TIMESTAMP from RTDB writes)
     *   3. _rawIndex (catalogue/database insertion order)
     *
     * @param {string[]} candidateCodes
     * @param {Object.<string, Object>} coursesMap
     * @returns {string|null}
     */
    getLatestCourse: function (candidateCodes, coursesMap) {
      if (!Array.isArray(candidateCodes) || candidateCodes.length === 0) {
        return null;
      }
      var map = coursesMap || {};
      var bestCode = candidateCodes[0];
      for (var i = 1; i < candidateCodes.length; i++) {
        var currCode = candidateCodes[i];
        if (this.compareCoursesRecency(currCode, bestCode, map) > 0) {
          bestCode = currCode;
        }
      }
      return bestCode;
    },

    /**
     * Compares two course codes by recency.
     * Returns > 0 if codeA is newer than codeB, < 0 if older, 0 if equal.
     */
    compareCoursesRecency: function (codeA, codeB, coursesMap) {
      var a = (coursesMap && coursesMap[codeA]) || {};
      var b = (coursesMap && coursesMap[codeB]) || {};

      // 1. Explicit creation timestamp (highest priority)
      var ca = Number(a.createdAt || 0);
      var cb = Number(b.createdAt || 0);
      if (ca !== cb) {
        return ca - cb;
      }

      // 2. Updated timestamp (set by admin.js on course creation & updates)
      var ua = Number(a.updatedAt || 0);
      var ub = Number(b.updatedAt || 0);
      if (ua !== ub) {
        return ua - ub;
      }

      // 3. Database / catalogue key order (appearance order in raw database snapshot)
      var ia = typeof a._rawIndex === 'number' ? a._rawIndex : -1;
      var ib = typeof b._rawIndex === 'number' ? b._rawIndex : -1;
      if (ia !== ib) {
        return ia - ib;
      }

      return 0;
    },

    /**
     * Determine the latest added experiment for a course.
     * In the catalogue and admin panel, experiments are stored in an array
     * where newly added experiments are appended to the end (curExps.concat).
     * If explicit timestamps exist, the highest timestamp is preferred.
     *
     * @param {Array|Object} experiments
     * @returns {{ index: number, experiment: Object }|null}
     */
    getLatestExperiment: function (experiments) {
      if (!experiments) return null;
      var list = Array.isArray(experiments) ? experiments : Object.values(experiments);
      if (list.length === 0) return null;

      var hasTimestamps = list.some(function (e) {
        return e && (Number(e.createdAt || 0) > 0 || Number(e.updatedAt || 0) > 0);
      });

      if (hasTimestamps) {
        var bestIdx = 0;
        var bestTime = -1;
        list.forEach(function (e, idx) {
          if (!e) return;
          var t = Number(e.createdAt || e.updatedAt || 0);
          if (t > bestTime) {
            bestTime = t;
            bestIdx = idx;
          }
        });
        return {
          index: bestIdx,
          experiment: list[bestIdx]
        };
      }

      var lastIdx = list.length - 1;
      return {
        index: lastIdx,
        experiment: list[lastIdx]
      };
    },

    /**
     * Resolves which course to select, preserving user manual selection if valid,
     * otherwise defaulting to the latest added course.
     *
     * @param {string[]} candidateCodes
     * @param {Object.<string, Object>} coursesMap
     * @param {string|null} userSelectedCode
     * @returns {string|null}
     */
    resolveCourseSelection: function (candidateCodes, coursesMap, userSelectedCode) {
      if (!Array.isArray(candidateCodes) || candidateCodes.length === 0) {
        return null;
      }
      var map = coursesMap || {};
      if (userSelectedCode && map[userSelectedCode] && candidateCodes.indexOf(userSelectedCode) !== -1) {
        return userSelectedCode;
      }
      return this.getLatestCourse(candidateCodes, map);
    },

    /**
     * Resolves which experiment to select, preserving user manual selection if valid,
     * otherwise defaulting to the latest added experiment.
     *
     * @param {Array|Object} experiments
     * @param {string|number|null} userSelectedExpIndex
     * @returns {{ index: number, experiment: Object }|null}
     */
    resolveExperimentSelection: function (experiments, userSelectedExpIndex) {
      if (!experiments) return null;
      var list = Array.isArray(experiments) ? experiments : Object.values(experiments);
      if (list.length === 0) return null;

      if (userSelectedExpIndex !== null && userSelectedExpIndex !== undefined && userSelectedExpIndex !== '') {
        var idx = parseInt(userSelectedExpIndex, 10);
        if (!isNaN(idx) && idx >= 0 && idx < list.length && list[idx]) {
          return {
            index: idx,
            experiment: list[idx]
          };
        }
      }

      return this.getLatestExperiment(list);
    }
  };

  global.LabDDB = LabDDB;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LabDDB;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
