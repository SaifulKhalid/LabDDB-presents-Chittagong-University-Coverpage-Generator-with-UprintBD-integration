/* =============================================================================
   experiment-index.js — Chittagong University Experiment Index Page Generator
   100% Real-time synchronization with Firebase Realtime Database.
   ============================================================================= */
(function (global) {
  'use strict';

  // Firebase config lives in js/labddb-config.js — one file for every page.
  var firebaseConfig = (global.LabDDB && global.LabDDB.dataConfig) || null;

  // ---- Cached DOM Element Map -----------------------------------------------
  var el = {};
  var elementIds = [
    'appLayout', 'courseSelect', 'indexPage', 'indexRows', 'copies', 'colorMode',
    'editBtn', 'toolEditBtn', 'printBtn', 'pdfBtn', 'otpBtn', 'previewScale',
    'emptyHint', 'previewContainer', 'bridgeDot', 'bridgeText', 'themeToggleBtn',
    'historyBtn', 'historyCount', 'historyDrawer', 'historyDrawerBackdrop',
    'historyDrawerClose', 'historyList', 'tabEditor', 'tabPreview', 'mobileTabs',
    'decCopies', 'incCopies', 'colorModeToggle', 'costCalcText', 'costTotalTag',
    'zoomOutBtn', 'zoomInBtn', 'zoomLevelBtn', 'editIndicator', 'mobileReturnEditorBtn'
  ];

  elementIds.forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var db = null;
  var courses = {};
  var labList = [];
  var currentScale = 1.0;
  var editing = false;
  var currentCourse = null;

  // ---- Theme Engine ---------------------------------------------------------
  function initTheme() {
    var saved = localStorage.getItem('cu_app_theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved || (prefersDark ? 'dark' : 'light');
    setTheme(theme);

    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', function () {
        var curr = document.documentElement.getAttribute('data-theme') || 'light';
        var next = curr === 'dark' ? 'light' : 'dark';
        setTheme(next);
      });
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cu_app_theme', theme);
  }

  // ---- Mobile Tab Switching -------------------------------------------------
  function initMobileTabs() {
    var initialTab = (el.appLayout && el.appLayout.getAttribute('data-active-tab')) || 'editor';
    switchTab(initialTab);
    if (el.tabEditor) {
      el.tabEditor.addEventListener('click', function () {
        switchTab('editor');
      });
    }
    if (el.tabPreview) {
      el.tabPreview.addEventListener('click', function () {
        switchTab('preview');
      });
    }
    if (el.mobileReturnEditorBtn) {
      el.mobileReturnEditorBtn.addEventListener('click', function () {
        switchTab('editor');
      });
    }
  }

  function switchTab(tab) {
    if (el.appLayout) {
      el.appLayout.setAttribute('data-active-tab', tab);
    }
    if (el.tabEditor && el.tabPreview) {
      if (tab === 'editor') {
        el.tabEditor.classList.add('active');
        el.tabPreview.classList.remove('active');
      } else {
        el.tabEditor.classList.remove('active');
        el.tabPreview.classList.add('active');
        renderIndexTable();
        requestAnimationFrame(function () {
          fitPreview();
          setTimeout(fitPreview, 60);
          setTimeout(fitPreview, 250);
        });
      }
    }
  }

  // ---- Firebase Realtime Database Sync --------------------------------------
  function initFirebaseRealtime() {
    try {
      if (typeof firebase === 'undefined') {
        console.error('[Firebase] SDK not available');
        return;
      }
      if (!firebaseConfig) {
        console.error('[Firebase] js/labddb-config.js must load first');
        return;
      }
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      db = firebase.database();

      // Realtime listener
      db.ref('cvr3_courses').on('value', function (snapshot) {
        var val = snapshot.val();
        if (val) {
          ingestRealtimeCourses(val);
        } else {
          courses = {};
          labList = [];
          if (el.courseSelect) {
            el.courseSelect.innerHTML = '<option value="">No courses found in database</option>';
          }
        }
      }, function (err) {
        console.error('[Firebase] Realtime cvr3_courses listener error:', err);
      });

      // Realtime stats counter listener
      bindLiveCounter();

    } catch (e) {
      console.error('[Firebase] Initialization error:', e);
    }
  }

  function bindLiveCounter() {
    if (!db) return;
    var elBadge = document.getElementById('coverpageLiveCount');
    if (!elBadge) return;
    try {
      db.ref('cvr3_meta/stats/coverpageCount').on('value', function (snap) {
        var count = Number(snap.val()) || 0;
        if (count > 0) {
          elBadge.textContent = '⚡ ' + count.toLocaleString() + ' covers generated';
        } else {
          elBadge.textContent = '⚡ Live CU Synced';
        }
      }, function () {
        elBadge.textContent = '⚡ Live CU Synced';
      });
    } catch (_) {
      elBadge.textContent = '⚡ Live CU Synced';
    }
  }

  function incCoverCounter() {
    if (!db) return;
    try {
      db.ref('cvr3_meta/stats/coverpageCount').transaction(function (c) {
        return (Number(c) || 0) + 1;
      }).catch(function () {});
    } catch (_) {}
  }

  function ingestRealtimeCourses(val) {
    try {
      localStorage.setItem('cvr3_courses_cache', JSON.stringify(val));
    } catch (_) {}

    var prevSelectedCode = el.courseSelect ? el.courseSelect.value : null;
    courses = {};
    labList = [];

    Object.keys(val).forEach(function (code) {
      var o = val[code];
      if (!o) return;

      var exps = Array.isArray(o.experiments) ? o.experiments : [];

      courses[code] = {
        _key: code,
        courseCode: o.courseCode || code,
        courseTitle: o.courseTitle || '',
        department: o.department || 'Electrical and Electronic Engineering',
        courseType: o.courseType || (exps.length ? 'lab' : 'theory'),
        experiments: exps,
      };

      if ((o.courseType || 'lab') === 'lab' || exps.length > 0) {
        labList.push(code);
      }
    });

    labList.sort();
    populateCourseDropdown(prevSelectedCode);
  }

  function populateCourseDropdown(preferCode) {
    if (!el.courseSelect) return;
    el.courseSelect.disabled = false;
    el.courseSelect.innerHTML = '';

    if (!labList.length) {
      el.courseSelect.innerHTML = '<option value="">No lab courses available</option>';
      return;
    }

    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select Lab Course (' + labList.length + ' available)…';
    el.courseSelect.appendChild(defaultOpt);

    labList.forEach(function (code) {
      var c = courses[code];
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = c.courseCode + ' — ' + (c.courseTitle || 'Untitled Course');
      el.courseSelect.appendChild(opt);
    });

    var selectTarget = (preferCode && courses[preferCode]) ? preferCode : labList[0];
    if (selectTarget) {
      el.courseSelect.value = selectTarget;
      selectCourse(selectTarget);
    }
  }

  function selectCourse(code) {
    var c = courses[code];
    if (!c) return;
    currentCourse = c;
    renderIndexTable(c);
  }

  function renderIndexTable(c) {
    if (!el.indexRows) return;
    var exps = (c && c.experiments) ? c.experiments : [];

    if (!exps.length) {
      el.indexRows.innerHTML =
        '<tr><td class="col-no">1</td><td class="col-name">---</td><td class="col-page"></td></tr>';
      fitPreview();
      return;
    }

    var html = '';
    exps.forEach(function (exp, idx) {
      var num = exp.num || (idx + 1);
      var title = exp.title || exp.expTitle || 'Experiment ' + num;
      html +=
        '<tr>' +
        '<td class="col-no">' + esc(num) + '</td>' +
        '<td class="col-name">' + esc(title) + '</td>' +
        '<td class="col-page" contenteditable="true" title="Click to enter page number"></td>' +
        '</tr>';
    });

    el.indexRows.innerHTML = html;
    fitPreview();
  }

  function esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---- Zoom, Layout Engine & Mobile Touch Gestures -------------------------
  function fitPreview() {
    var cont = el.previewContainer;
    var sc = el.previewScale;
    var cov = el.indexPage;
    if (!cont || !sc || !cov) return;

    var paddingX = window.innerWidth < 640 ? 16 : 40;
    var paddingY = window.innerWidth < 640 ? 20 : 40;
    var aw = cont.clientWidth - paddingX;
    var ah = cont.clientHeight - paddingY;
    if (aw <= 0 || ah <= 0) return;

    var cw = 794;
    var ch = 1123;
    var scale = Math.min(aw / cw, ah / ch, 1.05);
    currentScale = Math.max(0.2, Math.min(scale, 2.0));
    applyScale(currentScale);
  }

  function applyScale(scale) {
    if (!el.previewScale) return;
    if (typeof scale === 'number') currentScale = scale;
    var sc = el.previewScale;
    var cw = 794;
    var ch = 1123;
    sc.style.width = cw + 'px';
    sc.style.minWidth = cw + 'px';
    sc.style.height = ch + 'px';
    sc.style.transformOrigin = 'top center';
    sc.style.transform = 'scale(' + currentScale + ')';

    var mb = Math.round(ch * (currentScale - 1));
    var mx = Math.round(cw * (currentScale - 1) / 2);
    sc.style.marginBottom = mb + 'px';
    sc.style.marginLeft = mx + 'px';
    sc.style.marginRight = mx + 'px';

    if (el.zoomLevelBtn) {
      el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
    }
  }

  function initTouchGestures() {
    var cont = el.previewContainer;
    if (!cont) return;

    var initialDist = 0;
    var initialScale = currentScale;
    var lastTap = 0;

    cont.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        initialDist = Math.sqrt(dx * dx + dy * dy);
        initialScale = currentScale;
      } else if (e.touches.length === 1) {
        var now = Date.now();
        if (now - lastTap < 300) {
          if (currentScale < 0.85) {
            currentScale = 1.0;
          } else {
            fitPreview();
            return;
          }
          applyScale(currentScale);
        }
        lastTap = now;
      }
    }, { passive: true });

    cont.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && initialDist > 0) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var factor = dist / initialDist;
        currentScale = Math.max(0.25, Math.min(initialScale * factor, 2.2));
        applyScale(currentScale);
      }
    }, { passive: true });

    cont.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) initialDist = 0;
    }, { passive: true });
  }

  // ---- Inline Content Editing -----------------------------------------------
  function toggleInlineEdit() {
    editing = !editing;
    if (el.indexPage) {
      if (editing) {
        el.indexPage.classList.add('editing');
        el.indexPage.querySelectorAll('td, th, .index-title').forEach(function (node) {
          node.setAttribute('contenteditable', 'true');
        });
      } else {
        el.indexPage.classList.remove('editing');
        // Keep page cells editable for fast entry
        el.indexPage.querySelectorAll('td:not(.col-page), th, .index-title').forEach(function (node) {
          node.removeAttribute('contenteditable');
        });
      }
    }

    if (el.editIndicator) {
      el.editIndicator.style.display = editing ? 'inline-flex' : 'none';
    }
    if (el.editBtn) {
      el.editBtn.classList.toggle('active', editing);
      el.editBtn.innerHTML = editing
        ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg><span>Save</span>'
        : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg><span>Edit</span>';
    }
    if (el.toolEditBtn) {
      el.toolEditBtn.classList.toggle('active', editing);
    }
    var floatEdit = document.getElementById('floatEditBtn');
    if (floatEdit) {
      floatEdit.classList.toggle('active', editing);
    }
  }

  // ---- Cost Calculation & Copies --------------------------------------------
  // Rates come from the server (/api/config) via Uprint.quote, so the admin can
  // change prices without a redeploy and the quote here always matches the charge.
  function updateCost() {
    if (!global.Uprint || !global.Uprint.quote) return;
    var mode = el.colorMode ? el.colorMode.value : 'mono';
    var q = Uprint.quote({
      pages: 1,
      copies: el.copies ? el.copies.value : 1,
      color: mode === 'color',
    });

    if (el.costCalcText) {
      el.costCalcText.textContent =
        q.pages + ' page × ' + q.copies + ' copy (' +
        (mode === 'color' ? 'Colour' : 'B&W') + ' @ ' + q.unitPrice + '৳)';
    }
    if (el.costTotalTag) {
      el.costTotalTag.textContent = 'Total: ' + q.total + ' ' + q.currency;
    }
  }

  global.onPricingLoaded = function () {
    updateCost();
  };

  // ---- PDF & Print Handlers ------------------------------------------------
  function getIndexFilename() {
    var dept = currentCourse ? currentCourse.department : 'EEE';
    var code = (currentCourse && currentCourse.courseCode) ? currentCourse.courseCode : '417';
    if (global.Uprint && global.Uprint.formatCoverFilename) {
      return global.Uprint.formatCoverFilename(dept, code, 'Index', 'IndexPage');
    }
    return 'LabDDB_EEE_417_Index_IndexPage.pdf';
  }

  function handlePdf() {
    if (editing) toggleInlineEdit();
    var filename = getIndexFilename();

    if (el.pdfBtn) {
      el.pdfBtn.disabled = true;
      el.pdfBtn.textContent = 'Generating PDF…';
    }

    Uprint.elementToPdfBase64(el.indexPage).then(function (b64) {
      var byteCharacters = atob(b64);
      var byteNumbers = new Array(byteCharacters.length);
      for (var i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      var byteArray = new Uint8Array(byteNumbers);
      var blob = new Blob([byteArray], { type: 'application/pdf' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      incCoverCounter();
      if (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.logActivity) {
        global.LabDDB.auth.logActivity('PDF_DOWNLOADED', { type: 'cover', id: (currentCourse && currentCourse.courseCode) || 'CU' }, {
          filename: filename,
          courseCode: (currentCourse && currentCourse.courseCode) || '',
          tool: 'experiment-index',
        });
      }

      if (el.pdfBtn) {
        el.pdfBtn.disabled = false;
        el.pdfBtn.innerHTML =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>PDF</span>';
      }
    }).catch(function (err) {
      console.error(err);
      if (global.Uprint && global.Uprint.showToast) {
        global.Uprint.showToast('PDF error: ' + err.message, '⚠️');
      }
      if (el.pdfBtn) {
        el.pdfBtn.disabled = false;
        el.pdfBtn.textContent = 'PDF';
      }
    });
  }

  function handlePrint() {
    if (editing) toggleInlineEdit();
    incCoverCounter();
    if (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.logActivity) {
      global.LabDDB.auth.logActivity('DIRECT_PRINT_INITIATED', { type: 'cover', id: (currentCourse && currentCourse.courseCode) || 'CU' }, {
        courseCode: (currentCourse && currentCourse.courseCode) || '',
        tool: 'experiment-index',
      });
    }
    window.print();
  }

  function handleOtp() {
    if (editing) toggleInlineEdit();

    var code = (currentCourse && currentCourse.courseCode) ? currentCourse.courseCode : 'Lab';
    var filename = getIndexFilename();

    if (el.otpBtn) el.otpBtn.disabled = true;
    var floatOtp = document.getElementById('floatOtpBtn');
    if (floatOtp) floatOtp.disabled = true;

    Uprint.requestPrint({
      element: el.indexPage,
      filename: filename,
      copies: parseInt(el.copies ? el.copies.value : '1', 10) || 1,
      color: (el.colorMode ? el.colorMode.value : 'mono') === 'color',
      tool: 'experiment-index',
      title: 'Lab Report Index Table',
      courseCode: code,
      roll: '',
      reason: 'Kiosk codes cost money, so they are tied to your DDB balance.',
      validate: function () {
        if (!currentCourse) return 'Pick a course first.';
        return null;
      },
    }).then(function (res) {
      if (el.otpBtn) el.otpBtn.disabled = false;
      if (floatOtp) floatOtp.disabled = false;
      if (res && res.otp) incCoverCounter();
    }).catch(function (err) {
      if (el.otpBtn) el.otpBtn.disabled = false;
      if (floatOtp) floatOtp.disabled = false;
      console.warn('[experiment-index] OTP request finished with error:', err && err.message);
    });
  }

  // ---- Event Bindings & Init ------------------------------------------------
  function initEvents() {
    if (el.courseSelect) {
      el.courseSelect.addEventListener('change', function () {
        selectCourse(this.value);
      });
    }

    // Copies Stepper
    if (el.incCopies && el.copies) {
      el.incCopies.addEventListener('click', function () {
        var v = parseInt(el.copies.value, 10) || 1;
        if (v < 20) {
          el.copies.value = v + 1;
          updateCost();
        }
      });
    }
    if (el.decCopies && el.copies) {
      el.decCopies.addEventListener('click', function () {
        var v = parseInt(el.copies.value, 10) || 1;
        if (v > 1) {
          el.copies.value = v - 1;
          updateCost();
        }
      });
    }

    // Color Toggle
    if (el.colorModeToggle) {
      el.colorModeToggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.seg-btn');
        if (!btn) return;
        el.colorModeToggle.querySelectorAll('.seg-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        if (el.colorMode) el.colorMode.value = btn.getAttribute('data-value');
        updateCost();
      });
    }

    // Direct PDF Button
    if (el.pdfBtn) el.pdfBtn.addEventListener('click', handlePdf);

    // Direct Print Button
    if (el.printBtn) el.printBtn.addEventListener('click', handlePrint);

    // Inline Edit
    if (el.editBtn) el.editBtn.addEventListener('click', toggleInlineEdit);
    if (el.toolEditBtn) el.toolEditBtn.addEventListener('click', toggleInlineEdit);

    // ⚡ UprintBD Kiosk OTP Button
    if (el.otpBtn) el.otpBtn.addEventListener('click', handleOtp);

    // Floating Mobile Preview Action Dock
    var floatOtp = document.getElementById('floatOtpBtn');
    var floatPdf = document.getElementById('floatPdfBtn');
    var floatPrint = document.getElementById('floatPrintBtn');
    var floatEdit = document.getElementById('floatEditBtn');
    if (floatOtp) floatOtp.addEventListener('click', handleOtp);
    if (floatPdf) floatPdf.addEventListener('click', handlePdf);
    if (floatPrint) floatPrint.addEventListener('click', handlePrint);
    if (floatEdit) floatEdit.addEventListener('click', toggleInlineEdit);

    // Zoom Controls
    if (el.zoomInBtn) {
      el.zoomInBtn.addEventListener('click', function () {
        currentScale = Math.min(currentScale + 0.1, 2.0);
        applyScale(currentScale);
      });
    }
    if (el.zoomOutBtn) {
      el.zoomOutBtn.addEventListener('click', function () {
        currentScale = Math.max(currentScale - 0.1, 0.25);
        applyScale(currentScale);
      });
    }
    if (el.zoomLevelBtn) {
      el.zoomLevelBtn.addEventListener('click', fitPreview);
    }

    // Touch gestures (Pinch & Double-tap)
    initTouchGestures();

    // History Drawer
    if (global.Uprint && global.Uprint.initHistoryDrawer) {
      global.Uprint.initHistoryDrawer();
    }

    window.addEventListener('resize', fitPreview);
    window.addEventListener('orientationchange', function () {
      setTimeout(fitPreview, 150);
    });
  }

  // ---- Bootstrap App --------------------------------------------------------
  function init() {
    initTheme();
    initMobileTabs();
    initEvents();

    // Instant cache hydration
    var cachedCourses = localStorage.getItem('cvr3_courses_cache');
    if (cachedCourses) {
      try {
        ingestRealtimeCourses(JSON.parse(cachedCourses));
      } catch (_) {}
    }

    initFirebaseRealtime();
    updateCost();
    if (global.Uprint && global.Uprint.bindBridgeBadge) {
      global.Uprint.bindBridgeBadge(el.bridgeDot, el.bridgeText, 60000);
    }
    setTimeout(fitPreview, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
