/* =============================================================================
   console.js — the project admin console.
   -----------------------------------------------------------------------------
   Two admin surfaces, on purpose:

     admin.html    coverpage admin. Courses, assignments, students. Delegatable —
                   anyone granted `coverAdmin` can use it. Linked in the sidebar.
     console.html  project admin. Money. One account only (ADMIN_EMAIL on the
                   server), reachable only by typing the URL. Never linked.

   Nothing here trusts the browser. Every button below is a call to /api/admin/*,
   and the server checks the signed-in email on every single request — hiding this
   page is convenience, not security. The lock screen exists so the wrong account
   sees a clear "not you" instead of a wall of failed requests.

   Wallet writes never happen client-side. The console asks; the Worker moves money
   through the same idempotent ledger paths the reconciler uses, which is why
   double-clicking "settle" cannot double-charge anyone.
   ============================================================================= */
(function (global) {
  'use strict';

  var CFG = global.LabDDB;
  if (!CFG) {
    console.error('[console] labddb-config.js must load first.');
    return;
  }

  var auth = null; // set once labddb-auth is ready
  var booted = false;
  var gating = false;
  var lastUid; // never a string until the first identity change lands

  var data = {
    overview: null,
    users: [],
    jobs: [],
    jobScope: 'open',
    ledger: [],
    ledgerTotals: null,
    pricing: null,
    limits: null,
  };

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function taka(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return '৳' + (Math.round(v * 100) / 100);
  }

  function when(ms) {
    if (!ms) return '—';
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function ago(ms) {
    if (!ms) return 'never';
    var s = Math.floor((Date.now() - Number(ms)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function toast(message, icon) {
    var container = $('toastContainer');
    if (!container) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = (icon ? '<span>' + icon + '</span> ' : '') + '<span>' + esc(message) + '</span>';
    container.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity 0.2s, transform 0.2s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 200);
    }, 3200);
  }

  /** Every admin call goes through here so failures read the same way. */
  function api(path, opts) {
    return auth.fetch(path, opts).catch(function (err) {
      toast(err.message || 'The request failed.', '⚠️');
      throw err;
    });
  }

  function busy(btn, label) {
    if (!btn) return function () {};
    var old = btn.innerHTML;
    var wasDisabled = btn.disabled;
    btn.disabled = true;
    if (label) btn.innerHTML = esc(label);
    return function () {
      btn.disabled = wasDisabled;
      btn.innerHTML = old;
    };
  }

  // ---------------------------------------------------------------------------
  // theme + tabs
  // ---------------------------------------------------------------------------
  function initTheme() {
    var saved = localStorage.getItem('cu_app_theme');
    var prefersDark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));

    var btn = $('themeToggleBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        var curr = document.documentElement.getAttribute('data-theme') || 'light';
        var next = curr === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('cu_app_theme', next);
      });
    }
  }

  var PANES = {
    overview: 'paneOverview',
    users: 'paneUsers',
    jobs: 'paneJobs',
    ledger: 'paneLedger',
    audit: 'paneAudit',
    settings: 'paneSettings',
    reconcile: 'paneReconcile',
  };

  // Loaded lazily: the overview is cheap, but a full ledger scan is not, and most
  // visits only ever need one tab.
  var loaded = {};

  function activeTab() {
    var btn = document.querySelector('.console-tab.active');
    return (btn && btn.getAttribute('data-tab')) || 'overview';
  }

  function loadTab(tab) {
    if (tab === 'users') return loadUsers();
    if (tab === 'jobs') return loadJobs();
    if (tab === 'ledger') return loadLedger();
    if (tab === 'audit') return loadAuditLogs();
    if (tab === 'settings') return fillSettings();
    if (tab === 'reconcile') return loadUnmatched();
    return loadOverview();
  }

  function switchTab(tab) {
    var tabs = document.querySelectorAll('.console-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
    }
    for (var key in PANES) {
      if (!Object.prototype.hasOwnProperty.call(PANES, key)) continue;
      var pane = $(PANES[key]);
      if (pane) pane.classList.toggle('active', key === tab);
    }
    if (loaded[tab]) return;
    loaded[tab] = true;
    loadTab(tab);
  }

  function initTabs() {
    var nav = $('consoleTabs');
    if (!nav) return;
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.console-tab') : null;
      if (!btn) return;
      switchTab(btn.getAttribute('data-tab'));
    });
  }

  // ---------------------------------------------------------------------------
  // modal
  // ---------------------------------------------------------------------------
  function closeModal() {
    var host = $('consoleModalHost');
    if (host) host.innerHTML = '';
  }

  /**
   * fields: [{ name, label, type, value, min, max, hint, required }]
   * Resolves with the values object, or null if dismissed.
   */
  function openForm(opts) {
    return new Promise(function (resolve) {
      var host = $('consoleModalHost');
      if (!host) return resolve(null);

      var fieldHtml = (opts.fields || [])
        .map(function (f) {
          return (
            '<div class="form-group">' +
            '<label class="form-label" for="mf_' + esc(f.name) + '">' + esc(f.label) + '</label>' +
            '<input class="form-input" id="mf_' + esc(f.name) + '" name="' + esc(f.name) + '" ' +
            'type="' + esc(f.type || 'text') + '" ' +
            (f.min != null ? 'min="' + esc(f.min) + '" ' : '') +
            (f.max != null ? 'max="' + esc(f.max) + '" ' : '') +
            (f.step != null ? 'step="' + esc(f.step) + '" ' : '') +
            'value="' + esc(f.value == null ? '' : f.value) + '" ' +
            'autocomplete="off" />' +
            (f.hint ? '<p class="form-hint">' + esc(f.hint) + '</p>' : '') +
            '</div>'
          );
        })
        .join('');

      host.innerHTML =
        '<div class="modal-overlay show" id="consoleModal">' +
        '<div class="modal-card account-sheet">' +
        '<div class="modal-drag-handle"></div>' +
        '<div class="modal-head"><div>' +
        '<span class="modal-badge-tag">' + esc(opts.tag || 'Admin') + '</span>' +
        '<h3>' + esc(opts.title) + '</h3></div>' +
        '<button type="button" class="modal-close-btn" id="consoleModalX" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="modal-body account-sheet-body">' +
        (opts.lead ? '<p class="console-muted console-note">' + esc(opts.lead) + '</p>' : '') +
        fieldHtml +
        '<div class="wallet-actions">' +
        '<button type="button" class="btn btn-primary" id="consoleModalOk">' +
        esc(opts.confirmLabel || 'Confirm') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="consoleModalCancel">Cancel</button>' +
        '</div>' +
        '</div></div></div>';

      function done(value) {
        closeModal();
        resolve(value);
      }

      $('consoleModalX').onclick = function () { done(null); };
      $('consoleModalCancel').onclick = function () { done(null); };
      $('consoleModal').onclick = function (e) {
        if (e.target && e.target.id === 'consoleModal') done(null);
      };
      $('consoleModalOk').onclick = function () {
        var out = {};
        var missing = null;
        (opts.fields || []).forEach(function (f) {
          var input = $('mf_' + f.name);
          var v = input ? input.value.trim() : '';
          if (f.required && !v) missing = missing || f.label;
          out[f.name] = v;
        });
        if (missing) {
          toast(missing + ' is required.', '⚠️');
          return;
        }
        done(out);
      };

      var first = host.querySelector('.form-input');
      if (first) first.focus();
    });
  }

  function confirmAction(title, message, confirmLabel) {
    return openForm({
      title: title,
      lead: message,
      fields: [],
      confirmLabel: confirmLabel || 'Confirm',
    }).then(function (v) {
      return !!v;
    });
  }

  // ---------------------------------------------------------------------------
  // overview
  // ---------------------------------------------------------------------------
  function metricCard(label, value, sub, tone) {
    return (
      '<div class="console-metric' + (tone ? ' console-metric--' + tone : '') + '">' +
      '<div class="console-metric-value">' + esc(value) + '</div>' +
      '<div class="console-metric-label">' + esc(label) + '</div>' +
      (sub ? '<div class="console-metric-sub">' + esc(sub) + '</div>' : '') +
      '</div>'
    );
  }

  function renderOverview() {
    var o = data.overview;
    if (!o) return;

    var t = o.totals || {};
    var u = o.uprint || {};

    // The UprintBD balance is our cost side: when it runs dry, nobody can print,
    // however much DDB balance students are holding. So it leads, and it turns
    // amber while there is still time to top it up via bKash.
    var uprintTone = u.accountBalance == null
      ? null
      : u.accountBalance < 50 ? 'danger' : u.accountBalance < 200 ? 'warn' : 'good';

    $('overviewMetrics').innerHTML =
      metricCard(
        'UprintBD account',
        u.accountBalance == null ? '—' : taka(u.accountBalance),
        u.accountBalanceAt ? 'checked ' + ago(u.accountBalanceAt) : 'not checked yet',
        uprintTone
      ) +
      metricCard('Users', String(t.users || 0), 'with an account') +
      metricCard('Student balances', taka(t.floatHeld || 0), 'topped up, unspent') +
      metricCard('Held right now', taka(t.reserved || 0), (t.openHolds || 0) + ' unprinted code(s)', t.openHolds ? 'warn' : null) +
      metricCard(
        'Unmatched prints',
        String(u.unmatchedPrints || 0),
        u.unmatchedPrints ? 'paper nobody was charged for' : 'all prints accounted for',
        u.unmatchedPrints ? 'danger' : 'good'
      );

    var pill = $('uprintPillText');
    var dot = $('uprintDot');
    if (pill) {
      pill.textContent = u.accountBalance == null
        ? 'UprintBD balance unknown'
        : 'UprintBD ' + taka(u.accountBalance);
    }
    if (dot) {
      dot.className = 'pulse-dot ' + (u.accountBalance == null ? 'down' : uprintTone === 'danger' ? 'down' : 'up');
    }

    var p = o.pricing || {};
    $('moneyPosition').innerHTML =
      '<dl class="console-dl">' +
      '<dt>Price per b/w page</dt><dd>' + taka(p.mono) + '</dd>' +
      '<dt>Price per colour page</dt><dd>' + taka(p.color) + '</dd>' +
      '<dt>Student balances on hand</dt><dd>' + taka(t.floatHeld || 0) + '</dd>' +
      '<dt>Of which reserved</dt><dd>' + taka(t.reserved || 0) + '</dd>' +
      '<dt>Open holds</dt><dd>' + (t.openHolds || 0) + ' worth ' + taka(t.openHoldValue || 0) + '</dd>' +
      '</dl>' +
      '<p class="console-muted console-note">' +
      'Student balances are a liability, not income: every taka there is a page someone ' +
      'has already paid for and has not printed. Keep the UprintBD account above it.' +
      '</p>';

    var lastRun = u.lastRun || {};
    var stale = !u.lastReconcileAt || Date.now() - u.lastReconcileAt > 10 * 60 * 1000;
    $('reconcilerHealth').innerHTML =
      '<dl class="console-dl">' +
      '<dt>Last run</dt><dd>' + (u.lastReconcileAt ? ago(u.lastReconcileAt) : 'never') +
      (stale ? ' <span class="console-tag console-tag--warn">stale</span>' : '') + '</dd>' +
      '<dt>Settled last run</dt><dd>' + (lastRun.settled == null ? '—' : lastRun.settled) + '</dd>' +
      '<dt>Released last run</dt><dd>' + (lastRun.released == null ? '—' : lastRun.released) + '</dd>' +
      '<dt>Reason</dt><dd>' + esc(lastRun.reason || '—') + '</dd>' +
      '</dl>' +
      (u.lastError
        ? '<p class="console-error">Last error: ' + esc(u.lastError) + '</p>'
        : '<p class="console-muted console-note">' +
          'The reconciler is what turns holds into charges. If it stalls, prints stay ' +
          'reserved and nobody is over-charged — but the money stays frozen, so a stale ' +
          'timestamp is worth chasing.</p>');
  }

  function loadOverview(btn) {
    var restore = busy(btn, 'Refreshing…');
    return api('/api/admin/overview')
      .then(function (res) {
        data.overview = res;
        data.pricing = res.pricing;
        data.limits = res.limits;
        renderOverview();
        if (loaded.settings) fillSettings();
      })
      .catch(function () {})
      .then(restore);
  }

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------
  function renderUsers() {
    var body = $('usersTableBody');
    if (!body) return;

    if (!data.users.length) {
      body.innerHTML = '<tr><td colspan="7" class="console-empty">No users match.</td></tr>';
      return;
    }

    body.innerHTML = data.users
      .map(function (u) {
        var roles = [];
        if (u.coverAdmin) roles.push('<span class="console-tag">cover admin</span>');
        if (u.disabled) roles.push('<span class="console-tag console-tag--danger">disabled</span>');

        return (
          '<tr data-uid="' + esc(u.uid) + '">' +
          '<td><div class="console-user">' +
          '<div class="console-user-name">' + esc(u.displayName || '(no name)') + '</div>' +
          '<div class="console-user-mail">' + esc(u.email) + '</div>' +
          '</div></td>' +
          '<td class="num">' + taka(u.balance) + '</td>' +
          '<td class="num">' + (u.reserved ? taka(u.reserved) : '—') + '</td>' +
          '<td class="num strong">' + taka(u.available) + '</td>' +
          '<td>' + (roles.join(' ') || '<span class="console-muted">student</span>') + '</td>' +
          '<td>' + esc(ago(u.lastSeenAt)) + '</td>' +
          '<td class="actions">' +
          '<button type="button" class="btn btn-primary btn-xs" data-act="topup">Top up</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-act="adjust">Adjust</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-act="ledger">Ledger</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-act="role">' +
          (u.coverAdmin ? 'Revoke admin' : 'Make admin') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-act="disable">' +
          (u.disabled ? 'Enable' : 'Disable') + '</button>' +
          '</td></tr>'
        );
      })
      .join('');
  }

  function loadUsers(btn) {
    var q = ($('userSearch') && $('userSearch').value.trim()) || '';
    var restore = busy(btn, 'Refreshing…');
    return api('/api/admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''))
      .then(function (res) {
        data.users = res.users || [];
        renderUsers();
      })
      .catch(function () {})
      .then(restore);
  }

  function findUser(uid) {
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].uid === uid) return data.users[i];
    }
    return null;
  }

  function doTopUp(user) {
    var limits = data.limits || {};
    return openForm({
      tag: 'Top up',
      title: 'Add balance for ' + (user.displayName || user.email),
      lead:
        'This adds DDB balance only — it does not move money. Take the bKash payment ' +
        'first, then record its transaction ID here so the two can be reconciled later.',
      fields: [
        {
          name: 'amount', label: 'Amount (৳)', type: 'number',
          min: limits.minTopUp != null ? limits.minTopUp : 5,
          max: limits.maxTopUp != null ? limits.maxTopUp : 2000,
          step: 1, required: true,
          hint: 'Whole taka. Currently ' + taka(user.available) + ' available.',
        },
        {
          name: 'note', label: 'bKash transaction ID / note', type: 'text',
          hint: 'Strongly recommended. This is the only paper trail linking the payment to the balance.',
        },
      ],
      confirmLabel: 'Add balance',
    }).then(function (v) {
      if (!v) return null;
      return api('/api/admin/topup', {
        method: 'POST',
        body: JSON.stringify({
          uid: user.uid,
          amount: Number(v.amount),
          note: v.note,
          method: 'bKash',
        }),
      }).then(function (res) {
        toast('Added ' + taka(v.amount) + ' — now ' + taka(res.wallet.available) + ' available.', '✅');
        return Promise.all([loadUsers(), loadOverview()]);
      });
    });
  }

  function doAdjust(user) {
    return openForm({
      tag: 'Adjust',
      title: 'Adjust balance for ' + (user.displayName || user.email),
      lead:
        'For refunds and corrections. Use a negative number to take balance away. ' +
        'A balance can never go below zero, and every adjustment is recorded in the ledger.',
      fields: [
        {
          name: 'delta', label: 'Change (৳, may be negative)', type: 'number', step: 1, required: true,
          hint: 'Currently ' + taka(user.balance) + ' balance, ' + taka(user.available) + ' available.',
        },
        { name: 'note', label: 'Reason', type: 'text', required: true,
          hint: 'Shown in the ledger. Be specific enough to make sense in a month.' },
      ],
      confirmLabel: 'Apply adjustment',
    }).then(function (v) {
      if (!v) return null;
      var delta = Number(v.delta);
      if (!delta) {
        toast('Nothing to change.', '⚠️');
        return null;
      }
      return api('/api/admin/adjust', {
        method: 'POST',
        body: JSON.stringify({
          uid: user.uid,
          delta: delta,
          note: v.note,
          type: delta > 0 ? 'refund' : 'adjustment',
        }),
      }).then(function (res) {
        toast('Balance is now ' + taka(res.wallet.available) + ' available.', '✅');
        return Promise.all([loadUsers(), loadOverview()]);
      });
    });
  }

  function doRole(user) {
    var granting = !user.coverAdmin;
    return confirmAction(
      granting ? 'Grant coverpage admin?' : 'Revoke coverpage admin?',
      granting
        ? (user.email + ' will be able to edit courses, assignments and the student list ' +
           'for every user of every LabDDB tool. They will not be able to touch money.')
        : (user.email + ' will lose access to the course admin panel. Their account, ' +
           'balance and print history are unaffected.'),
      granting ? 'Grant access' : 'Revoke access'
    ).then(function (ok) {
      if (!ok) return null;
      return api('/api/admin/user-flags', {
        method: 'POST',
        body: JSON.stringify({ uid: user.uid, coverAdmin: granting }),
      }).then(function () {
        toast(granting ? 'Coverpage admin granted.' : 'Coverpage admin revoked.', '✅');
        return loadUsers();
      });
    });
  }

  function doDisable(user) {
    var disabling = !user.disabled;
    return confirmAction(
      disabling ? 'Disable this account?' : 'Re-enable this account?',
      disabling
        ? (user.email + ' will no longer be able to create kiosk codes. Their balance of ' +
           taka(user.balance) + ' stays untouched, and any code already minted still works.')
        : (user.email + ' will be able to create kiosk codes again.'),
      disabling ? 'Disable account' : 'Enable account'
    ).then(function (ok) {
      if (!ok) return null;
      return api('/api/admin/user-flags', {
        method: 'POST',
        body: JSON.stringify({ uid: user.uid, disabled: disabling }),
      }).then(function () {
        toast(disabling ? 'Account disabled.' : 'Account enabled.', '✅');
        return loadUsers();
      });
    });
  }

  function initUsers() {
    var search = $('userSearch');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { loadUsers(); }, 260);
      });
    }
    var refresh = $('refreshUsersBtn');
    if (refresh) refresh.addEventListener('click', function () { loadUsers(refresh); });

    var body = $('usersTableBody');
    if (body) {
      body.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!btn) return;
        var row = btn.closest('tr');
        var user = findUser(row && row.getAttribute('data-uid'));
        if (!user) return;
        var act = btn.getAttribute('data-act');
        if (act === 'topup') doTopUp(user);
        else if (act === 'adjust') doAdjust(user);
        else if (act === 'role') doRole(user);
        else if (act === 'disable') doDisable(user);
        else if (act === 'ledger') {
          if ($('ledgerUid')) $('ledgerUid').value = user.uid;
          loaded.ledger = true;
          switchTab('ledger');
          loadLedger();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // jobs
  // ---------------------------------------------------------------------------
  var JOB_STATUS = {
    reserving: ['Creating', 'pending'],
    reserved: ['Not printed yet', 'pending'],
    printed: ['Printed · charged', 'done'],
    expired: ['Expired · refunded', 'muted'],
    cancelled: ['Cancelled · refunded', 'muted'],
    failed: ['Failed · not charged', 'muted'],
  };

  function renderJobs() {
    var body = $('jobsTableBody');
    if (!body) return;

    if (!data.jobs.length) {
      body.innerHTML =
        '<tr><td colspan="8" class="console-empty">' +
        (data.jobScope === 'open' ? 'No open holds — every code has been printed or refunded.' : 'No jobs yet.') +
        '</td></tr>';
      return;
    }

    body.innerHTML = data.jobs
      .map(function (j) {
        var s = JOB_STATUS[j.status] || [j.status || '—', 'muted'];
        var live = j.status === 'reserved' || j.status === 'reserving';
        return (
          '<tr data-uid="' + esc(j.uid || '') + '" data-job="' + esc(j.id) + '">' +
          '<td>' + esc(when(j.createdAt)) + '</td>' +
          '<td class="wrap">' + esc(j.email || j.uid || '—') + '</td>' +
          '<td class="wrap mono">' + esc(j.filename || '—') + '</td>' +
          '<td class="num">' + taka(j.price) + '</td>' +
          '<td class="num">' + (j.actualCost == null ? '—' : taka(j.actualCost)) + '</td>' +
          '<td><span class="console-tag console-tag--' + s[1] + '">' + esc(s[0]) + '</span></td>' +
          '<td class="mono">' + esc(live && j.otp ? j.otp : '—') + '</td>' +
          '<td class="actions">' +
          (live
            ? '<button type="button" class="btn btn-ghost btn-xs" data-act="settle">Force settle</button>' +
              '<button type="button" class="btn btn-ghost btn-xs" data-act="expire">Refund &amp; delete</button>'
            : '<span class="console-muted">—</span>') +
          '</td></tr>'
        );
      })
      .join('');
  }

  function loadJobs(btn) {
    var restore = busy(btn, 'Refreshing…');
    return api('/api/admin/jobs?scope=' + encodeURIComponent(data.jobScope))
      .then(function (res) {
        data.jobs = res.jobs || [];
        renderJobs();
      })
      .catch(function () {})
      .then(restore);
  }

  function doJobAction(uid, jobId, action) {
    var settling = action === 'settle';
    return confirmAction(
      settling ? 'Charge for this print?' : 'Refund and delete this code?',
      settling
        ? 'Use this only when you know the page really printed but the reconciler could ' +
          'not match it — usually a renamed file. The balance is charged now. Clicking ' +
          'twice is safe: the ledger will not charge the same job again.'
        : 'The code is deleted at UprintBD first, then the hold is released back to the ' +
          'student. If the page has already printed, settle it instead — refunding a printed ' +
          'page means the institution paid and nobody did.',
      settling ? 'Charge it' : 'Refund it'
    ).then(function (ok) {
      if (!ok) return null;
      return api('/api/admin/job-action', {
        method: 'POST',
        body: JSON.stringify({ uid: uid, jobId: jobId, action: action }),
      }).then(function () {
        toast(settling ? 'Job settled.' : 'Hold released.', '✅');
        return Promise.all([loadJobs(), loadOverview()]);
      });
    });
  }

  function initJobs() {
    var scope = $('jobScope');
    if (scope) {
      scope.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.console-segment-btn') : null;
        if (!btn) return;
        var buttons = scope.querySelectorAll('.console-segment-btn');
        for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active');
        btn.classList.add('active');
        data.jobScope = btn.getAttribute('data-scope');
        loadJobs();
      });
    }

    var refresh = $('refreshJobsBtn');
    if (refresh) refresh.addEventListener('click', function () { loadJobs(refresh); });

    var body = $('jobsTableBody');
    if (body) {
      body.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!btn) return;
        var row = btn.closest('tr');
        doJobAction(
          row.getAttribute('data-uid'),
          row.getAttribute('data-job'),
          btn.getAttribute('data-act')
        );
      });
    }
  }

  // ---------------------------------------------------------------------------
  // ledger
  // ---------------------------------------------------------------------------
  var LEDGER_TYPE = {
    topup: ['Top-up', 'good'],
    charge: ['Charge', 'done'],
    refund: ['Refund', 'muted'],
    adjustment: ['Adjustment', 'warn'],
  };

  function renderLedger() {
    var t = data.ledgerTotals || {};
    var totals = $('ledgerTotals');
    if (totals) {
      totals.innerHTML =
        metricCard('Topped up', taka(t.topups || 0), 'balance issued') +
        metricCard('Charged', taka(t.revenue || 0), 'pages actually printed') +
        metricCard('Adjustments', taka(t.adjustments || 0), 'refunds and corrections') +
        metricCard('Entries', String(data.ledger.length), 'newest first');
    }

    var body = $('ledgerTableBody');
    if (!body) return;
    if (!data.ledger.length) {
      body.innerHTML = '<tr><td colspan="6" class="console-empty">No ledger entries.</td></tr>';
      return;
    }

    body.innerHTML = data.ledger
      .map(function (e) {
        var kind = LEDGER_TYPE[e.type] || [e.type || '—', 'muted'];
        var amt = Number(e.amount) || 0;
        return (
          '<tr>' +
          '<td>' + esc(when(e.createdAt)) + '</td>' +
          '<td class="wrap mono">' + esc(e.uid) + '</td>' +
          '<td><span class="console-tag console-tag--' + kind[1] + '">' + esc(kind[0]) + '</span></td>' +
          '<td class="num ' + (amt < 0 ? 'neg' : 'pos') + '">' +
          (amt > 0 ? '+' : '') + taka(amt) + '</td>' +
          '<td class="num">' + taka(e.balanceAfter) + '</td>' +
          '<td class="wrap">' + esc(e.note || '') + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function loadLedger(btn) {
    var uid = ($('ledgerUid') && $('ledgerUid').value.trim()) || '';
    var restore = busy(btn, 'Loading…');
    return api('/api/admin/ledger' + (uid ? '?uid=' + encodeURIComponent(uid) : ''))
      .then(function (res) {
        data.ledger = res.entries || [];
        data.ledgerTotals = res.totals || null;
        renderLedger();
      })
      .catch(function () {})
      .then(restore);
  }

  /**
   * CSV of what is on screen. Deliberately not a server export: the accounting
   * that matters is the RTDB ledger itself, and this is just for reading in a
   * spreadsheet next to the bKash statement.
   */
  function exportLedgerCsv() {
    if (!data.ledger.length) {
      toast('Nothing to export yet.', '⚠️');
      return;
    }
    var head = ['when', 'uid', 'type', 'amount', 'balanceAfter', 'jobId', 'note', 'byUid'];
    var lines = [head.join(',')];

    function cell(v) {
      var s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    data.ledger.forEach(function (e) {
      lines.push([
        cell(e.createdAt ? new Date(e.createdAt).toISOString() : ''),
        cell(e.uid), cell(e.type), cell(e.amount), cell(e.balanceAfter),
        cell(e.jobId || ''), cell(e.note || ''), cell(e.byUid || ''),
      ].join(','));
    });

    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'labddb-ledger.csv';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function initLedger() {
    var refresh = $('refreshLedgerBtn');
    if (refresh) refresh.addEventListener('click', function () { loadLedger(refresh); });
    var exportBtn = $('exportLedgerBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportLedgerCsv);
    var uid = $('ledgerUid');
    if (uid) {
      uid.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') loadLedger();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // pricing & limits
  // ---------------------------------------------------------------------------
  var SETTING_FIELDS = [
    ['priceMono', 'mono', 'pricing'],
    ['priceColor', 'color', 'pricing'],
    ['priceMaxCopies', 'maxCopies', 'pricing'],
    ['limitOpenHolds', 'maxOpenHolds', 'limits'],
    ['limitPerHour', 'maxJobsPerHour', 'limits'],
    ['limitPages', 'maxPagesPerJob', 'limits'],
    ['limitMinTopUp', 'minTopUp', 'limits'],
    ['limitMaxTopUp', 'maxTopUp', 'limits'],
    ['limitGrace', 'holdGraceSeconds', 'limits'],
  ];

  function fillSettings() {
    if (!data.pricing) {
      // Settings opened before the overview finished; fetch it, then fill.
      return loadOverview().then(function () {
        if (data.pricing) fillSettings();
      });
    }
    SETTING_FIELDS.forEach(function (f) {
      var input = $(f[0]);
      var source = f[2] === 'pricing' ? data.pricing : data.limits;
      if (input && source && source[f[1]] != null) input.value = source[f[1]];
    });
    return Promise.resolve();
  }

  function saveSettings(btn) {
    var payload = {};
    var bad = null;
    SETTING_FIELDS.forEach(function (f) {
      var input = $(f[0]);
      if (!input || input.value === '') return;
      var n = Number(input.value);
      if (!isFinite(n) || n < 0 || Math.round(n) !== n) bad = bad || f[1];
      payload[f[1]] = n;
    });
    if (bad) {
      toast(bad + ' must be a whole number of 0 or more.', '⚠️');
      return Promise.resolve();
    }

    var restore = busy(btn, 'Saving…');
    var status = $('settingsStatus');
    return api('/api/admin/pricing', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (res) {
        data.pricing = res.pricing;
        data.limits = res.limits;
        fillSettings();
        if (status) status.textContent = 'Saved. Every calculator now quotes these prices.';
        toast('Pricing and limits saved.', '✅');
        return loadOverview();
      })
      .catch(function () {
        if (status) status.textContent = '';
      })
      .then(restore);
  }

  function initSettings() {
    var btn = $('saveSettingsBtn');
    if (btn) btn.addEventListener('click', function () { saveSettings(btn); });
  }

  // ---------------------------------------------------------------------------
  // reconciliation
  // ---------------------------------------------------------------------------
  function renderUnmatched(rows) {
    var body = $('unmatchedTableBody');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML =
        '<tr><td colspan="6" class="console-empty">' +
        'Nothing unmatched. Every page UprintBD printed is tied to a charged job.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(function (r) {
        return (
          '<tr data-key="' + esc(r.key) + '">' +
          '<td>' + esc(r.dateTime || when(r.seenAt)) + '</td>' +
          '<td class="wrap mono">' + esc(r.filename || '—') + '</td>' +
          '<td class="num">' + (r.cost == null ? '—' : taka(r.cost)) + '</td>' +
          '<td class="num">' + (r.pages == null ? '—' : r.pages) + '</td>' +
          '<td>' + esc(r.deviceId || '—') + '</td>' +
          '<td class="actions">' +
          '<button type="button" class="btn btn-ghost btn-xs" data-act="clear">Dismiss</button>' +
          '</td></tr>'
        );
      })
      .join('');
  }

  function loadUnmatched(btn) {
    var restore = busy(btn, 'Refreshing…');
    return api('/api/admin/unmatched')
      .then(function (res) {
        renderUnmatched(res.rows || []);
      })
      .catch(function () {})
      .then(restore);
  }

  function loadUprintHistory(btn) {
    var restore = busy(btn, 'Fetching…');
    var body = $('uprintTableBody');
    if (body) body.innerHTML = '<tr><td colspan="7" class="console-empty">Signing in to UprintBD…</td></tr>';
    return api('/api/admin/uprint')
      .then(function (res) {
        if (res.balanceError) toast('Balance unavailable: ' + res.balanceError, '⚠️');
        var pill = $('uprintPillText');
        if (pill && res.balance != null) pill.textContent = 'UprintBD ' + taka(res.balance);

        var rows = res.history || [];
        if (!body) return;
        if (res.historyError) {
          body.innerHTML =
            '<tr><td colspan="7" class="console-empty">' + esc(res.historyError) + '</td></tr>';
          return;
        }
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="7" class="console-empty">No prints in the last 7 days.</td></tr>';
          return;
        }
        body.innerHTML = rows
          .map(function (r) {
            return (
              '<tr>' +
              '<td>' + esc(r.dateTime || '—') + '</td>' +
              '<td class="wrap mono">' + esc(r.filename || '—') + '</td>' +
              '<td class="num">' + (r.cost == null ? '—' : taka(r.cost)) + '</td>' +
              '<td class="num">' + (r.copies == null ? '—' : r.copies) + '</td>' +
              '<td class="num">' + (r.pages == null ? '—' : r.pages) + '</td>' +
              '<td>' + esc(r.status || '—') + '</td>' +
              '<td>' + esc(r.deviceId || '—') + '</td>' +
              '</tr>'
            );
          })
          .join('');
      })
      .catch(function () {
        if (body) body.innerHTML = '<tr><td colspan="7" class="console-empty">Could not reach UprintBD.</td></tr>';
      })
      .then(restore);
  }

  function runReconcile(btn) {
    var restore = busy(btn, 'Running…');
    return api('/api/admin/reconcile', { method: 'POST' })
      .then(function (res) {
        var s = res.summary || {};
        toast(
          'Settled ' + (s.settled || 0) + ', released ' + (s.released || 0) +
          (s.unmatched ? ', ' + s.unmatched + ' unmatched' : '') + '.',
          '✅'
        );
        return Promise.all([loadOverview(), loadUnmatched(), loaded.jobs ? loadJobs() : null]);
      })
      .catch(function () {})
      .then(restore);
  }

  function initReconcile() {
    var run = $('runReconcileBtn');
    if (run) run.addEventListener('click', function () { runReconcile(run); });
    var refreshU = $('refreshUnmatchedBtn');
    if (refreshU) refreshU.addEventListener('click', function () { loadUnmatched(refreshU); });
    var refreshUp = $('refreshUprintBtn');
    if (refreshUp) refreshUp.addEventListener('click', function () { loadUprintHistory(refreshUp); });
    var refreshO = $('refreshOverviewBtn');
    if (refreshO) refreshO.addEventListener('click', function () { loadOverview(refreshO); });

    var body = $('unmatchedTableBody');
    if (body) {
      body.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-act="clear"]') : null;
        if (!btn) return;
        var key = btn.closest('tr').getAttribute('data-key');
        confirmAction(
          'Dismiss this row?',
          'Dismissing only clears the warning — it does not charge anyone. Do this once ' +
          'you have worked out who the page belonged to and adjusted their balance by hand.',
          'Dismiss'
        ).then(function (ok) {
          if (!ok) return;
          return api('/api/admin/unmatched', {
            method: 'POST',
            body: JSON.stringify({ key: key }),
          }).then(function () {
            return Promise.all([loadUnmatched(), loadOverview()]);
          });
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // audit logs (D1 & R2)
  // ---------------------------------------------------------------------------
  function formatAuditDetails(d) {
    if (!d) return '—';
    if (typeof d === 'string') return esc(d);
    var parts = [];
    if (d.amount != null) parts.push('<b>Amount:</b> ' + taka(d.amount));
    if (d.delta != null) parts.push('<b>Delta:</b> ' + (d.delta > 0 ? '+' : '') + taka(d.delta));
    if (d.method) parts.push('<b>Method:</b> ' + esc(d.method));
    if (d.note) parts.push('<b>Note:</b> ' + esc(d.note));
    if (d.jobId) parts.push('<b>Job:</b> <code class="mono">' + esc(d.jobId) + '</code>');
    if (d.key) parts.push('<b>Key:</b> ' + esc(d.key));
    if (d.disabled !== undefined) parts.push('<b>Disabled:</b> ' + d.disabled);
    if (d.coverAdmin !== undefined) parts.push('<b>CoverAdmin:</b> ' + d.coverAdmin);
    if (d.pricing) parts.push('<b>Pricing:</b> ' + JSON.stringify(d.pricing));
    if (d.limits) parts.push('<b>Limits:</b> ' + JSON.stringify(d.limits));
    if (!parts.length) return esc(JSON.stringify(d));
    return parts.join(' | ');
  }

  function auditBadge(action) {
    var act = String(action || '').toLowerCase();
    var cls = 'badge-muted';
    if (act.includes('topup')) cls = 'badge-success';
    else if (act.includes('adjust') || act.includes('refund')) cls = 'badge-info';
    else if (act.includes('flag') || act.includes('pricing')) cls = 'badge-warn';
    else if (act.includes('force') || act.includes('expire') || act.includes('cancel')) cls = 'badge-danger';
    return '<span class="status-badge ' + cls + '">' + esc(action || '—') + '</span>';
  }

  function loadAuditLogs(btn) {
    var restore = busy(btn, 'Refreshing…');
    var body = $('auditTableBody');
    if (body) body.innerHTML = '<tr><td colspan="6" class="console-empty">Loading audit logs…</td></tr>';

    var actionFilter = $('auditActionFilter') ? $('auditActionFilter').value : '';
    var search = $('auditSearch') ? $('auditSearch').value.trim() : '';

    var params = new URLSearchParams();
    if (actionFilter) params.set('action', actionFilter);
    if (search) params.set('search', search);

    return api('/api/admin/audit-logs' + (params.toString() ? '?' + params.toString() : ''))
      .then(function (res) {
        if (!body) return;
        if (!res.d1Available) {
          body.innerHTML =
            '<tr><td colspan="6" class="console-empty">' +
            'Cloudflare D1 is not bound yet in this environment. Logs will appear once D1 is active.' +
            '</td></tr>';
          return;
        }
        var logs = res.logs || [];
        if (!logs.length) {
          body.innerHTML = '<tr><td colspan="6" class="console-empty">No audit logs found.</td></tr>';
          return;
        }
        body.innerHTML = logs
          .map(function (r) {
            return (
              '<tr>' +
              '<td>' + when(r.timestamp) + '</td>' +
              '<td>' + auditBadge(r.action) + '</td>' +
              '<td>' + esc(r.actor_email || r.actor_uid || '—') + '</td>' +
              '<td class="mono">' + esc(r.target_uid || '—') + '</td>' +
              '<td>' + formatAuditDetails(r.details) + '</td>' +
              '<td class="mono">' + esc(r.ip || '—') + '</td>' +
              '</tr>'
            );
          })
          .join('');
      })
      .catch(function (err) {
        if (body) body.innerHTML = '<tr><td colspan="6" class="console-empty">Could not load audit logs.</td></tr>';
      })
      .then(restore);
  }

  function initAudit() {
    var refresh = $('refreshAuditBtn');
    if (refresh) refresh.addEventListener('click', function () { loadAuditLogs(refresh); });

    var filter = $('auditActionFilter');
    if (filter) filter.addEventListener('change', function () { loadAuditLogs(); });

    var search = $('auditSearch');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { loadAuditLogs(); }, 350);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // gate
  // ---------------------------------------------------------------------------
  function lockScreen(title, message, actionLabel, onAction) {
    var host = $('consoleLock');
    var main = $('consoleMain');
    if (main) main.hidden = true;
    if (!host) return;
    host.hidden = false;
    host.innerHTML =
      '<div class="admin-lock-card">' +
      '<div class="admin-lock-icon">🔐</div>' +
      '<h2>' + esc(title) + '</h2>' +
      '<p>' + esc(message) + '</p>' +
      (actionLabel
        ? '<button type="button" class="btn btn-primary" id="consoleLockBtn">' + esc(actionLabel) + '</button>'
        : '') +
      '</div>';
    var btn = $('consoleLockBtn');
    if (btn && onAction) btn.onclick = onAction;
  }

  function unlock() {
    var host = $('consoleLock');
    if (host) {
      host.hidden = true;
      host.innerHTML = '';
    }
    var main = $('consoleMain');
    if (main) main.hidden = false;
  }

  function boot() {
    if (!booted) {
      booted = true;
      initUsers();
      initJobs();
      initLedger();
      initAudit();
      initSettings();
      initReconcile();
    }
    // Always refresh the overview (the header pill and money position live there),
    // plus whichever tab is showing — after a sign-out/sign-in round trip that may
    // not be the overview.
    loadOverview();
    var tab = activeTab();
    if (tab !== 'overview') {
      loaded[tab] = true;
      loadTab(tab);
    }
  }

  function gate() {
    if (gating) return;

    if (!auth || !auth.isConfigured()) {
      lockScreen(
        'Console unavailable',
        'Firebase Auth is not configured in this build, so there is no way to verify who ' +
        'you are. Set the LabDDB-Pro keys in js/labddb-config.js and reload.',
        null
      );
      return;
    }

    gating = true;
    lockScreen('Checking…', 'Confirming this account may manage balances.', null);

    auth
      .whenReady()
      .then(function () {
        if (!auth.user) {
          lockScreen(
            'Project admin sign-in',
            'This console moves real money. Sign in with the project admin account to continue.',
            'Sign in with Google',
            function () {
              auth.signIn().catch(function (err) {
                if (err && err.cancelled) return;
                toast(err.message || 'Sign-in failed.', '⚠️');
              });
            }
          );
          return;
        }
        if (!auth.roles.projectAdmin) {
          lockScreen(
            'Not this account',
            auth.user.email + ' is signed in, but the console is restricted to a single ' +
            'project admin account. Nothing here is available to other users.',
            'Sign in as someone else',
            function () {
              auth.signOut();
            }
          );
          return;
        }
        unlock();
        boot();
      })
      .catch(function (err) {
        if (err && err.cancelled) return;
        lockScreen(
          'Could not verify access',
          (err && err.message) || 'The bridge did not answer.',
          'Try again',
          gate
        );
      })
      .then(function () {
        gating = false;
      });
  }

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  function init() {
    initTheme();
    initTabs();

    auth = global.LabDDB && global.LabDDB.auth;
    if (!auth) {
      lockScreen(
        'Console unavailable',
        'js/labddb-auth.js did not load, so sign-in is impossible. Check the script tags.',
        null
      );
      return;
    }

    var out = $('signOutBtn');
    if (out) {
      out.addEventListener('click', function () {
        auth.signOut();
      });
    }

    // Signing in or out or role change re-runs the gate, no reload needed.
    var lastStateKey = '';
    auth.onChange(function (s) {
      var uid = s.user ? s.user.uid : null;
      var roleKey = (s.roles && s.roles.projectAdmin) ? 'admin' : 'user';
      var stateKey = (uid || 'anon') + ':' + roleKey;
      if (stateKey === lastStateKey) return;
      lastStateKey = stateKey;
      if (!uid) loaded = {};
      gate();
    });

    gate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
