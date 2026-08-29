/* =============================================================================
   uprint.js — UprintBD Kiosk Bridge Client & Interactive OTP Modal
   Native-feeling Mobile Bottom Sheet, Real-time Timers, History Drawer & Toasts
   -----------------------------------------------------------------------------
   One shared print flow lives here: Uprint.requestPrint(). All four generator
   pages call it, so the auth gate, the money rules and the modal states exist in
   exactly one place. A page only has to say *what* to print.
   ============================================================================= */
(function (global) {
  'use strict';

  // The bridge is same-origin in the demo. Override for a hosted bridge, e.g.
  // window.UPRINT_BRIDGE_URL = 'https://bridge.labddb.app';
  var BRIDGE = (global.UPRINT_BRIDGE_URL || '').replace(/\/$/, '');

  function api(path) {
    return BRIDGE + path;
  }

  /** LabDDB.auth, once labddb-auth.js has loaded. Absent on pages without it. */
  function auth() {
    return global.LabDDB && global.LabDDB.auth ? global.LabDDB.auth : null;
  }

  function pricing() {
    return (global.LabDDB && global.LabDDB.pricing) || { mono: 3, color: 5, currency: 'BDT' };
  }

  /** Render a DOM element to an A4 PDF and return a base64 string (no prefix). */
  function elementToPdfBase64(el) {
    return new Promise(function (resolve, reject) {
      if (!global.html2canvas || !global.jspdf) {
        reject(new Error('PDF libraries not loaded.'));
        return;
      }

      // Create an unscaled offscreen wrapper to completely isolate rendering
      // from any ancestor CSS transforms (like .preview-scale-wrapper)
      var wrapper = document.createElement('div');
      wrapper.style.cssText =
        'position: fixed !important; left: -99999px !important; top: 0 !important;' +
        'width: 794px !important; height: 1123px !important; min-height: 1123px !important;' +
        'margin: 0 !important; padding: 0 !important; transform: none !important;' +
        'background: #ffffff !important; z-index: -99999 !important; overflow: hidden !important;';

      var clone = el.cloneNode(true);
      clone.classList.remove('editing');
      clone.querySelectorAll('[contenteditable]').forEach(function (n) {
        n.removeAttribute('contenteditable');
      });

      // Force exact A4 dimensions at standard 96 DPI (794px × 1123px)
      clone.style.cssText =
        'width: 794px !important; height: 1123px !important; min-height: 1123px !important;' +
        'max-height: 1123px !important; transform: none !important; margin: 0 !important;' +
        'box-sizing: border-box !important; box-shadow: none !important; background: #ffffff !important;';

      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      // Give browser one frame to layout and resolve fonts/images
      setTimeout(function () {
        global
          .html2canvas(clone, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            width: 794,
            height: 1123,
            windowWidth: 794,
            windowHeight: 1123,
            scrollX: 0,
            scrollY: 0,
          })
          .then(function (canvas) {
            if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);

            var img = canvas.toDataURL('image/jpeg', 0.98);
            var pdf = new global.jspdf.jsPDF({
              orientation: 'portrait',
              unit: 'mm',
              format: 'a4',
              compress: true,
            });

            // Keep clean margins from all 4 sides of the A4 page (210mm × 297mm)
            var marginX = 6; // 6mm side margin
            var pw = 210;
            var ph = 297;
            var scaleFactor = (pw - 2 * marginX) / pw;
            var renderW = pw * scaleFactor;
            var renderH = ph * scaleFactor;
            var marginY = (ph - renderH) / 2; // ~8.5mm top/bottom margin for perfect aspect ratio

            pdf.addImage(img, 'JPEG', marginX, marginY, renderW, renderH, undefined, 'FAST');

            var uri = pdf.output('datauristring'); // data:application/pdf;base64,....
            resolve(uri.split(',').pop());
          })
          .catch(function (err) {
            if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
            reject(err);
          });
      }, 100);
    });
  }

  /** POST the PDF to the bridge and resolve with { otp, cost, ... }. */
  function requestOtp(pdfBase64, meta) {
    var payload = JSON.stringify({
      pdfBase64: pdfBase64,
      filename: meta.filename || 'CoverPage.pdf',
      copies: meta.copies || 1,
      color: !!meta.color,
      clientJobId: meta.clientJobId || null,
      meta: {
        tool: meta.tool || '',
        title: meta.title || '',
        courseCode: meta.courseCode || '',
        roll: meta.roll || '',
      },
    });

    // Signed-in path: LabDDB.auth.fetch attaches the Firebase ID token and
    // retries once with a fresh one if it expired while the page was open.
    var a = auth();
    if (a && a.user) return a.fetch('/api/print', { method: 'POST', body: payload });

    return fetch(api('/api/print'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }).then(function (res) {
      return res.json().then(
        function (data) {
          if (!res.ok || !data.ok) {
            var err = new Error(data.error || 'Bridge returned HTTP ' + res.status);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        },
        function () {
          var err = new Error('The bridge returned an unreadable response.');
          err.status = res.status;
          throw err;
        }
      );
    });
  }

  /**
   * Generates a standardized coverpage filename:
   * Format: LabDDB_[Dept]_[course code]_[exp/assignment no]_Roll.pdf
   * Example: LabDDB_EEE_417_03_24702008.pdf
   */
  function formatCoverFilename(dept, courseCode, expOrAssignmentNo, roll) {
    var d = String(dept || '').trim();
    var c = String(courseCode || '').trim();

    // 1. Dept abbreviation & Course Code Number
    var deptFromCode = '';
    var numFromCode = '';
    var codeMatch = c.match(/^([A-Za-z]+)[\s_-]*([0-9]+[A-Za-z]*)$/);
    if (codeMatch) {
      deptFromCode = codeMatch[1].toUpperCase();
      numFromCode = codeMatch[2];
    } else {
      var numMatch = c.match(/(\d+[A-Za-z]*)/);
      if (numMatch) {
        numFromCode = numMatch[1];
      } else {
        numFromCode = c.replace(/[^A-Za-z0-9]/g, '');
      }
    }

    var finalDept = '';
    if (deptFromCode) {
      finalDept = deptFromCode;
    } else if (d) {
      var cleanD = d.replace(/Dept\.?\s*(of)?/i, '').trim();
      var alphaOnly = cleanD.replace(/[^A-Za-z]/g, '');
      if (alphaOnly.length >= 2 && alphaOnly.length <= 5 && /^[A-Z]+$/.test(alphaOnly)) {
        finalDept = alphaOnly;
      } else {
        var words = cleanD.replace(/department|dept\.?|of|and|the|engineering/gi, ' ').trim().split(/[\s-]+/);
        var letters = words.map(function (w) { return w.charAt(0).toUpperCase(); }).filter(function (l) { return /[A-Z]/.test(l); });
        finalDept = letters.join('');
      }
    }
    if (!finalDept) finalDept = 'EEE';

    var finalCode = numFromCode || '417';

    // 2. Format exp / assignment number
    var noStr = String(expOrAssignmentNo || '').trim();
    var numOnly = noStr.match(/\d+/);
    var finalNo = '';
    if (numOnly) {
      var n = parseInt(numOnly[0], 10);
      finalNo = n < 10 ? ('0' + n) : String(n);
    } else if (noStr) {
      finalNo = noStr.replace(/[^A-Za-z0-9]/g, '');
    } else {
      finalNo = '01';
    }

    // 3. Format roll
    var finalRoll = String(roll || '').trim().replace(/[^A-Za-z0-9]/g, '') || 'Roll';

    return 'LabDDB_' + finalDept + '_' + finalCode + '_' + finalNo + '_' + finalRoll + '.pdf';
  }

  /**
   * The one print flow, shared by every generator page.
   *
   * @param {object} opts
   * @param {HTMLElement} opts.element     the A4 preview node to rasterise
   * @param {string}      opts.filename    base name; the server adds a unique suffix
   * @param {number}     [opts.copies]
   * @param {boolean}    [opts.color]
   * @param {string}     [opts.tool]       which generator asked (for admin reporting)
   * @param {string}     [opts.title]
   * @param {string}     [opts.courseCode]
   * @param {string}     [opts.roll]
   * @param {function}   [opts.validate]   return a string to abort with that message
   * @returns {Promise<object|null>} the mint result, or null if the user backed out
   */
  var printInFlight = false;

  function requestPrint(opts) {
    opts = opts || {};

    if (printInFlight) {
      showToast('Still working on your last code…', '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>');
      return Promise.resolve(null);
    }

    if (typeof opts.validate === 'function') {
      var complaint = opts.validate();
      if (complaint) {
        showToast(complaint, '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>');
        return Promise.resolve(null);
      }
    }

    var el = opts.element;
    if (!el) {
      renderError('Nothing to print — the preview is missing.');
      return Promise.resolve(null);
    }

    var a = auth();
    var gate = a && a.isConfigured() ? a.requireUser(opts.reason) : Promise.resolve(null);

    printInFlight = true;
    // A stable id for this gesture: a double tap or a retried POST cannot mint
    // two OTPs and charge two holds for one document.
    var clientJobId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    return gate
      .then(function () {
        var currentAuth = auth();
        // Check DDB balance: if less than 3, do not get OTP, prompt to recharge
        if (currentAuth && currentAuth.user) {
          var wallet = currentAuth.wallet || { balance: 0, available: 0, reserved: 0 };
          var available = typeof wallet.available === 'number' ? wallet.available : (wallet.balance || 0);
          if (available < 3) {
            printInFlight = false;
            renderInsufficient({
              available: available,
              required: 3,
              reserved: wallet.reserved || 0
            });
            return null;
          }
        }

        renderLoading('Rendering your page…');
        return elementToPdfBase64(el);
      })
      .then(function (pdfBase64) {
        if (!pdfBase64) return null;
        renderLoading('Sending it to the kiosk…');
        return requestOtp(pdfBase64, {
          filename: opts.filename || 'LabDDB_Print.pdf',
          copies: opts.copies || 1,
          color: !!opts.color,
          clientJobId: clientJobId,
          tool: opts.tool || '',
          title: opts.title || '',
          courseCode: opts.courseCode || '',
          roll: opts.roll || '',
        });
      })
      .then(function (data) {
        if (!data) return null;
        printInFlight = false;
        renderSuccess(data, opts);
        if (a && a.refresh) a.refresh();
        return data;
      })
      .catch(function (err) {
        printInFlight = false;

        // Dismissed the sign-in sheet — that is not an error, say nothing.
        if (err && err.cancelled) {
          hide();
          return null;
        }

        var code = err && err.data && err.data.code;
        if (err && err.status === 402) {
          renderInsufficient(err.data || {});
          return null;
        }
        if (err && err.status === 401) {
          renderError('Your session expired. Please sign in again.', function () {
            hide();
            if (a) a.openSignIn('Sign in again to get your kiosk code.');
          }, 'Sign in');
          return null;
        }
        if (code === 'DUPLICATE') {
          renderError(
            'That page was already sent. Check your recent codes rather than paying twice.',
            function () {
              hide();
              if (a) a.openWallet();
            },
            'View my codes'
          );
          return null;
        }
        if (code === 'TOO_MANY_HOLDS') {
          renderError(err.message, function () {
            hide();
            if (a) a.openWallet();
          }, 'Manage my codes');
          return null;
        }

        renderError(err.message || 'Could not create a kiosk code.', function () {
          requestPrint(opts);
        });
        return null;
      });
  }

  function health() {
    return fetch(api('/api/health')).then(function (r) {
      return r.json();
    });
  }

  /**
   * Drive the header "kiosk link" badge from /api/health.
   */
  function bindBridgeBadge(dotEl, textEl, intervalMs) {
    if (!dotEl && !textEl) return null;

    function paint(cls, label) {
      if (dotEl) dotEl.className = 'pulse-dot ' + cls;
      if (textEl) textEl.textContent = label;
    }

    function poll() {
      return health()
        .then(function (h) {
          var ok = h && h.configured && h.configured.kiosk;
          if (ok) return paint('up', 'Kiosk link ready');
          return paint('down', h && h.missing && h.missing.length
            ? 'Kiosk link unconfigured'
            : 'Kiosk link offline');
        })
        .catch(function () {
          paint('down', 'Bridge offline');
        });
    }

    poll();
    if (intervalMs) return setInterval(poll, intervalMs);
    return null;
  }

  // ---- Toast System --------------------------------------------------------
  function showToast(message, icon) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = (icon ? '<span class="toast-icon">' + icon + '</span>' : '') + '<span>' + esc(message) + '</span>';
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.transition = 'opacity 0.2s, transform 0.2s';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 200);
    }, 2800);
  }

  // ---- History Storage Helper ----------------------------------------------
  var STORAGE_KEY = 'uprint_recent_otps_v1';
  
  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveToHistory(record) {
    try {
      var list = getHistory();
      list.unshift({
        jobId: record.jobId || null,
        otp: record.otp,
        cost: record.cost,
        currency: record.currency || 'BDT',
        copies: record.copies || 1,
        pages: record.pages || 1,
        color: !!record.color,
        courseCode: record.courseCode || 'CU',
        roll: record.roll || '',
        timestamp: Date.now(),
        validUntil: Date.now() + (record.validForSeconds || 3600) * 1000,
      });
      // Keep latest 10
      list = list.slice(0, 10);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      updateHistoryBadge();
      if (global.updateHistoryUI) global.updateHistoryUI();
    } catch (e) {
      console.warn('[history] storage unavailable', e);
    }
  }

  function updateHistoryBadge() {
    var badge = document.getElementById('historyCount');
    if (!badge) return;
    var list = getHistory();
    if (list.length > 0) {
      badge.textContent = list.length;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Global helper to copy OTP from history
  global.copyOtpFromHistory = function (code) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code);
    }
    showToast('OTP ' + code + ' copied to clipboard!', '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>');
  };

  // Standard History Drawer initializer
  function initHistoryDrawer() {
    var historyBtn = document.getElementById('historyBtn');
    var drawer = document.getElementById('historyDrawer');
    var backdrop = document.getElementById('historyDrawerBackdrop');
    var closeBtn = document.getElementById('historyDrawerClose');
    var listEl = document.getElementById('historyList');

    // Server-side job status, keyed by jobId. localStorage knows what a code was;
    // only the server knows whether it turned into a real charge.
    var jobStatus = {};

    var STATUS_LABEL = {
      reserving: ['Creating…', 'pending'],
      reserved: ['Not printed yet', 'pending'],
      printed: ['Printed · charged', 'done'],
      expired: ['Expired · refunded', 'refunded'],
      cancelled: ['Cancelled · refunded', 'refunded'],
      failed: ['Failed · not charged', 'refunded'],
    };

    function statusChip(item) {
      var job = item.jobId ? jobStatus[item.jobId] : null;
      var status = job ? job.status : null;

      if (!status) {
        // No server view (anonymous, or offline). Fall back to the local clock.
        status = Date.now() > (item.validUntil || 0) ? 'expired' : 'reserved';
      }
      var pair = STATUS_LABEL[status] || [status, 'pending'];
      var extra = '';
      if (status === 'printed' && job && job.price != null) extra = ' ৳' + job.price;
      return '<span class="history-status history-status--' + pair[1] + '">' + esc(pair[0] + extra) + '</span>';
    }

    function renderList() {
      if (!listEl) return;
      var list = getHistory();
      updateHistoryBadge();

      if (!list.length) {
        listEl.innerHTML =
          '<div class="history-empty-state">' +
          '<div class="empty-history-icon">' +
          '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line><line x1="7" y1="15" x2="7.01" y2="15"></line><line x1="11" y1="15" x2="13" y2="15"></line>' +
          '</svg>' +
          '</div>' +
          '<p>No recent OTPs generated yet. Generate one now and it will be stored here for quick kiosk access.</p>' +
          '</div>';
        return;
      }

      listEl.innerHTML = list
        .map(function (item) {
          var dt = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          var job = item.jobId ? jobStatus[item.jobId] : null;
          var live = job ? job.status === 'reserved' : Date.now() < (item.validUntil || 0);
          return (
            '<div class="history-card">' +
            '<div class="history-card-header">' +
            '<span class="history-otp-badge">' + esc(item.otp) + '</span>' +
            (live
              ? '<button type="button" class="chip-btn" onclick="window.copyOtpFromHistory(\'' + esc(item.otp) + '\')">Copy</button>'
              : '') +
            '</div>' +
            '<div class="history-meta">' +
            '<span>' + esc(item.courseCode) + (item.roll ? ' · Roll: ' + esc(item.roll) : '') + '</span><br/>' +
            '<span>৳' + esc(item.cost) + ' · ' + esc(item.copies) + ' cp · ' + dt + '</span>' +
            '</div>' +
            statusChip(item) +
            '</div>'
          );
        })
        .join('');
    }

    /** Pull the authoritative status for the codes we have locally. */
    function syncStatus() {
      var a = global.LabDDB && global.LabDDB.auth;
      if (!a || !a.user) return Promise.resolve();
      return a
        .fetch('/api/jobs')
        .then(function (data) {
          (data.jobs || []).forEach(function (j) {
            jobStatus[j.id] = j;
          });
          renderList();
        })
        .catch(function () {
          /* keep the local view */
        });
    }

    global.updateHistoryUI = renderList;

    function openDrawer() {
      renderList();
      syncStatus();
      if (drawer) drawer.classList.add('show');
      if (backdrop) backdrop.classList.add('show');
    }

    function closeDrawer() {
      if (drawer) drawer.classList.remove('show');
      if (backdrop) backdrop.classList.remove('show');
    }

    if (historyBtn) historyBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);

    // Initial badge check
    updateHistoryBadge();
  }

  // ---- OTP Modal Controller ------------------------------------------------
  var overlay, body, closeBtn, countdownTimer = null;

  function ensureModal() {
    overlay = document.getElementById('otpModal');
    body = document.getElementById('otpBody');
    closeBtn = document.getElementById('otpClose');
    if (closeBtn) closeBtn.onclick = hide;
    if (overlay) {
      overlay.onclick = function (e) {
        if (e.target === overlay) hide();
      };
    }
    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('show')) hide();
    });
  }

  function show() {
    if (!overlay) ensureModal();
    if (overlay) overlay.classList.add('show');
  }

  function hide() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (overlay) overlay.classList.remove('show');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderLoading(stage) {
    show();
    if (body) {
      body.innerHTML =
        '<div class="modal-spinner-wrap">' +
        '<div class="spinner"></div>' +
        '<div class="modal-state-text">' +
        '<strong>' + esc(stage || 'Connecting to UprintBD Kiosk Bridge…') + '</strong><br/>' +
        'Your balance is only charged once a page actually prints.' +
        '</div>' +
        '</div>';
    }
  }

  function startCountdown(seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    var remaining = seconds;
    var timerEl = document.getElementById('otpCountdownVal');
    
    function tick() {
      if (!timerEl) return;
      var m = Math.floor(remaining / 60);
      var s = remaining % 60;
      timerEl.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        timerEl.textContent = 'Expired';
      }
      remaining--;
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function renderSuccess(data, meta) {
    show();
    var validSec = data.validForSeconds || 3600;

    // Save to local history
    saveToHistory({
      jobId: data.jobId,
      otp: data.otp,
      cost: data.cost,
      currency: data.currency || 'BDT',
      copies: (meta && meta.copies) || data.copies || 1,
      pages: data.pages || 1,
      color: !!(meta && meta.color),
      courseCode: meta && meta.courseCode,
      roll: meta && meta.roll,
      validForSeconds: validSec,
    });

    var pages = data.pages || 1;
    var copies = data.copies || 1;

    if (body) {
      body.innerHTML =
        '<div class="otp-display-box">' +
        '<div class="otp-box-label">Your Kiosk Print OTP</div>' +
        '<div class="otp-big-code" id="otpBigCode">' + esc(data.otp) + '</div>' +
        '<button type="button" class="otp-copy-btn" id="otpCopyBtn">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
        '<span id="otpCopyBtnText">Copy Code</span>' +
        '</button>' +
        '<div class="otp-timer-bar">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:4px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
        '<span>Valid for: </span>' +
        '<strong id="otpCountdownVal">--:--</strong>' +
        '</div>' +
        '</div>' +

        '<div class="otp-metrics-grid">' +
        '<div class="metric-item">' +
        '<span class="metric-label">On Hold</span>' +
        '<span class="metric-val">৳' + esc(data.cost) + '</span>' +
        '</div>' +
        '<div class="metric-item">' +
        '<span class="metric-label">Pages</span>' +
        '<span class="metric-val">' + esc(pages) + ' × ' + esc(copies) + (data.color ? ' clr' : ' b/w') + '</span>' +
        '</div>' +
        '<div class="metric-item">' +
        '<span class="metric-label">Location</span>' +
        '<span class="metric-val">Any CU Kiosk</span>' +
        '</div>' +
        '</div>' +

        '<div class="otp-steps-card">' +
        '<ol>' +
        '<li>Go to any <strong>Uprint kiosk</strong> (e.g. Dept. of EEE / CU Library).</li>' +
        '<li>Tap <strong>Print with OTP</strong> on the kiosk screen.</li>' +
        '<li>Enter code <strong style="color:var(--cu-navy); font-family:monospace;">' + esc(data.otp) + '</strong> to print immediately.</li>' +
        '</ol>' +
        '</div>' +

        (auth() && auth().user
          ? '<p class="wallet-hint" style="text-align:center;">৳' + esc(data.cost) +
            ' is held, not spent. It becomes a charge only when the kiosk prints — ' +
            'if you never use this code, the money returns to your balance by itself.</p>'
          : '');
    }

    startCountdown(validSec);

    var copyBtn = document.getElementById('otpCopyBtn');
    var copyText = document.getElementById('otpCopyBtnText');
    if (copyBtn) {
      copyBtn.onclick = function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(data.otp);
        }
        if (copyText) copyText.textContent = 'Copied ✓';
        showToast('OTP Code ' + data.otp + ' copied to clipboard!', '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>');
        setTimeout(function () {
          if (copyText) copyText.textContent = 'Copy Code';
        }, 1500);
      };
    }
  }

  /**
   * 402 or Low Balance — prompts user to recharge DDB balance with Admin WhatsApp & Call buttons.
   */
  function renderInsufficient(info) {
    show();
    info = info || {};
    var need = Number(info.required) || 3;
    var have = Number(info.available) || 0;
    var held = Number(info.reserved) || 0;
    var phone = '+8801516599675';
    var cleanPhone = '8801516599675';
    var waUrl = 'https://wa.me/' + cleanPhone + '?text=' + encodeURIComponent('Hi Admin, I want to recharge my LabDDB balance.');
    var callUrl = 'tel:' + phone;

    if (body) {
      body.innerHTML =
        '<div class="insufficient-panel">' +
        '<div class="recharge-header-badge">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>' +
        '<span>Recharge DDB Balance</span>' +
        '</div>' +

        '<div class="wallet-hero">' +
        '<div class="wallet-hero-amount">৳' + have + '</div>' +
        '<div class="wallet-hero-label">Your Current DDB Balance · Minimum ৳3 required</div>' +
        (held ? '<div class="wallet-hero-held">৳' + held + ' is held by unused codes</div>' : '') +
        '</div>' +

        '<div class="recharge-alert-box">' +
        '<div style="font-weight:700; color:#b91c1c; display:flex; align-items:center; gap:6px; margin-bottom:4px;">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' +
        '<span>Insufficient Balance to get OTP</span>' +
        '</div>' +
        '<div>Your DDB balance is less than ৳3. Please recharge your DDB balance manually with the admin to generate a kiosk print OTP.</div>' +
        '</div>' +

        '<div class="recharge-contact-group">' +
        '<div class="recharge-contact-title">Contact Admin for Manual Recharge:</div>' +

        '<div class="recharge-buttons-row">' +
        '<a href="' + waUrl + '" target="_blank" rel="noopener noreferrer" class="btn-recharge-action btn-whatsapp" id="btnWaAdmin">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.301-.15-1.78-.878-2.056-.978-.276-.1-.476-.15-.676.15-.2.3-.777.978-.952 1.178-.175.2-.351.226-.652.075-.301-.15-1.272-.469-2.423-1.496-.896-.799-1.501-1.786-1.677-2.087-.175-.301-.019-.464.132-.614.135-.135.301-.351.451-.527.15-.175.2-.3.301-.501.1-.2.05-.376-.025-.526-.075-.15-.676-1.63-927-2.232-.244-.585-.493-.506-.676-.515-.175-.01-.376-.01-.576-.01s-.526.075-.802.376c-.276.3-1.053 1.028-1.053 2.507s1.078 2.908 1.228 3.109c.15.2 2.122 3.24 5.141 4.544.718.31 1.279.496 1.716.635.722.23 1.378.197 1.897.12.578-.087 1.78-.727 2.03-1.43.25-.702.25-1.303.175-1.43-.075-.125-.276-.2-.576-.35zM12 2C6.477 2 2 6.477 2 12c0 1.891.524 3.66 1.434 5.176L2 22l4.981-1.39A9.957 9.957 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18.2a8.167 8.167 0 0 1-4.17-1.144l-.299-.178-3.093.863.876-3.008-.195-.313A8.163 8.163 0 0 1 3.8 12c0-4.522 3.678-8.2 8.2-8.2s8.2 3.678 8.2 8.2-3.678 8.2-8.2 8.2z"/></svg>' +
        '<span>WhatsApp Admin</span>' +
        '</a>' +

        '<a href="' + callUrl + '" class="btn-recharge-action btn-call" id="btnCallAdmin">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>' +
        '<span>Call Admin</span>' +
        '</a>' +
        '</div>' +

        '<div class="recharge-phone-box">' +
        '<span>Admin Number: <strong>+880 1516-599675</strong></span>' +
        '<button type="button" class="chip-btn" id="btnCopyAdminNum">Copy Number</button>' +
        '</div>' +
        '</div>' +

        '<ol class="insufficient-steps">' +
        '<li>Send bKash / Nagad to the Admin number (<strong>+8801516599675</strong>).</li>' +
        '<li>Share your TrxID & Student Roll with the Admin via WhatsApp or Call.</li>' +
        '<li>Your balance updates instantly — no need to reload.</li>' +
        '</ol>' +

        (held ? '<p class="wallet-hint">Have an unused code? Cancel it from your wallet and that ৳' + held + ' returns instantly.</p>' : '') +

        '<div class="wallet-actions" style="margin-top:16px;">' +
        '<button type="button" class="btn-small-action" id="insufWallet">Open my wallet</button>' +
        '<button type="button" class="btn-small-action" id="insufClose">Close</button>' +
        '</div>' +
        '</div>';
    }

    var copyBtn = document.getElementById('btnCopyAdminNum');
    if (copyBtn) {
      copyBtn.onclick = function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('+8801516599675');
        }
        copyBtn.textContent = 'Copied ✓';
        showToast('Admin number (+8801516599675) copied to clipboard!', '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>');
        setTimeout(function () {
          copyBtn.textContent = 'Copy Number';
        }, 1800);
      };
    }

    var w = document.getElementById('insufWallet');
    if (w) {
      w.onclick = function () {
        hide();
        var a = auth();
        if (a) a.openWallet();
      };
    }
    var c = document.getElementById('insufClose');
    if (c) c.onclick = hide;
  }

  function renderError(message, onRetry, retryLabel) {
    show();
    if (body) {
      body.innerHTML =
        '<div class="otp-error-box">' +
        '<div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; font-weight:600;">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
        '<span>Kiosk Link Error</span>' +
        '</div>' +
        esc(message) +
        '</div>' +
        '<div class="modal-state-text">Your balance was not charged.</div>' +
        (onRetry
          ? '<button type="button" class="otp-retry-btn" id="otpRetryBtn" style="margin-top:14px;">' +
            esc(retryLabel || 'Try Again') +
            '</button>'
          : '');
    }
    var r = document.getElementById('otpRetryBtn');
    if (r && onRetry) r.onclick = onRetry;
  }

  /**
   * The price of a job at the live rates. One implementation, so the calculator on
   * every page and the number the server charges can never disagree.
   */
  function quote(opts) {
    var p = pricing();
    var pages = Math.max(1, parseInt(opts.pages, 10) || 1);
    var copies = Math.max(1, parseInt(opts.copies, 10) || 1);
    var unit = opts.color ? p.color : p.mono;
    return {
      unitPrice: unit,
      pages: pages,
      copies: copies,
      total: pages * copies * unit,
      currency: p.currency || 'BDT',
    };
  }

  // Global helper for LabDDB tools switcher dropdown
  function initLabDDBToolsSwitcher() {
    var btn = document.getElementById('labddbSwitcherBtn');
    var switcher = document.getElementById('labddbSwitcher');
    if (!btn || !switcher) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = switcher.classList.toggle('open');
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      if (!switcher.contains(e.target)) {
        switcher.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Export module
  global.Uprint = {
    elementToPdfBase64: elementToPdfBase64,
    formatCoverFilename: formatCoverFilename,
    requestOtp: requestOtp,
    requestPrint: requestPrint,
    quote: quote,
    pricing: pricing,
    health: health,
    bindBridgeBadge: bindBridgeBadge,
    showToast: showToast,
    saveToHistory: saveToHistory,
    initHistoryDrawer: initHistoryDrawer,
    initLabDDBToolsSwitcher: initLabDDBToolsSwitcher,
  };

  global.OtpModal = {
    loading: renderLoading,
    success: renderSuccess,
    error: renderError,
    insufficient: renderInsufficient,
    show: show,
    hide: hide,
  };

  // Initialize history badge and tools switcher on DOMContentLoaded
  function initSharedChrome() {
    updateHistoryBadge();
    initLabDDBToolsSwitcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSharedChrome);
  } else {
    initSharedChrome();
  }
})(window);
