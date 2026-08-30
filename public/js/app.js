/* =============================================================================
   app.js — Chittagong University Assignment Cover Page Generator
   100% Real-time synchronization with Firebase Realtime Database.
   Directly listens to `cvr3_courses` and `students/<roll>`.
   ============================================================================= */
(function (global) {
  'use strict';

  // Firebase config lives in js/labddb-config.js — one file for every page.
  var firebaseConfig = (global.LabDDB && global.LabDDB.dataConfig) || null;

  // ---- Cached DOM Element Map -----------------------------------------------
  var el = {};
  var elementIds = [
    'appLayout', 'courseSelect', 'assignmentSelect', 'rollNumber',
    'studentName', 'submissionDate', 'copies', 'colorMode', 'generateBtn', 'editBtn',
    'toolEditBtn', 'printBtn', 'pdfBtn', 'otpBtn', 'lookupBadge', 'studentCardPill',
    'studentAvatar', 'studentNameVal', 'studentSubVal', 'coverPage', 'previewScale',
    'emptyHint', 'previewContainer', 'bridgeDot', 'bridgeText', 'themeToggleBtn',
    'historyBtn', 'historyCount', 'historyDrawer', 'historyDrawerBackdrop',
    'historyDrawerClose', 'historyList', 'tabEditor', 'tabPreview', 'mobileTabs',
    'decCopies', 'incCopies', 'colorModeToggle', 'costCalcText', 'costTotalTag',
    'chipToday', 'chipTomorrow', 'zoomOutBtn', 'zoomInBtn', 'zoomLevelBtn',
    'editIndicator', 'mobileReturnEditorBtn'
  ];

  elementIds.forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var db = null;
  var courses = {};
  var theoryList = [];
  var studentCache = {};
  var currentScale = 1.0;
  var editing = false;
  var userTypedCustomDate = false;

  var current = {
    course: null,
    assignment: null,
    student: null,
    generated: true,
  };

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
        setTimeout(fitPreview, 80);
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
        console.error('[Firebase] js/labddb-config.js must load before app.js');
        return;
      }
      // labddb-auth.js may have initialised the default app already; either way
      // the default app is always lddb-demo, so firebase.database() is the
      // course catalogue exactly as before.
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      db = firebase.database();

      // Realtime listener: triggers whenever courses change in Firebase JSON
      db.ref('cvr3_courses').on('value', function (snapshot) {
        var val = snapshot.val();
        if (val) {
          ingestRealtimeCourses(val);
        } else {
          courses = {};
          theoryList = [];
          if (el.courseSelect) {
            el.courseSelect.innerHTML = '<option value="">No courses found in database</option>';
          }
        }
      }, function (err) {
        console.error('[Firebase] Realtime cvr3_courses listener error:', err);
      });

    } catch (e) {
      console.error('[Firebase] Initialization error:', e);
    }
  }

  function ingestRealtimeCourses(val) {
    var prevSelectedCode = el.courseSelect ? el.courseSelect.value : null;
    courses = {};
    theoryList = [];

    Object.keys(val).forEach(function (code) {
      var o = val[code];
      if (!o) return;

      // Normalize faculty / teacher object or array
      var faculty = [];
      if (Array.isArray(o.facultyMembers) && o.facultyMembers.length) {
        faculty = o.facultyMembers;
      } else if (o.teacher && (o.teacher.name || o.teacher.designation)) {
        faculty = [o.teacher];
      }

      courses[code] = {
        _key: code,
        courseCode: o.courseCode || code,
        courseTitle: o.courseTitle || '',
        department: o.department || 'Electrical and Electronic Engineering',
        courseType: o.courseType || (o.experiments ? 'lab' : 'theory'),
        facultyMembers: faculty,
        semesterText: o.semesterText || '',
        assignments: o.assignments || {},
        updatedAt: o.updatedAt || null,
      };

      // Populate theory courses or courses containing assignments
      if (o.courseType === 'theory' || o.assignments) {
        theoryList.push(code);
      }
    });

    theoryList.sort();
    populateCourseDropdown(prevSelectedCode);
  }

  function populateCourseDropdown(desiredCode) {
    if (!el.courseSelect) return;
    el.courseSelect.disabled = false;
    el.courseSelect.innerHTML = '<option value="">Select Course…</option>';

    theoryList.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c + ' — ' + (courses[c].courseTitle || 'Untitled');
      el.courseSelect.appendChild(opt);
    });

    // Select previously selected code if still available, else default to first
    var targetCode = null;
    if (desiredCode && courses[desiredCode]) {
      targetCode = desiredCode;
    } else if (theoryList.length > 0) {
      targetCode = theoryList[0];
    }

    if (targetCode) {
      el.courseSelect.value = targetCode;
      onCourseSelected(targetCode);
    } else {
      current.course = null;
      current.assignment = null;
      if (el.assignmentSelect) {
        el.assignmentSelect.innerHTML = '<option value="">Select a course first…</option>';
        el.assignmentSelect.disabled = true;
      }
      updatePreview();
    }
  }

  function onCourseSelected(code) {
    var c = courses[code];
    current.course = c || null;
    current.assignment = null;

    if (c) {
      var as = c.assignments || {};
      populateAssignmentDropdown(as);
    } else {
      if (el.assignmentSelect) {
        el.assignmentSelect.innerHTML = '<option value="">Select a course above first…</option>';
        el.assignmentSelect.disabled = true;
      }
    }
    updatePreview();
    fitPreview();
  }

  function populateAssignmentDropdown(as) {
    if (!el.assignmentSelect) return;
    el.assignmentSelect.disabled = false;
    el.assignmentSelect.innerHTML = '<option value="">Select Assignment…</option>';

    var keys = Object.keys(as || {});
    if (!keys.length) {
      el.assignmentSelect.innerHTML = '<option value="">No assignments assigned in database</option>';
      current.assignment = null;
      return;
    }

    keys.sort(function (a, b) {
      return String(as[a].assignmentNumber || a).localeCompare(
        String(as[b].assignmentNumber || b),
        undefined,
        { numeric: true }
      );
    });

    keys.forEach(function (k) {
      var a = as[k];
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = 'Assignment ' + (a.assignmentNumber || k) + ' — ' + (a.assignmentTitle || 'Untitled');
      el.assignmentSelect.appendChild(opt);
    });

    // Select the first assignment by default
    var firstKey = keys[0];
    el.assignmentSelect.value = firstKey;
    var aObj = as[firstKey];
    aObj._id = firstKey;
    current.assignment = aObj;

    // If assignment has submissionDate in Firebase and user hasn't typed a custom date, auto-fill it
    if (aObj.submissionDate && !userTypedCustomDate && el.submissionDate) {
      el.submissionDate.value = aObj.submissionDate;
    }
  }

  // ---- Student Lookup from Firebase Realtime Database ------------------------
  function deriveSession(id) {
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

  function lookupStudent(id) {
    if (!id) return Promise.resolve(null);
    if (studentCache[id]) return Promise.resolve(studentCache[id]);
    if (!db) return Promise.resolve(null);

    return db
      .ref('students/' + id)
      .once('value')
      .then(function (s) {
        var st = s.val();
        if (st) {
          st.studentId = st.studentId || id;
          if (!st.session) st.session = deriveSession(id);
          studentCache[id] = st;
          return st;
        }
        return null;
      })
      .catch(function () {
        return null;
      });
  }

  function showStudentCard(st) {
    if (!el.studentCardPill) return;
    if (!st) {
      el.studentCardPill.style.display = 'none';
      return;
    }
    el.studentCardPill.style.display = 'flex';
    var initial = (st.fullName || st.studentId || 'S').charAt(0).toUpperCase();
    if (el.studentAvatar) el.studentAvatar.textContent = initial;
    if (el.studentNameVal) el.studentNameVal.textContent = st.fullName || 'Student';
    if (el.studentSubVal) {
      el.studentSubVal.textContent =
        'ID: ' + (st.studentId || '—') + ' · Session: ' + (st.session || deriveSession(st.studentId) || '—');
    }
  }

  function setLookupStatus(msg, statusClass) {
    if (!el.lookupBadge) return;
    el.lookupBadge.textContent = msg;
    el.lookupBadge.className = 'helper-badge' + (statusClass ? ' ' + statusClass : '');
  }

  // ---- Preview Rendering & Data-Field Hooks ---------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setField(name, html) {
    if (!el.coverPage) return;
    var target = el.coverPage.querySelector('[data-field="' + name + '"]');
    if (target) target.innerHTML = html;
  }

  function fmtDate(d) {
    if (!d) return '';
    var p = d.split('-');
    if (p.length !== 3) return d;
    var months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    var m = +p[1] - 1;
    if (m < 0 || m > 11) return d;
    return months[m] + ' ' + +p[2] + ', ' + p[0];
  }

  function renderFaculty(members, dept) {
    if (!el.coverPage) return;
    var fc = el.coverPage.querySelector('[data-field="faculty"]');
    if (!fc) return;
    var deptName = dept || 'Electrical and Electronic Engineering';
    if (!members || !members.length) {
      fc.innerHTML =
        '<div class="faculty-block"><strong>—</strong><br/>Faculty Member<br/>Dept. of ' +
        esc(deptName) +
        '<br/>University of Chittagong</div>';
      return;
    }
    fc.innerHTML = members
      .map(function (f) {
        return (
          '<div class="faculty-block">' +
          '<strong>' + esc(f.name || '—') + '</strong><br/>' +
          esc(f.designation || f.title || 'Faculty Member') + '<br/>' +
          'Dept. of ' + esc(f.department || deptName) + '<br/>' +
          'University of Chittagong' +
          '</div>'
        );
      })
      .join('');
  }

  function updatePreview() {
    var c = current.course;
    var a = current.assignment;
    var s = current.student;

    setField('cover-type', 'Assignment');

    if (c) {
      setField('course-code', '<strong>' + esc(c.courseCode) + '</strong>');
      setField('course-title', esc(c.courseTitle || ''));
      setField(
        'department',
        'Department of <strong>' + esc(c.department || 'Electrical and Electronic Engineering') + '</strong>'
      );
      renderFaculty(c.facultyMembers || [], c.department);
    } else {
      setField('course-code', '<strong>---</strong>');
      setField('course-title', '---');
      renderFaculty([], 'Electrical and Electronic Engineering');
    }

    if (a) {
      setField('assignment-no', esc(a.assignmentNumber || '01'));
      setField('assignment-name', esc(a.assignmentTitle || '---'));
    } else {
      setField('assignment-no', '---');
      setField('assignment-name', '---');
    }

    if (s) {
      var sess = s.session || deriveSession(s.studentId) || '';
      var sem = c && c.semesterText ? c.semesterText : '';
      var dept = c && c.department ? c.department : s.department || 'Electrical and Electronic Engineering';
      setField(
        'student',
        'Name: <strong>' + esc(s.fullName || '') + '</strong><br/>' +
        'ID: <strong>' + esc(s.studentId || '') + '</strong><br/>' +
        (sess ? 'Session: ' + esc(sess) + '<br/>' : '') +
        (sem ? esc(sem) + '<br/>' : '') +
        'Dept. of ' + esc(dept) + '<br/>' +
        'University of Chittagong'
      );
    } else {
      setField('student', 'Name: <strong>---</strong><br/>ID: <strong>---</strong><br/>Dept. of EEE<br/>University of Chittagong');
    }

    var dateVal = el.submissionDate && el.submissionDate.value
      ? fmtDate(el.submissionDate.value)
      : a && a.submissionDate
      ? fmtDate(a.submissionDate)
      : '';
    setField('submission-date', dateVal);
  }

  // ---- Canvas Scaling, Zoom & Touch Gestures ------------------------------
  function fitPreview() {
    var cont = el.previewContainer;
    var sc = el.previewScale;
    var cov = el.coverPage;
    if (!cont || !sc || !cov) return;

    sc.style.transform = 'none';
    var cw = cov.scrollWidth || 794;
    var ch = cov.scrollHeight || 1123;
    var aw = cont.clientWidth - (window.innerWidth < 640 ? 16 : 40);
    var ah = cont.clientHeight - (window.innerWidth < 640 ? 20 : 40);
    if (aw <= 0 || ah <= 0) return;

    var scale = Math.min(aw / cw, ah / ch, 1.05);
    currentScale = Math.max(0.25, Math.min(scale, 1.5));
    applyScale();
    if (el.zoomLevelBtn) el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
  }

  function applyScale() {
    if (!el.previewScale || !el.coverPage) return;
    var cw = el.coverPage.scrollWidth || 794;
    var ch = el.coverPage.scrollHeight || 1123;
    el.previewScale.style.transform = 'scale(' + currentScale + ')';
    el.previewScale.style.width = Math.round(cw * currentScale) + 'px';
    el.previewScale.style.height = Math.round(ch * currentScale) + 'px';
  }

  function zoomIn() {
    currentScale = Math.min(currentScale + 0.1, 2.0);
    applyScale();
    if (el.zoomLevelBtn) el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
  }

  function zoomOut() {
    currentScale = Math.max(currentScale - 0.1, 0.25);
    applyScale();
    if (el.zoomLevelBtn) el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
  }

  function zoomReset() {
    fitPreview();
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
          // Double-tap: toggle between Fit and 100% detail view
          if (currentScale < 0.85) {
            currentScale = 1.0;
          } else {
            fitPreview();
            return;
          }
          applyScale();
          if (el.zoomLevelBtn) el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
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
        applyScale();
        if (el.zoomLevelBtn) el.zoomLevelBtn.textContent = Math.round(currentScale * 100) + '%';
      }
    }, { passive: true });

    cont.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) {
        initialDist = 0;
      }
    }, { passive: true });
  }

  // ---- Direct In-Preview Inline Editing -------------------------------------
  var EDIT_SEL =
    'td, .cover-department, .cover-university, .cover-title, .faculty-block, .student-info';

  function toggleEdit() {
    if (editing) {
      el.coverPage.querySelectorAll('[contenteditable]').forEach(function (n) {
        n.removeAttribute('contenteditable');
      });
      el.coverPage.classList.remove('editing');
      if (el.editBtn) el.editBtn.classList.remove('active');
      if (el.toolEditBtn) el.toolEditBtn.classList.remove('active');
      var floatEdit = document.getElementById('floatEditBtn');
      if (floatEdit) floatEdit.classList.remove('active');
      if (el.editIndicator) el.editIndicator.style.display = 'none';
      editing = false;
      if (global.Uprint && global.Uprint.showToast) {
        global.Uprint.showToast('Changes saved to preview!', '💾');
      }
    } else {
      el.coverPage.querySelectorAll(EDIT_SEL).forEach(function (n) {
        if (n.tagName === 'TD' && n.querySelector('img')) return;
        n.setAttribute('contenteditable', 'true');
      });
      el.coverPage.classList.add('editing');
      if (el.editBtn) el.editBtn.classList.add('active');
      if (el.toolEditBtn) el.toolEditBtn.classList.add('active');
      var floatEdit = document.getElementById('floatEditBtn');
      if (floatEdit) floatEdit.classList.add('active');
      if (el.editIndicator) el.editIndicator.style.display = 'inline-flex';
      editing = true;
      if (global.Uprint && global.Uprint.showToast) {
        global.Uprint.showToast('Inline edit active. Tap text to edit.', '✏️');
      }
    }
  }

  // ---- Dynamic Print Cost Calculator ----------------------------------------
  // Prices come from the server (/api/config), never from a constant here: the
  // admin can change them, and a stale number in the UI would be a quote we then
  // fail to honour. Page count is 1 for a cover page — the server re-counts the
  // real PDF and prices that, so this is a preview of the same arithmetic.
  function updateCostCalculator() {
    if (!global.Uprint || !global.Uprint.quote) return;
    var isColor = el.colorMode ? el.colorMode.value === 'color' : false;
    var q = Uprint.quote({
      pages: 1,
      copies: el.copies ? el.copies.value : 1,
      color: isColor,
    });

    if (el.costCalcText) {
      el.costCalcText.textContent =
        q.pages + ' page × ' + q.copies + ' copy' + (q.copies > 1 ? 'ies' : '') +
        ' (' + (isColor ? 'Colour' : 'B&W') + ' @ ' + q.unitPrice + '৳)';
    }
    if (el.costTotalTag) {
      el.costTotalTag.textContent = 'Total: ' + q.total + ' ' + q.currency;
    }
  }

  // Re-quote when the live prices arrive after first paint.
  global.onPricingLoaded = function () {
    updateCostCalculator();
  };

  // ---- Recent OTPs History Drawer ------------------------------------------
  function renderHistoryList() {
    if (global.updateHistoryUI) global.updateHistoryUI();
  }

  function toggleHistoryDrawer(open) {
    if (!el.historyDrawer || !el.historyDrawerBackdrop) return;
    if (open) {
      renderHistoryList();
      el.historyDrawer.classList.add('show');
      el.historyDrawerBackdrop.classList.add('show');
    } else {
      el.historyDrawer.classList.remove('show');
      el.historyDrawerBackdrop.classList.remove('show');
    }
  }

  // ---- PDF Filename Generator ----------------------------------------------
  // Generates LabDDB_[Dept]_[course code]_[exp/assignment no]_Roll.pdf
  // Example: LabDDB_EEE_417_03_24702008.pdf
  function pdfFilename() {
    var dept = current.course ? current.course.department : 'EEE';
    var code = current.course ? current.course.courseCode : '417';
    var assignNo = (current.assignment && current.assignment.assignmentNumber) || (el.assignmentSelect ? el.assignmentSelect.value : '') || '01';
    var roll = (el.rollNumber && el.rollNumber.value.trim()) || 'Roll';
    if (global.Uprint && global.Uprint.formatCoverFilename) {
      return global.Uprint.formatCoverFilename(dept, code, assignNo, roll);
    }
    return 'LabDDB_EEE_417_01_' + roll + '.pdf';
  }

  // ---- PDF Download Handler ------------------------------------------------
  function handlePdf() {
    if (editing) toggleEdit();
    if (!window.jspdf || !window.html2canvas) {
      if (global.Uprint && global.Uprint.showToast) {
        global.Uprint.showToast('PDF generation libraries not loaded.', '⚠️');
      }
      return;
    }
    el.pdfBtn.disabled = true;
    if (global.Uprint && global.Uprint.showToast) {
      global.Uprint.showToast('Rendering high-res A4 PDF…', '⏳');
    }

    Uprint.elementToPdfBase64(el.coverPage)
      .then(function (b64) {
        var link = document.createElement('a');
        link.href = 'data:application/pdf;base64,' + b64;
        link.download = pdfFilename();
        link.click();
        el.pdfBtn.disabled = false;
        if (global.Uprint && global.Uprint.showToast) {
          global.Uprint.showToast('PDF downloaded successfully!', '📄');
        }
      })
      .catch(function (err) {
        console.error(err);
        if (global.Uprint && global.Uprint.showToast) {
          global.Uprint.showToast('PDF generation failed. Please retry.', '⚠️');
        }
        el.pdfBtn.disabled = false;
      });
  }

  // ---- Direct Browser Print Handler ----------------------------------------
  function handleDirectPrint() {
    if (editing) toggleEdit();
    window.print();
  }

  // ---- Get Kiosk OTP Handler ------------------------------------------------
  // The whole flow (sign-in gate, PDF render, hold, modal, 402 handling) lives in
  // Uprint.requestPrint. This function only describes *what* to print.
  function handleOtp() {
    if (editing) toggleEdit();

    if (el.otpBtn) el.otpBtn.disabled = true;

    Uprint.requestPrint({
      element: el.coverPage,
      filename: pdfFilename(),
      copies: Math.max(1, parseInt(el.copies ? el.copies.value : 1, 10) || 1),
      color: el.colorMode ? el.colorMode.value === 'color' : false,
      tool: 'assignment-cover',
      title: current.assignment ? current.assignment.title || '' : '',
      courseCode: current.course ? current.course.courseCode : 'CU',
      roll: el.rollNumber ? el.rollNumber.value.trim() : '',
      reason: 'Kiosk codes cost money, so they are tied to your DDB balance.',
      validate: function () {
        if (!current.course) return 'Pick a course first.';
        if (el.rollNumber && !el.rollNumber.value.trim()) return 'Enter your roll number first.';
        return null;
      },
    }).then(function () {
      if (el.otpBtn) el.otpBtn.disabled = false;
    });
  }

  // ---- Bridge Health Check --------------------------------------------------
  function checkBridge() {
    if (!window.Uprint) return;
    Uprint.bindBridgeBadge(el.bridgeDot, el.bridgeText, 60000);
  }

  // ---- Event Bindings -------------------------------------------------------
  function bindEvents() {
    // Course selection
    if (el.courseSelect) {
      el.courseSelect.addEventListener('change', function () {
        onCourseSelected(this.value);
      });
    }

    // Assignment selection
    if (el.assignmentSelect) {
      el.assignmentSelect.addEventListener('change', function () {
        var c = courses[el.courseSelect.value];
        if (!c) return;
        var a = (c.assignments || {})[this.value];
        if (a) {
          a._id = this.value;
          current.assignment = a;
          if (a.submissionDate && !userTypedCustomDate && el.submissionDate) {
            el.submissionDate.value = a.submissionDate;
          }
          updatePreview();
        }
      });
    }

    // Roll number auto-lookup directly from Firebase Realtime Database
    var debounceTimer;
    if (el.rollNumber) {
      el.rollNumber.addEventListener('input', function () {
        var roll = this.value.trim();
        clearTimeout(debounceTimer);
        if (roll.length >= 3) {
          setLookupStatus('Searching Firebase…', '');
          debounceTimer = setTimeout(function () {
            lookupStudent(roll).then(function (st) {
              if (st) {
                current.student = st;
                if (st.fullName) el.studentName.value = st.fullName;
                setLookupStatus('✓ Verified student record', 'ok');
                showStudentCard(st);
              } else {
                current.student = {
                  fullName: el.studentName.value.trim() || roll,
                  studentId: roll,
                  session: deriveSession(roll),
                  department: current.course ? current.course.department : 'Electrical and Electronic Engineering',
                };
                setLookupStatus('Custom student entry', 'warn');
                showStudentCard(current.student);
              }
              updatePreview();
            });
          }, 300);
        } else {
          setLookupStatus('Enter roll to auto-fill', '');
          if (el.studentCardPill) el.studentCardPill.style.display = 'none';
          current.student = null;
          updatePreview();
        }
      });
    }

    // Student name manual edit
    if (el.studentName) {
      el.studentName.addEventListener('input', function () {
        if (!current.student) {
          current.student = {
            fullName: this.value.trim(),
            studentId: el.rollNumber ? el.rollNumber.value.trim() : '',
            session: deriveSession(el.rollNumber ? el.rollNumber.value.trim() : ''),
            department: current.course ? current.course.department : 'Electrical and Electronic Engineering',
          };
        } else {
          current.student.fullName = this.value.trim();
        }
        if (el.studentNameVal) el.studentNameVal.textContent = this.value.trim() || 'Student';
        updatePreview();
      });
    }

    // Submission Date input
    if (el.submissionDate) {
      el.submissionDate.addEventListener('change', function () {
        userTypedCustomDate = true;
        updatePreview();
      });
    }

    // Quick Date Chips (Today / Tomorrow)
    if (el.chipToday) {
      el.chipToday.addEventListener('click', function () {
        userTypedCustomDate = true;
        var today = new Date();
        var yyyy = today.getFullYear();
        var mm = String(today.getMonth() + 1).padStart(2, '0');
        var dd = String(today.getDate()).padStart(2, '0');
        el.submissionDate.value = yyyy + '-' + mm + '-' + dd;
        updatePreview();
      });
    }
    if (el.chipTomorrow) {
      el.chipTomorrow.addEventListener('click', function () {
        userTypedCustomDate = true;
        var tmrw = new Date();
        tmrw.setDate(tmrw.getDate() + 1);
        var yyyy = tmrw.getFullYear();
        var mm = String(tmrw.getMonth() + 1).padStart(2, '0');
        var dd = String(tmrw.getDate()).padStart(2, '0');
        el.submissionDate.value = yyyy + '-' + mm + '-' + dd;
        updatePreview();
      });
    }

    // Copies Stepper
    if (el.decCopies && el.copies) {
      el.decCopies.addEventListener('click', function () {
        var val = parseInt(el.copies.value, 10) || 1;
        if (val > 1) {
          el.copies.value = val - 1;
          updateCostCalculator();
        }
      });
    }
    if (el.incCopies && el.copies) {
      el.incCopies.addEventListener('click', function () {
        var val = parseInt(el.copies.value, 10) || 1;
        if (val < 20) {
          el.copies.value = val + 1;
          updateCostCalculator();
        }
      });
    }

    // Colour Mode Toggle
    if (el.colorModeToggle) {
      var segBtns = el.colorModeToggle.querySelectorAll('.seg-btn');
      segBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          segBtns.forEach(function (b) { b.classList.remove('active'); });
          this.classList.add('active');
          var mode = this.getAttribute('data-value') || 'mono';
          if (el.colorMode) el.colorMode.value = mode;
          updateCostCalculator();
        });
      });
    }

    // Action Buttons
    if (el.generateBtn) el.generateBtn.addEventListener('click', function () { updatePreview(); fitPreview(); });
    if (el.editBtn) el.editBtn.addEventListener('click', toggleEdit);
    if (el.toolEditBtn) el.toolEditBtn.addEventListener('click', toggleEdit);
    if (el.pdfBtn) el.pdfBtn.addEventListener('click', handlePdf);
    if (el.printBtn) el.printBtn.addEventListener('click', handleDirectPrint);
    if (el.otpBtn) el.otpBtn.addEventListener('click', handleOtp);

    // Floating Mobile Preview Action Dock
    var floatOtp = document.getElementById('floatOtpBtn');
    var floatPdf = document.getElementById('floatPdfBtn');
    var floatPrint = document.getElementById('floatPrintBtn');
    var floatEdit = document.getElementById('floatEditBtn');
    if (floatOtp) floatOtp.addEventListener('click', handleOtp);
    if (floatPdf) floatPdf.addEventListener('click', handlePdf);
    if (floatPrint) floatPrint.addEventListener('click', handleDirectPrint);
    if (floatEdit) floatEdit.addEventListener('click', toggleEdit);

    // Zoom Controls
    if (el.zoomInBtn) el.zoomInBtn.addEventListener('click', zoomIn);
    if (el.zoomOutBtn) el.zoomOutBtn.addEventListener('click', zoomOut);
    if (el.zoomLevelBtn) el.zoomLevelBtn.addEventListener('click', zoomReset);

    // Mobile Touch Gestures (Pinch & Double-tap)
    initTouchGestures();

    // History Drawer
    if (global.Uprint && global.Uprint.initHistoryDrawer) {
      global.Uprint.initHistoryDrawer();
    }

    // Window resize & orientation change
    window.addEventListener('resize', fitPreview);
    window.addEventListener('orientationchange', function () {
      setTimeout(fitPreview, 150);
    });
  }

  // ---- Bootstrap Application ------------------------------------------------
  function init() {
    initTheme();
    initMobileTabs();
    bindEvents();
    updateCostCalculator();
    initFirebaseRealtime();
    checkBridge();
    setInterval(checkBridge, 30000);
    setTimeout(fitPreview, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
