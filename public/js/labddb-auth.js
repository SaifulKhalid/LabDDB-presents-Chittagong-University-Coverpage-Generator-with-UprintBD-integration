/* =============================================================================
   labddb-auth.js — Google sign-in, the DDB wallet, and the account chip.
   -----------------------------------------------------------------------------
   Deliberate design choice: **the app stays anonymous by default.** Browsing
   courses, filling a cover page, previewing and downloading the PDF all work with
   no account, exactly as before. Sign-in is asked for at one moment only — the
   tap on "Get Kiosk OTP" — because that is the only action that spends money.

   Two Firebase apps:
     default app  = lddb-demo   so every existing firebase.database() call in
                                app.js / admin.js keeps working untouched.
     'labddb-pro' = LabDDB-Pro  auth + wallet, shared across LabDDB tools.

   The wallet is a live listener, not a poll: the moment the admin tops someone up
   or the reconciler settles a print, the chip in the header changes by itself.

   Exposes window.LabDDB.auth.
   ============================================================================= */
(function (global) {
  'use strict';

  var CFG = global.LabDDB;
  if (!CFG) {
    console.error('[labddb-auth] labddb-config.js must load first.');
    return;
  }

  var authApp = null;
  var fbAuth = null;
  var walletRef = null;

  var state = {
    ready: false,
    configured: CFG.isAuthConfigured(),
    user: null, // { uid, email, displayName, photoURL }
    wallet: { balance: 0, reserved: 0, available: 0 },
    roles: { coverAdmin: false, projectAdmin: false },
    walletLoaded: false,
  };

  var listeners = [];
  var readyResolvers = [];
  var pendingSignIn = null;

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state);
      } catch (e) {
        console.warn('[labddb-auth] listener failed', e);
      }
    }
    renderChip();
    renderAdminNav();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function taka(n) {
    return '৳' + (Number(n) || 0);
  }

  // ---------------------------------------------------------------------------
  // Firebase bootstrap
  // ---------------------------------------------------------------------------
  function initFirebase() {
    if (!global.firebase) {
      console.error('[labddb-auth] Firebase compat SDK not loaded.');
      return;
    }

    // Default app: the course/student database. Existing code calls
    // firebase.database() with no app name, so this must stay the default.
    if (!firebase.apps.length) {
      firebase.initializeApp(CFG.dataConfig);
    }

    if (!state.configured) {
      // Nothing to sign in to yet. Mark ready so the UI is never stuck on a
      // spinner — anonymous features must not depend on auth being set up.
      finishReady();
      return;
    }

    try {
      authApp = firebase.apps.filter(function (a) {
        return a.name === 'labddb-pro';
      })[0];
      if (!authApp) authApp = firebase.initializeApp(CFG.authConfig, 'labddb-pro');
      fbAuth = authApp.auth();
    } catch (err) {
      console.error('[labddb-auth] could not initialise LabDDB-Pro', err);
      state.configured = false;
      finishReady();
      return;
    }

    fbAuth.onAuthStateChanged(function (user) {
      detachWallet();
      if (!user) {
        state.user = null;
        state.wallet = { balance: 0, reserved: 0, available: 0 };
        state.roles = { coverAdmin: false, projectAdmin: false };
        state.walletLoaded = false;
        try {
          localStorage.removeItem('labddb_remembered_roll');
          for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i);
            if (k && k.indexOf('labddb_user_roll_') === 0) localStorage.removeItem(k);
          }
        } catch (_) {}
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('labddb:roll_changed', { detail: { roll: '' } }));
          window.dispatchEvent(new CustomEvent('labddb:signed_out'));
        }
        finishReady();
        emit();
        return;
      }

      state.user = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || (user.email || '').split('@')[0],
        photoURL: user.photoURL || '',
        roll: '',
      };
      attachWallet(user.uid);
      emit();

      // Audit user sign-in
      logActivity('USER_SIGN_IN', { type: 'auth', id: user.uid }, {
        email: user.email || '',
        provider: (user.providerData && user.providerData[0] && user.providerData[0].providerId) || 'google.com',
      });

      // /api/me creates the user + wallet rows on first sight and returns roles & saved roll.
      refreshProfile().then(function () {
        finishReady();
      });
    });

    // Completing a redirect sign-in (mobile browsers that block popups).
    fbAuth.getRedirectResult().catch(function () {
      /* nothing pending */
    });
  }

  function finishReady() {
    if (state.ready) return;
    state.ready = true;
    var pending = readyResolvers.splice(0);
    for (var i = 0; i < pending.length; i++) pending[i](state);
  }

  function attachWallet(uid) {
    try {
      walletRef = authApp.database().ref('wallets/' + uid);
      walletRef.on(
        'value',
        function (snap) {
          var w = snap.val() || {};
          var balance = Number(w.balance) || 0;
          var reserved = Number(w.reserved) || 0;
          state.wallet = {
            balance: balance,
            reserved: reserved,
            available: Math.max(0, balance - reserved),
          };
          state.walletLoaded = true;
          emit();
        },
        function (err) {
          // Most likely the security rules are not deployed yet. The chip falls
          // back to whatever /api/me reported.
          console.warn('[labddb-auth] wallet listener denied:', err && err.message);
          state.walletLoaded = true;
          emit();
        }
      );
    } catch (err) {
      console.warn('[labddb-auth] wallet listener failed', err);
    }
  }

  function detachWallet() {
    if (walletRef) {
      try {
        walletRef.off();
      } catch (_) {}
      walletRef = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Tokens and authenticated calls
  // ---------------------------------------------------------------------------
  function getToken(forceRefresh) {
    if (!fbAuth || !fbAuth.currentUser) return Promise.resolve(null);
    return fbAuth.currentUser.getIdToken(!!forceRefresh);
  }

  /**
   * fetch() against the bridge with the caller's identity attached.
   * Retries once with a fresh token on 401 — an ID token can expire between the
   * page loading and the user finally tapping the button.
   */
  function authedFetch(path, opts, _retried) {
    opts = opts || {};
    return getToken(!!_retried).then(function (token) {
      var headers = {};
      for (var k in opts.headers || {}) headers[k] = opts.headers[k];
      if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = 'Bearer ' + token;

      return fetch(CFG.api(path), {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body,
      }).then(function (res) {
        if (res.status === 401 && token && !_retried) {
          return authedFetch(path, opts, true);
        }
        return res.json().then(
          function (data) {
            if (!res.ok || data.ok === false) {
              var err = new Error(data.error || 'Request failed (HTTP ' + res.status + ')');
              err.status = res.status;
              err.data = data;
              throw err;
            }
            return data;
          },
          function () {
            var err = new Error('The server returned an unreadable response.');
            err.status = res.status;
            throw err;
          }
        );
      });
    });
  }

  var profilePromise = null;
  function refreshProfile() {
    profilePromise = authedFetch('/api/me')
      .then(function (data) {
        var roles = (data && data.roles) || {};
        state.roles = {
          admin: !!(roles.admin || roles.projectAdmin),
          projectAdmin: !!(roles.projectAdmin || roles.admin),
          coverAdmin: !!roles.coverAdmin,
          disabled: !!roles.disabled,
        };
        if (!state.walletLoaded && data.wallet) state.wallet = data.wallet;
        if (data.pricing) CFG.pricing = data.pricing;
        if (data.user) {
          if (state.user) {
            state.user.roll = data.user.roll || '';
          }
          if (data.user.disabled) state.disabled = true;
          if (data.user.roll && typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('labddb:roll_changed', { detail: { roll: data.user.roll } }));
          }
        }
        profilePromise = null;
        emit();
        return data;
      })
      .catch(function (err) {
        console.warn('[labddb-auth] /api/me failed:', err.message);
        profilePromise = null;
        return null;
      });
    return profilePromise;
  }

  // ---------------------------------------------------------------------------
  // Sign in / out
  // ---------------------------------------------------------------------------
  function signIn() {
    if (!state.configured) {
      return Promise.reject(new Error('Accounts are not configured on this deployment yet.'));
    }
    if (pendingSignIn) return pendingSignIn;

    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    pendingSignIn = fbAuth
      .signInWithPopup(provider)
      .then(function (result) {
        pendingSignIn = null;
        return result.user;
      })
      .catch(function (err) {
        pendingSignIn = null;
        // Popups are blocked in a lot of in-app browsers (Messenger, Instagram).
        // Redirect works there, and resolves on the next page load.
        if (
          err &&
          (err.code === 'auth/popup-blocked' ||
            err.code === 'auth/operation-not-supported-in-this-environment' ||
            err.code === 'auth/cancelled-popup-request')
        ) {
          return fbAuth.signInWithRedirect(provider).then(function () {
            return null;
          });
        }
        if (err && err.code === 'auth/popup-closed-by-user') {
          var cancelled = new Error('Sign-in was cancelled.');
          cancelled.cancelled = true;
          throw cancelled;
        }
        if (err && err.code === 'auth/unauthorized-domain') {
          throw new Error(
            'This domain is not authorised for sign-in yet. Add it under ' +
              'Firebase → Authentication → Settings → Authorized domains.'
          );
        }
        throw err;
      });

    return pendingSignIn;
  }

  function signOut() {
    if (state.user) {
      logActivity('USER_SIGN_OUT', { type: 'auth', id: state.user.uid });
    }
    detachWallet();
    clearRememberedRoll();
    if (!fbAuth) return Promise.resolve();
    return fbAuth.signOut();
  }

  function whenReady() {
    if (state.ready) {
      if (profilePromise) {
        return profilePromise.then(function () {
          return state;
        });
      }
      return Promise.resolve(state);
    }
    return new Promise(function (resolve) {
      readyResolvers.push(resolve);
    });
  }

  /**
   * Resolve with a signed-in user, opening the sign-in sheet if needed.
   * Rejects with `.cancelled = true` if the user dismisses it, so callers can
   * quietly do nothing rather than showing an error.
   */
  function requireUser(reason) {
    return whenReady().then(function () {
      if (state.user) return state.user;
      return openSignInSheet(reason).then(function (user) {
        if (!user) {
          var err = new Error('Sign-in was cancelled.');
          err.cancelled = true;
          throw err;
        }
        return user;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Header account chip
  // ---------------------------------------------------------------------------
  function chipHost() {
    var slot = document.getElementById('accountChipSlot');
    if (slot) return slot;
    var actions = document.querySelector('.header-actions');
    if (!actions) return null;
    slot = document.createElement('div');
    slot.id = 'accountChipSlot';
    slot.className = 'account-chip-slot';
    actions.appendChild(slot);
    return slot;
  }

  function renderChip() {
    var host = chipHost();
    if (!host) return;

    if (!state.configured) {
      host.innerHTML = '';
      return;
    }

    if (!state.user) {
      host.innerHTML =
        '<button type="button" class="account-chip account-chip--signin" id="accountChipBtn">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>' +
        '<circle cx="12" cy="7" r="4"></circle></svg>' +
        '<span class="account-chip-label">Sign in</span>' +
        '</button>';
      var signInBtn = document.getElementById('accountChipBtn');
      if (signInBtn) {
        signInBtn.onclick = function () {
          openSignInSheet();
        };
      }
      return;
    }

    var initial = (state.user.displayName || state.user.email || '?').charAt(0).toUpperCase();
    var avatar = state.user.photoURL
      ? '<img class="account-avatar" src="' + esc(state.user.photoURL) + '" alt="" ' +
        'referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" />'
      : '<span class="account-avatar account-avatar--letter">' + esc(initial) + '</span>';

    var low = state.wallet.available < (CFG.pricing.mono || 3);

    host.innerHTML =
      '<button type="button" class="account-chip' +
      (low ? ' account-chip--low' : '') +
      '" id="accountChipBtn" title="' +
      esc(state.user.email) +
      '">' +
      avatar +
      '<span class="account-chip-wallet">' +
      '<span class="account-chip-balance">' +
      taka(state.wallet.available) +
      '</span>' +
      (state.wallet.reserved
        ? '<span class="account-chip-reserved">' + taka(state.wallet.reserved) + ' held</span>'
        : '<span class="account-chip-reserved">DDB balance</span>') +
      '</span>' +
      '</button>';

    var btn = document.getElementById('accountChipBtn');
    if (btn) btn.onclick = openWalletSheet;
  }

  /**
   * Hide the Admin Panel link from people who cannot use it.
   *
   * This is cosmetic only — admin.html gates itself and the API checks the role on
   * every write. But an always-visible link to a page that only ever answers
   * "locked" is a dead end on four pages, so it is hidden until the role is real.
   * When auth is not configured at all the link stays put, so a local dev build
   * without LabDDB-Pro keys can still reach the panel.
   */
  function renderAdminNav() {
    var links = document.querySelectorAll('a[href="admin.html"]');
    for (var i = 0; i < links.length; i++) {
      links[i].style.display = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Sheets
  // ---------------------------------------------------------------------------
  function buildSheet(id) {
    var existing = document.getElementById(id);
    if (existing) {
      existing.hidden = true;
      return existing;
    }
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = id;
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="modal-card account-sheet">' +
      '<div class="modal-head">' +
      '<div><span class="modal-badge-tag" data-role="tag">LabDDB</span>' +
      '<h3 data-role="title">Account</h3></div>' +
      '<button type="button" class="modal-close-btn" data-role="close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="modal-body account-sheet-body" data-role="body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeSheet(overlay) {
    if (overlay) {
      overlay.classList.remove('show');
      overlay.classList.remove('active');
      overlay.hidden = true;
    }
  }

  function showToast(message, icon) {
    if (global.Uprint && global.Uprint.showToast) {
      global.Uprint.showToast(message, icon);
      return;
    }
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = (icon ? '<span class="toast-icon">' + icon + '</span> ' : '') + '<span>' + esc(message) + '</span>';
    container.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity 0.2s, transform 0.2s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 200);
    }, 2800);
  }

  /** @returns {Promise<user|null>} null when dismissed without signing in. */
  function openSignInSheet(reason) {
    if (!state.configured) {
      showToast(
        'Accounts are not configured on this deployment yet. Add the LabDDB-Pro Firebase config in public/js/labddb-config.js.',
        '⚠️'
      );
      return Promise.resolve(null);
    }

    var overlay = buildSheet('signInSheet');
    var card = overlay.querySelector('.modal-card');
    var body = overlay.querySelector('[data-role="body"]');
    card.querySelector('[data-role="tag"]').textContent = 'LabDDB account';
    card.querySelector('[data-role="title"]').textContent = 'Sign in to print';

    var priceLine =
      '৳' + (CFG.pricing.mono || 3) + ' per b/w page · ৳' + (CFG.pricing.color || 5) + ' colour';

    body.innerHTML =
      '<div class="signin-lead">' +
      (reason ? '<p class="signin-reason">' + esc(reason) + '</p>' : '') +
      '<p>Sign in with Google to get a kiosk print code. Your DDB balance is shared ' +
      'across every LabDDB tool.</p>' +
      '</div>' +
      '<button type="button" class="google-signin-btn" id="googleSignInBtn">' +
      '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
      '<path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.6h12c-.2 2-1.5 5-4.4 7l6.7 5.2c4-3.7 6.8-9.1 6.8-15.8z"/>' +
      '<path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.4-5.3l-6.7-5.2c-1.9 1.3-4.4 2.2-7.7 2.2-5.9 0-11-3.9-12.8-9.3l-7 5.4C7.7 41.1 15.3 46 24 46z"/>' +
      '<path fill="#FBBC05" d="M11.2 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .7-4.4l-7-5.4C2.8 17 2 20.4 2 24s.8 7 2.1 9.8l7.1-5.4z"/>' +
      '<path fill="#EA4335" d="M24 10.3c4.2 0 7 1.8 8.6 3.3l6.3-6.1C35 3.9 30 2 24 2 15.3 2 7.7 6.9 4.1 14.2l7 5.4C12.9 14.2 18.1 10.3 24 10.3z"/>' +
      '</svg>' +
      '<span id="googleSignInLabel">Continue with Google</span>' +
      '</button>' +
      '<p class="signin-fineprint">' +
      esc(priceLine) +
      '. You are only charged when a page actually prints — an unused code costs nothing.' +
      '</p>' +
      '<div class="signin-error" id="signInError" hidden></div>';

    overlay.hidden = false;
    overlay.classList.add('show');
    overlay.classList.add('active');

    return new Promise(function (resolve) {
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        closeSheet(overlay);
        resolve(value);
      }

      card.querySelector('[data-role="close"]').onclick = function () {
        done(null);
      };
      overlay.onclick = function (e) {
        if (e.target === overlay) done(null);
      };

      var btn = document.getElementById('googleSignInBtn');
      var label = document.getElementById('googleSignInLabel');
      var errBox = document.getElementById('signInError');

      btn.onclick = function () {
        btn.disabled = true;
        label.textContent = 'Opening Google…';
        errBox.hidden = true;
        signIn()
          .then(function (user) {
            if (user) {
              done({
                uid: user.uid,
                email: user.email || '',
                displayName: user.displayName || '',
                photoURL: user.photoURL || '',
              });
            } else {
              // Redirect flow — the page is about to navigate away.
              label.textContent = 'Redirecting…';
            }
          })
          .catch(function (err) {
            btn.disabled = false;
            label.textContent = 'Continue with Google';
            if (err && err.cancelled) return;
            errBox.hidden = false;
            errBox.textContent = err.message || 'Sign-in failed. Please try again.';
          });
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Remembered Roll Helper — Server-Authoritative Persistence
  // ---------------------------------------------------------------------------
  function getRememberedRoll() {
    if (state.user && state.user.roll) {
      return state.user.roll;
    }
    return '';
  }

  function setRememberedRoll(roll) {
    var r = (roll || '').trim();
    if (state.user && state.user.uid) {
      state.user.roll = r;
      authedFetch('/api/me/roll', {
        method: 'POST',
        body: JSON.stringify({ roll: r }),
      }).catch(function () {});
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('labddb:roll_changed', { detail: { roll: r } }));
      }
    }
    // Anonymous visitors: roll is NOT persisted to storage
  }

  function clearRememberedRoll() {
    if (state.user && state.user.uid) {
      state.user.roll = '';
      authedFetch('/api/me/roll', {
        method: 'POST',
        body: JSON.stringify({ roll: '' }),
      }).catch(function () {});
    }
    try {
      localStorage.removeItem('labddb_remembered_roll');
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('labddb_user_roll_') === 0) localStorage.removeItem(k);
      }
    } catch (_) {}
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('labddb:roll_changed', { detail: { roll: '' } }));
    }
  }

  // Activity audit helper
  function logActivity(action, entity, metadata) {
    if (!state.user) return Promise.resolve(null);
    return authedFetch('/api/activity', {
      method: 'POST',
      body: JSON.stringify({
        action: action,
        entity: entity || null,
        metadata: metadata || {},
      }),
    }).catch(function (err) {
      console.warn('[labddb-auth] logActivity failed:', err && err.message);
      return null;
    });
  }

  function deriveStudentSession(id) {
    if (!id || id.length < 2) return '';
    var m = {
      '24': '2023-2024',
      '23': '2022-2023',
      '22': '2021-2022',
      '21': '2020-2021',
      '20': '2019-2020',
      '19': '2018-2019',
      '18': '2017-2018',
    };
    return m[id.substring(0, 2)] || '';
  }

  function openWalletSheet() {
    if (!state.user) return openSignInSheet();

    var overlay = buildSheet('walletSheet');
    var card = overlay.querySelector('.modal-card');
    var body = overlay.querySelector('[data-role="body"]');
    card.querySelector('[data-role="tag"]').textContent = 'LabDDB profile';
    card.querySelector('[data-role="title"]').textContent = 'Profile & Wallet';

    function render(jobs, ledgerNote) {
      var w = state.wallet;
      var monoPages = CFG.pricing.mono ? Math.floor(w.available / CFG.pricing.mono) : 0;
      var savedRoll = getRememberedRoll();

      var open = (jobs || []).filter(function (j) {
        return j.status === 'reserved' || j.status === 'reserving';
      });

      body.innerHTML =
        '<div class="wallet-hero">' +
        '<div class="wallet-hero-amount">' + taka(w.available) + '</div>' +
        '<div class="wallet-hero-label">available to spend</div>' +
        (w.reserved
          ? '<div class="wallet-hero-held">' +
            taka(w.reserved) +
            ' held for ' +
            open.length +
            ' unused code' +
            (open.length === 1 ? '' : 's') +
            '</div>'
          : '') +
        '</div>' +

        '<div class="wallet-facts">' +
        '<div class="wallet-fact"><span>Top-ups received</span><strong>' + taka(w.balance) + '</strong></div>' +
        '<div class="wallet-fact"><span>Enough for</span><strong>' + monoPages + ' b/w page' + (monoPages === 1 ? '' : 's') + '</strong></div>' +
        '</div>' +

        '<!-- Student Profile & Default Roll Section -->' +
        '<div class="wallet-section wallet-section--profile">' +
        '<h4>Student Profile &amp; Default Roll</h4>' +
        '<p class="wallet-hint">Set your Roll Number to automatically load and generate your cover pages with your verified student details. You can still edit the roll at any time to generate covers for others.</p>' +
        '<div class="saved-roll-form" style="margin-top: 10px; display: flex; gap: 8px; align-items: center;">' +
        '<input type="text" id="profileSavedRoll" class="form-input" placeholder="e.g. 20702008" inputmode="numeric" autocomplete="off" value="' + esc(savedRoll) + '" style="flex:1;" />' +
        '<button type="button" class="btn-small-action" id="profileSaveRollBtn">Save</button>' +
        '<button type="button" class="btn-small-action danger" id="profileClearRollBtn"' + (savedRoll ? '' : ' style="display:none;"') + '>Clear</button>' +
        '</div>' +
        '<div id="profileRollPreview" class="student-card-pill" style="display: none; margin-top: 10px;">' +
        '<div class="student-avatar" id="profileRollAvatar">S</div>' +
        '<div class="student-meta">' +
        '<div class="student-name-val" id="profileRollName">—</div>' +
        '<div class="student-sub-val" id="profileRollSub">ID: — · Session: —</div>' +
        '</div>' +
        '<div class="student-status-icon">✓</div>' +
        '</div>' +
        '</div>' +

        (open.length
          ? '<div class="wallet-section"><h4>Unused kiosk codes</h4>' +
            open
              .map(function (j) {
                var left = j.expiresAt ? Math.max(0, Math.round((j.expiresAt - Date.now()) / 60000)) : null;
                return (
                  '<div class="wallet-job">' +
                  '<span class="wallet-job-otp">' + esc(j.otp || '••••') + '</span>' +
                  '<span class="wallet-job-meta">' +
                  esc(j.courseCode || j.title || 'Print') + ' · ' + taka(j.price) +
                  (left !== null ? ' · ' + left + ' min left' : '') +
                  '</span>' +
                  '<button type="button" class="chip-btn" data-cancel="' + esc(j.id) + '">Cancel</button>' +
                  '</div>'
                );
              })
              .join('') +
            '<p class="wallet-hint">Cancelling returns the held money straight away. ' +
            'Letting a code expire does the same thing automatically.</p>' +
            '</div>'
          : '') +

        '<div class="wallet-section">' +
        '<h4>Need more balance?</h4>' +
        '<p class="wallet-hint">DDB balance is topped up manually by the LabDDB Admin (<strong>+8801516599675</strong>). Send bKash / Nagad to this number, then contact via WhatsApp or Call with your TrxID & Student Roll.</p>' +
        '<div class="recharge-buttons-row" style="margin-top:12px;">' +
        '<a href="https://wa.me/8801516599675?text=Hi%20Admin%2C%20I%20want%20to%20recharge%20my%20LabDDB%20balance." target="_blank" rel="noopener noreferrer" class="btn-recharge-action btn-whatsapp">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.301-.15-1.78-.878-2.056-.978-.276-.1-.476-.15-.676.15-.2.3-.777.978-.952 1.178-.175.2-.351.226-.652.075-.301-.15-1.272-.469-2.423-1.496-.896-.799-1.501-1.786-1.677-2.087-.175-.301-.019-.464.132-.614.135-.135.301-.351.451-.527.15-.175.2-.3.301-.501.1-.2.05-.376-.025-.526-.075-.15-.676-1.63-.927-2.232-.244-.585-.493-.506-.676-.515-.175-.01-.376-.01-.576-.01s-.526.075-.802.376c-.276.3-1.053 1.028-1.053 2.507s1.078 2.908 1.228 3.109c.15.2 2.122 3.24 5.141 4.544.718.31 1.279.496 1.716.635.722.23 1.378.197 1.897.12.578-.087 1.78-.727 2.03-1.43.25-.702.25-1.303.175-1.43-.075-.125-.276-.2-.576-.35zM12 2C6.477 2 2 6.477 2 12c0 1.891.524 3.66 1.434 5.176L2 22l4.981-1.39A9.957 9.957 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18.2a8.167 8.167 0 0 1-4.17-1.144l-.299-.178-3.093.863.876-3.008-.195-.313A8.163 8.163 0 0 1 3.8 12c0-4.522 3.678-8.2 8.2-8.2s8.2 3.678 8.2 8.2-3.678 8.2-8.2 8.2z"/></svg>' +
        '<span>WhatsApp Admin</span>' +
        '</a>' +
        '<a href="tel:+8801516599675" class="btn-recharge-action btn-call">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>' +
        '<span>Call Admin</span>' +
        '</a>' +
        '</div>' +
        '</div>' +

        (ledgerNote ? '<p class="wallet-hint">' + esc(ledgerNote) + '</p>' : '') +

        '<div class="wallet-actions">' +
        '<button type="button" class="btn-small-action" id="walletRefresh">Refresh</button>' +
        '<button type="button" class="btn-small-action danger" id="walletSignOut">Sign out</button>' +
        '</div>' +
        '<p class="wallet-identity">' + esc(state.user.email) + '</p>';

      // Bind Saved Roll Input & Preview
      var rollInput = document.getElementById('profileSavedRoll');
      var saveBtn = document.getElementById('profileSaveRollBtn');
      var clearBtn = document.getElementById('profileClearRollBtn');
      var previewCard = document.getElementById('profileRollPreview');
      var previewAvatar = document.getElementById('profileRollAvatar');
      var previewName = document.getElementById('profileRollName');
      var previewSub = document.getElementById('profileRollSub');

      function updateRollPreview(roll) {
        if (!roll || roll.length < 3) {
          if (previewCard) previewCard.style.display = 'none';
          return;
        }
        if (typeof firebase !== 'undefined' && firebase.database) {
          try {
            firebase.database().ref('students/' + roll).once('value').then(function (snap) {
              var st = snap.val();
              if (previewCard && previewAvatar && previewName && previewSub) {
                previewCard.style.display = 'flex';
                if (st) {
                  previewAvatar.textContent = (st.fullName || roll).charAt(0).toUpperCase();
                  previewName.textContent = st.fullName || 'Student';
                  previewSub.textContent = 'ID: ' + roll + ' · Session: ' + (st.session || deriveStudentSession(roll) || '—') + (st.department ? ' · ' + st.department : '');
                } else {
                  previewAvatar.textContent = 'S';
                  previewName.textContent = 'Custom Student (' + roll + ')';
                  previewSub.textContent = 'ID: ' + roll + ' · Session: ' + deriveStudentSession(roll);
                }
              }
            }).catch(function () {
              if (previewCard) previewCard.style.display = 'none';
            });
          } catch (_) {}
        }
      }

      if (savedRoll) updateRollPreview(savedRoll);

      var rollDebounce;
      if (rollInput) {
        rollInput.oninput = function () {
          var val = this.value.trim();
          clearTimeout(rollDebounce);
          rollDebounce = setTimeout(function () {
            updateRollPreview(val);
          }, 300);
        };
      }

      if (saveBtn) {
        saveBtn.onclick = function () {
          var val = rollInput ? rollInput.value.trim() : '';
          if (!val) {
            clearRememberedRoll();
            if (clearBtn) clearBtn.style.display = 'none';
            if (previewCard) previewCard.style.display = 'none';
            showToast('Remembered roll cleared.', 'ℹ️');
            return;
          }
          setRememberedRoll(val);
          if (clearBtn) clearBtn.style.display = 'inline-block';
          updateRollPreview(val);
          showToast('Default Roll ' + val + ' remembered!', '✓');
        };
      }

      if (clearBtn) {
        clearBtn.onclick = function () {
          clearRememberedRoll();
          if (rollInput) rollInput.value = '';
          if (previewCard) previewCard.style.display = 'none';
          clearBtn.style.display = 'none';
          showToast('Remembered roll cleared.', 'ℹ️');
        };
      }

      body.querySelectorAll('[data-cancel]').forEach(function (btn) {
        btn.onclick = function () {
          btn.disabled = true;
          btn.textContent = 'Cancelling…';
          authedFetch('/api/cancel', {
            method: 'POST',
            body: JSON.stringify({ jobId: btn.getAttribute('data-cancel') }),
          })
            .then(function () {
              if (global.Uprint && global.Uprint.showToast) {
                global.Uprint.showToast('Code cancelled — balance returned.', '↩️');
              }
              load();
            })
            .catch(function (err) {
              btn.disabled = false;
              btn.textContent = 'Cancel';
              if (global.Uprint && global.Uprint.showToast) {
                global.Uprint.showToast(err.message, '⚠️');
              }
            });
        };
      });

      var refresh = document.getElementById('walletRefresh');
      if (refresh) {
        refresh.onclick = function () {
          refresh.textContent = 'Refreshing…';
          refreshProfile().then(load);
        };
      }
      var out = document.getElementById('walletSignOut');
      if (out) {
        out.onclick = function () {
          signOut().then(function () {
            closeSheet(overlay);
          });
        };
      }
    }

    function load() {
      authedFetch('/api/jobs')
        .then(function (data) {
          render(data.jobs || []);
        })
        .catch(function (err) {
          render([], 'Could not load your recent prints: ' + err.message);
        });
    }

    render([], null);
    load();
    overlay.hidden = false;
    overlay.classList.add('show');
    overlay.classList.add('active');
    card.querySelector('[data-role="close"]').onclick = function () {
      closeSheet(overlay);
    };
    overlay.onclick = function (e) {
      if (e.target === overlay) closeSheet(overlay);
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CFG.auth = {
    state: state,
    whenReady: whenReady,
    onChange: function (cb) {
      listeners.push(cb);
      if (state.ready) cb(state);
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== cb;
        });
      };
    },
    signIn: signIn,
    signOut: signOut,
    getToken: getToken,
    fetch: authedFetch,
    refresh: refreshProfile,
    requireUser: requireUser,
    openSignIn: openSignInSheet,
    openWallet: openWalletSheet,
    getRememberedRoll: getRememberedRoll,
    setRememberedRoll: setRememberedRoll,
    clearRememberedRoll: clearRememberedRoll,
    logActivity: logActivity,
    get user() {
      return state.user;
    },
    get wallet() {
      return state.wallet;
    },
    get roles() {
      return state.roles;
    },
    isConfigured: function () {
      return state.configured;
    },
  };

  // Pull live prices as early as possible: the cost calculator is visible to
  // anonymous visitors, and must not quote a stale hardcoded number.
  fetch(CFG.api('/api/config'))
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (data && data.pricing) {
        CFG.pricing = data.pricing;
        if (typeof global.onPricingLoaded === 'function') global.onPricingLoaded(CFG.pricing);
        emit();
      }
    })
    .catch(function () {
      /* defaults in labddb-config.js stand in */
    });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFirebase);
  } else {
    initFirebase();
  }
})(window);
