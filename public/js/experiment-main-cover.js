/* =============================================================================
   experiment-main-cover.js — Chittagong University Main Cover Page Generator
   100% Real-time synchronization with Firebase Realtime Database.
   ============================================================================= */
(function (global) {
  'use strict';

  // Firebase config lives in js/labddb-config.js — one file for every page.
  var firebaseConfig = (global.LabDDB && global.LabDDB.dataConfig) || null;

  // ---- Cached DOM Element Map -----------------------------------------------
  var el = {};
  var elementIds = [
    'appLayout', 'courseSelect', 'rollNumber', 'rememberRollCheckbox', 'studentName', 'submissionDate',
    'copies', 'colorMode', 'generateBtn', 'editBtn', 'toolEditBtn', 'printBtn',
    'pdfBtn', 'otpBtn', 'lookupBadge', 'studentCardPill', 'studentAvatar',
    'studentNameVal', 'studentSubVal', 'coverPage', 'previewScale', 'emptyHint',
    'previewContainer', 'bridgeDot', 'bridgeText', 'themeToggleBtn', 'historyBtn',
    'historyCount', 'historyDrawer', 'historyDrawerBackdrop', 'historyDrawerClose',
    'historyList', 'tabEditor', 'tabPreview', 'mobileTabs', 'decCopies',
    'incCopies', 'colorModeToggle', 'costCalcText', 'costTotalTag', 'chipSubToday',
    'chipSubTomorrow', 'zoomOutBtn', 'zoomInBtn', 'zoomLevelBtn',
    'editIndicator', 'mobileReturnEditorBtn'
  ];

  elementIds.forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var db = null;
  var courses = {};
  var labList = [];
  var studentCache = {};
  var currentScale = 1.0;
  var editing = false;

  var current = {
    course: null,
    student: null,
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
    var prevSelectedCode = el.courseSelect ? el.courseSelect.value : null;
    courses = {};
    labList = [];

    Object.keys(val).forEach(function (code) {
      var o = val[code];
      if (!o) return;

      var faculty = [];
      if (Array.isArray(o.facultyMembers) && o.facultyMembers.length) {
        faculty = o.facultyMembers;
      } else if (o.teacher && (o.teacher.name || o.teacher.designation)) {
        faculty = [o.teacher];
      }

      var exps = Array.isArray(o.experiments) ? o.experiments : [];

      courses[code] = {
        _key: code,
        courseCode: o.courseCode || code,
        courseTitle: o.courseTitle || '',
        department: o.department || 'Electrical and Electronic Engineering',
        courseType: o.courseType || (exps.length ? 'lab' : 'theory'),
        facultyMembers: faculty,
        semesterText: o.semesterText || '',
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
    current.course = c;
    updatePreview();
  }

  // ---- Student Roll Auto-Lookup ---------------------------------------------
  var lookupTimer = null;
  function handleRollInput(val) {
    var roll = (val || '').trim();
    clearTimeout(lookupTimer);

    if (roll.length < 3) {
      if (el.lookupBadge) {
        el.lookupBadge.textContent = 'Enter roll to auto-fill';
        el.lookupBadge.className = 'helper-badge';
      }
      if (el.studentCardPill) el.studentCardPill.style.display = 'none';
      current.student = null;
      updatePreview();
      return;
    }

    if (el.lookupBadge) {
      el.lookupBadge.textContent = 'Searching student database…';
      el.lookupBadge.className = 'helper-badge searching';
    }

    lookupTimer = setTimeout(function () {
      lookupStudent(roll);
    }, 350);
  }

  function lookupStudent(roll) {
    if (studentCache[roll]) {
      applyStudentData(studentCache[roll]);
      return;
    }

    if (!db) {
      applyFallbackStudent(roll);
      return;
    }

    db.ref('students/' + roll).once('value').then(function (snap) {
      var st = snap.val();
      if (st) {
        st.studentId = roll;
        if (!st.session) st.session = deriveSession(roll);
        studentCache[roll] = st;
        applyStudentData(st);
      } else {
        applyFallbackStudent(roll);
      }
    }).catch(function (err) {
      console.warn('[Lookup] Student query error:', err);
      applyFallbackStudent(roll);
    });
  }

  function deriveSession(roll) {
    if (!roll || roll.length < 2) return '2023-2024';
    var prefix = roll.substring(0, 2);
    var map = {
      '24': '2023-2024',
      '23': '2022-2023',
      '22': '2021-2022',
      '21': '2020-2021',
      '20': '2019-2020',
      '19': '2018-2019',
      '18': '2017-2018',
    };
    return map[prefix] || '2023-2024';
  }

  function applyStudentData(st) {
    current.student = st;
    if (el.studentName && (!el.studentName.value || !el.studentName.dataset.userEdited)) {
      el.studentName.value = st.fullName || st.name || '';
    }

    if (el.lookupBadge) {
      el.lookupBadge.textContent = '✓ Verified CU Student';
      el.lookupBadge.className = 'helper-badge success';
    }

    if (el.studentCardPill) {
      el.studentCardPill.style.display = 'flex';
      var name = st.fullName || st.name || 'CU Student';
      if (el.studentAvatar) el.studentAvatar.textContent = name.charAt(0).toUpperCase();
      if (el.studentNameVal) el.studentNameVal.textContent = name;
      if (el.studentSubVal) {
        el.studentSubVal.textContent = 'ID: ' + (st.studentId || '') + ' · Session: ' + (st.session || deriveSession(st.studentId));
      }
    }

    updatePreview();
  }

  function applyFallbackStudent(roll) {
    var fallback = {
      studentId: roll,
      fullName: (el.studentName && el.studentName.value) ? el.studentName.value.trim() : 'Md. Student',
      session: deriveSession(roll),
      department: (current.course && current.course.department) ? current.course.department : 'Electrical and Electronic Engineering',
    };
    current.student = fallback;

    if (el.lookupBadge) {
      el.lookupBadge.textContent = 'Roll verified (auto session)';
      el.lookupBadge.className = 'helper-badge';
    }
    if (el.studentCardPill) el.studentCardPill.style.display = 'none';

    updatePreview();
  }

  // ---- Date Helpers ---------------------------------------------------------
  function formatDate(dStr) {
    if (!dStr) return '';
    var p = dStr.split('-');
    if (p.length !== 3) return dStr;
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) - 1;
    var d = parseInt(p[2], 10);
    var months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    if (isNaN(m) || m < 0 || m > 11 || isNaN(d)) return dStr;
    return months[m] + ' ' + d + ', ' + y;
  }

  function setTodayDate() {
    var now = new Date();
    var iso = now.toISOString().split('T')[0];
    if (el.submissionDate) {
      el.submissionDate.value = iso;
      updatePreview();
    }
  }

  function setTomorrowDate() {
    var now = new Date();
    now.setDate(now.getDate() + 1);
    var iso = now.toISOString().split('T')[0];
    if (el.submissionDate) {
      el.submissionDate.value = iso;
      updatePreview();
    }
  }

  // ---- Live Document Preview Renderer ---------------------------------------
  function updatePreview() {
    if (!el.coverPage) return;

    var c = current.course;
    var s = current.student;

    // Course info
    if (c) {
      setField('department', 'Department of <strong>' + esc(c.department || 'Electrical and Electronic Engineering') + '</strong>');
      setField('course-code', '<strong>' + esc(c.courseCode || '---') + '</strong>');
      setField('course-title', esc(c.courseTitle || '---'));
      renderFaculty(c.facultyMembers || [], c.department);
    }

    // Student info
    var rollVal = (el.rollNumber && el.rollNumber.value) ? el.rollNumber.value.trim() : (s ? s.studentId : '---');
    var nameVal = (el.studentName && el.studentName.value) ? el.studentName.value.trim() : (s ? s.fullName : '---');
    var sessVal = s ? (s.session || deriveSession(rollVal)) : deriveSession(rollVal);
    var semVal = (c && c.semesterText) ? c.semesterText : '8th Semester B.Sc Engineering';
    var deptVal = (c && c.department) ? c.department : 'Electrical and Electronic Engineering';

    var studentHtml =
      'Name: <strong>' + esc(nameVal || '---') + '</strong><br />' +
      'ID: <strong>' + esc(rollVal || '---') + '</strong><br />' +
      'Session: ' + esc(sessVal || '2023-2024') + '<br />' +
      esc(semVal) + '<br />' +
      esc(formatDeptLabel(deptVal)) + '<br />' +
      'University of Chittagong';

    setField('student', studentHtml);

    // Dates
    var subD = el.submissionDate && el.submissionDate.value ? formatDate(el.submissionDate.value) : '';
    setField('submission-date', subD);

    fitPreview();
  }

  function formatDeptLabel(d) {
    if (!d) return 'Dept. of Electrical and Electronic Engineering';
    var trimmed = String(d).trim();
    if (/^(dept\.|department|institute|center|bureau|faculty)/i.test(trimmed)) {
      return trimmed;
    }
    return 'Dept. of ' + trimmed;
  }

  function setField(fieldName, html) {
    if (!el.coverPage) return;
    var node = el.coverPage.querySelector('[data-field="' + fieldName + '"]');
    if (node) node.innerHTML = html;
  }

  function renderFaculty(facultyMembers, dept) {
    var container = el.coverPage.querySelector('[data-field="faculty"]');
    if (!container) return;

    var deptName = dept || 'Electrical and Electronic Engineering';
    if (!facultyMembers || !facultyMembers.length) {
      container.innerHTML =
        '<div class="faculty-block">' +
        '<strong>Course Teacher</strong><br />' +
        'Faculty Member<br />' +
        esc(formatDeptLabel(deptName)) + '<br />' +
        'University of Chittagong' +
        '</div>';
      return;
    }

    var html = '';
    facultyMembers.forEach(function (f) {
      html +=
        '<div class="faculty-block">' +
        '<strong>' + esc(f.name || '—') + '</strong><br />' +
        esc(f.designation || f.title || 'Faculty Member') + '<br />' +
        esc(formatDeptLabel(f.department || deptName)) + '<br />' +
        'University of Chittagong' +
        '</div>';
    });
    container.innerHTML = html;
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

  // ---- Zoom & Layout Engine -------------------------------------------------
  // ---- Zoom, Layout Engine & Mobile Touch Gestures -------------------------
  function fitPreview() {
    if (!el.previewContainer || !el.previewScale || !el.coverPage) return;
    var containerW = el.previewContainer.clientWidth - (window.innerWidth < 640 ? 16 : 32);
    var containerH = el.previewContainer.clientHeight - (window.innerWidth < 640 ? 20 : 32);
    var pageW = el.coverPage.offsetWidth || 794;
    var pageH = el.coverPage.offsetHeight || 1123;

    if (containerW <= 0 || pageW <= 0) return;

    var scale = Math.min(containerW / pageW, containerH / pageH, 1.05);
    currentScale = Math.max(0.25, Math.min(scale, 1.5));
    applyScale(currentScale);
  }

  function applyScale(scale) {
    if (!el.previewScale) return;
    el.previewScale.style.transform = 'scale(' + scale + ')';
    if (el.zoomLevelBtn) {
      el.zoomLevelBtn.textContent = Math.round(scale * 100) + '%';
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
    if (el.coverPage) {
      if (editing) {
        el.coverPage.classList.add('editing');
        var targets = el.coverPage.querySelectorAll(
          'td, .cover-title, .cover-department, .cover-university, .faculty-block, .student-info'
        );
        targets.forEach(function (node) {
          if (!node.querySelector('img')) {
            node.setAttribute('contenteditable', 'true');
          }
        });
      } else {
        el.coverPage.classList.remove('editing');
        el.coverPage.querySelectorAll('[contenteditable]').forEach(function (node) {
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
  function getMainCoverFilename() {
    var dept = current.course ? current.course.department : 'EEE';
    var code = (current.course && current.course.courseCode) ? current.course.courseCode : '417';
    var roll = (el.rollNumber && el.rollNumber.value) ? el.rollNumber.value.trim() : 'Roll';
    if (global.Uprint && global.Uprint.formatCoverFilename) {
      return global.Uprint.formatCoverFilename(dept, code, 'Main', roll);
    }
    return 'LabDDB_EEE_417_Main_' + roll + '.pdf';
  }

  function handlePdf() {
    if (editing) toggleInlineEdit();
    var filename = getMainCoverFilename();

    if (el.pdfBtn) {
      el.pdfBtn.disabled = true;
      el.pdfBtn.textContent = 'Generating PDF…';
    }

    Uprint.elementToPdfBase64(el.coverPage).then(function (b64) {
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
    window.print();
  }

  function handleOtp() {
    if (editing) toggleInlineEdit();

    var code = (current.course && current.course.courseCode) ? current.course.courseCode : 'EEE';
    var roll = (el.rollNumber && el.rollNumber.value) ? el.rollNumber.value.trim() : 'Cover';
    var filename = getMainCoverFilename();

    if (el.otpBtn) el.otpBtn.disabled = true;

    Uprint.requestPrint({
      element: el.coverPage,
      filename: filename,
      copies: parseInt(el.copies ? el.copies.value : '1', 10) || 1,
      color: (el.colorMode ? el.colorMode.value : 'mono') === 'color',
      tool: 'experiment-main-cover',
      title: 'Semester Lab Report Cover',
      courseCode: code,
      roll: roll,
      reason: 'Kiosk codes cost money, so they are tied to your DDB balance.',
      validate: function () {
        if (!current.course) return 'Pick a course first.';
        if (el.rollNumber && !el.rollNumber.value.trim()) return 'Enter your roll number first.';
        return null;
      },
    }).then(function (res) {
      if (el.otpBtn) el.otpBtn.disabled = false;
      if (res && res.otp) incCoverCounter();
    });
  }

  // ---- Event Bindings & Init ------------------------------------------------
  function initEvents() {
    if (el.courseSelect) {
      el.courseSelect.addEventListener('change', function () {
        selectCourse(this.value);
      });
    }

    if (el.rollNumber) {
      el.rollNumber.addEventListener('input', function () {
        handleRollInput(this.value);
        if (el.rememberRollCheckbox && el.rememberRollCheckbox.checked) {
          var val = this.value.trim();
          if (val && val.length >= 3) {
            if (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.setRememberedRoll) {
              global.LabDDB.auth.setRememberedRoll(val);
            } else {
              localStorage.setItem('labddb_remembered_roll', val);
            }
          }
        }
      });
    }

    if (el.rememberRollCheckbox) {
      el.rememberRollCheckbox.addEventListener('change', function () {
        var roll = el.rollNumber ? el.rollNumber.value.trim() : '';
        if (this.checked) {
          if (roll && roll.length >= 3) {
            if (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.setRememberedRoll) {
              global.LabDDB.auth.setRememberedRoll(roll);
            } else {
              localStorage.setItem('labddb_remembered_roll', roll);
            }
            if (global.Uprint && global.Uprint.showToast) {
              global.Uprint.showToast('Roll ' + roll + ' will be remembered.', '✓');
            }
          }
        } else {
          if (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.clearRememberedRoll) {
            global.LabDDB.auth.clearRememberedRoll();
          } else {
            localStorage.removeItem('labddb_remembered_roll');
          }
          if (global.Uprint && global.Uprint.showToast) {
            global.Uprint.showToast('Remembered roll cleared.', 'ℹ️');
          }
        }
      });
    }

    if (el.studentName) {
      el.studentName.addEventListener('input', function () {
        this.dataset.userEdited = 'true';
        updatePreview();
      });
    }

    if (el.submissionDate) {
      el.submissionDate.addEventListener('change', updatePreview);
    }

    if (el.chipSubToday) {
      el.chipSubToday.addEventListener('click', setTodayDate);
    }
    if (el.chipSubTomorrow) {
      el.chipSubTomorrow.addEventListener('click', setTomorrowDate);
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

    // Listen for roll changes from profile modal or external tabs
    window.addEventListener('labddb:roll_changed', function (e) {
      var newRoll = e && e.detail ? e.detail.roll : '';
      loadRememberedRoll(newRoll);
    });
  }

  // ---- Remembered Roll Auto-Loader ------------------------------------------
  function loadRememberedRoll(forcedRoll) {
    var remembered = typeof forcedRoll === 'string'
      ? forcedRoll
      : (global.LabDDB && global.LabDDB.auth && global.LabDDB.auth.getRememberedRoll
          ? global.LabDDB.auth.getRememberedRoll()
          : (localStorage.getItem('labddb_remembered_roll') || ''));

    if (el.rememberRollCheckbox) {
      el.rememberRollCheckbox.checked = Boolean(remembered);
    }

    if (remembered && el.rollNumber) {
      el.rollNumber.value = remembered;
      lookupStudent(remembered);
    } else if (!remembered && typeof forcedRoll === 'string') {
      if (el.rollNumber && el.rollNumber.value === '') {
        current.student = null;
        if (el.studentCardPill) el.studentCardPill.style.display = 'none';
        if (el.lookupBadge) {
          el.lookupBadge.textContent = 'Enter roll to auto-fill';
          el.lookupBadge.className = 'helper-badge';
        }
        updatePreview();
      }
    }
  }

  // ---- Bootstrap App --------------------------------------------------------
  function init() {
    initTheme();
    initMobileTabs();
    initEvents();
    initFirebaseRealtime();
    loadRememberedRoll();
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
