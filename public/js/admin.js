/* =============================================================================
   admin.js — Chittagong University Admin Panel Controller
   Full CRUD operations with Firebase Realtime Database
   ============================================================================= */
(function (global) {
  'use strict';

  // Firebase config lives in js/labddb-config.js — one file for every page.
  var firebaseConfig = (global.LabDDB && global.LabDDB.dataConfig) || null;

  var db = null;
  var coursesData = {};
  var studentsData = {};
  var currentEditCourseKey = null;
  var currentEditStudentKey = null;

  // ---- Toast Notification ---------------------------------------------------
  function showToast(message, icon) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = (icon ? '<span>' + icon + '</span> ' : '') + '<span>' + esc(message) + '</span>';
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

  function esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---- Theme Engine ---------------------------------------------------------
  function initTheme() {
    var saved = localStorage.getItem('cu_app_theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);

    var toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var curr = document.documentElement.getAttribute('data-theme') || 'light';
        var next = curr === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('cu_app_theme', next);
      });
    }
  }

  // ---- Tab Switching --------------------------------------------------------
  function initTabs() {
    var nav = document.getElementById('adminTabsNav');
    if (!nav) return;

    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab-btn');
      if (!btn) return;
      var targetTab = btn.getAttribute('data-tab');
      switchTab(targetTab);
    });
  }

  function switchTab(tabId) {
    document.querySelectorAll('.admin-tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });

    document.querySelectorAll('.admin-tab-pane').forEach(function (p) {
      p.classList.remove('active');
    });

    var paneMap = {
      viewCourses: 'paneViewCourses',
      addCourse: 'paneAddCourse',
      editCourse: 'paneEditCourse',
      viewStudents: 'paneViewStudents',
      addStudent: 'paneAddStudent',
      editStudent: 'paneEditStudent',
      assignmentManagement: 'paneAssignmentManagement',
    };

    var pane = document.getElementById(paneMap[tabId]);
    if (pane) pane.classList.add('active');
  }

  // ---- Firebase Realtime Database -------------------------------------------
  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') {
        console.error('[Firebase] SDK missing');
        return;
      }
      if (!firebaseConfig) {
        console.error('[Firebase] js/labddb-config.js must load before admin.js');
        return;
      }
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      db = firebase.database();

      // Monitor connection
      db.ref('.info/connected').on('value', function (snap) {
        var isConnected = snap.val() === true;
        var dot = document.getElementById('dbDot');
        var text = document.getElementById('dbStatusText');
        if (dot && text) {
          dot.className = isConnected ? 'pulse-dot up' : 'pulse-dot down';
          text.textContent = isConnected ? 'Database Live' : 'Disconnected';
        }
      });

      // Stats listener
      db.ref('cvr3_meta/stats/coverpageCount').on('value', function (snap) {
        var count = snap.val() || 0;
        var el = document.getElementById('metricTotalGenerated');
        if (el) el.textContent = Number(count).toLocaleString();
      });

      // Courses listener
      db.ref('cvr3_courses').on('value', function (snap) {
        coursesData = snap.val() || {};
        updateCoursesMetrics();
        renderCoursesCatalog();
        populateCourseSelects();
        renderGlobalAssignments();
        if (currentEditCourseKey && coursesData[currentEditCourseKey]) {
          loadCourseIntoEditForm(currentEditCourseKey);
        }
      });

      // Students listener
      db.ref('students').on('value', function (snap) {
        studentsData = snap.val() || {};
        updateStudentsMetrics();
        renderStudentsCatalog();
        populateStudentSelects();
        if (currentEditStudentKey && studentsData[currentEditStudentKey]) {
          loadStudentIntoEditForm(currentEditStudentKey);
        }
      });

    } catch (err) {
      console.error('[Firebase] Error:', err);
    }
  }

  function updateCoursesMetrics() {
    var keys = Object.keys(coursesData);
    var labCount = 0;
    keys.forEach(function (k) {
      var c = coursesData[k];
      if ((c.courseType || 'lab') === 'lab' || (c.experiments && c.experiments.length)) {
        labCount++;
      }
    });

    var totalEl = document.getElementById('metricTotalCourses');
    var labEl = document.getElementById('metricTotalLabs');
    if (totalEl) totalEl.textContent = keys.length;
    if (labEl) labEl.textContent = labCount;
  }

  function updateStudentsMetrics() {
    var keys = Object.keys(studentsData);
    var el = document.getElementById('metricTotalStudents');
    if (el) el.textContent = keys.length;
  }

  // ---- COURSES TAB ----------------------------------------------------------
  function renderCoursesCatalog(filterQuery) {
    var container = document.getElementById('courseCatalogGrid');
    if (!container) return;

    var keys = Object.keys(coursesData);
    if (!keys.length) {
      container.innerHTML = '<div class="admin-empty-state"><p>No courses registered yet. Click "Add Course" to create one.</p></div>';
      return;
    }

    var q = (filterQuery || '').toLowerCase().trim();
    var filtered = keys.filter(function (k) {
      var c = coursesData[k];
      var code = (c.courseCode || k).toLowerCase();
      var title = (c.courseTitle || '').toLowerCase();
      var dept = (c.department || '').toLowerCase();
      return !q || code.includes(q) || title.includes(q) || dept.includes(q);
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="admin-empty-state"><p>No courses matching "' + esc(filterQuery) + '".</p></div>';
      return;
    }

    filtered.sort();
    var html = '';
    filtered.forEach(function (k) {
      var c = coursesData[k];
      var code = c.courseCode || k;
      var title = c.courseTitle || 'Untitled Course';
      var dept = c.department || 'EEE';
      var isLab = (c.courseType || 'lab') === 'lab';
      var faculty = Array.isArray(c.facultyMembers) ? c.facultyMembers : (c.teacher ? [c.teacher] : []);
      var exps = Array.isArray(c.experiments) ? c.experiments : [];
      var assignments = c.assignments ? Object.keys(c.assignments) : [];

      html +=
        '<div class="catalog-item-card" data-course-code="' + esc(code) + '">' +
        '  <div>' +
        '    <div class="item-card-top">' +
        '      <span class="item-code-badge">' + esc(code) + '</span>' +
        '      <span class="item-type-badge ' + (isLab ? 'lab' : 'theory') + '">' + (isLab ? 'Lab Course' : 'Theory Course') + '</span>' +
        '    </div>' +
        '    <h3 class="item-card-title">' + esc(title) + '</h3>' +
        '    <div class="item-card-meta">' +
        '      <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><path d="M3 21h18"></path><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path></svg>' + esc(dept) + '</span>' +
        '      <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>' + faculty.length + ' Faculty</span>' +
        (isLab
          ? '      <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><path d="M10 2v7.31"></path><path d="M14 9.3V2"></path><path d="M8.5 2h7"></path><path d="M14 9.3a6.5 6.5 0 1 1-4 0"></path><path d="M5.52 16h12.96"></path></svg>' + exps.length + ' Exp' + (exps.length === 1 ? '' : 's') + '</span>'
          : '      <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' + assignments.length + ' Assignment' + (assignments.length === 1 ? '' : 's') + '</span>') +
        '    </div>' +
        '  </div>' +
        '  <div class="item-card-actions">' +
        '    <button type="button" class="btn-small-action edit-course-trigger" data-code="' + esc(code) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>Edit</button>' +
        '    <button type="button" class="btn-small-action danger delete-course-trigger" data-code="' + esc(code) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>Delete</button>' +
        '  </div>' +
        '</div>';
    });

    container.innerHTML = html;

    // Attach card actions
    container.querySelectorAll('.edit-course-trigger').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code = this.getAttribute('data-code');
        openCourseEditor(code);
      });
    });

    container.querySelectorAll('.delete-course-trigger').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code = this.getAttribute('data-code');
        deleteCourse(code);
      });
    });
  }

  // Dynamic Faculty Row Helper
  function createFacultyRow(fData) {
    var f = fData || {};
    var row = document.createElement('div');
    row.className = 'faculty-form-row';
    row.innerHTML =
      '<input type="text" class="form-input fm-name" placeholder="Faculty Name (e.g. Dr. Md. Rahman)" value="' + esc(f.name || '') + '" required />' +
      '<input type="text" class="form-input fm-desig" placeholder="Designation (e.g. Professor)" value="' + esc(f.designation || f.title || '') + '" required />' +
      '<input type="text" class="form-input fm-dept" placeholder="Dept (e.g. Dept. of EEE)" value="' + esc(f.department || 'Dept. of EEE') + '" />' +
      '<button type="button" class="btn-icon-danger fm-remove-btn" title="Remove faculty member">✕</button>';

    row.querySelector('.fm-remove-btn').addEventListener('click', function () {
      if (row.parentNode) row.parentNode.removeChild(row);
    });
    return row;
  }

  // ---- ADD COURSE -----------------------------------------------------------
  function initAddCourse() {
    var container = document.getElementById('addFacultyContainer');
    var addFmBtn = document.getElementById('addMoreFacultyBtn');
    var form = document.getElementById('addCourseForm');

    if (container && addFmBtn) {
      // Default 1 faculty member
      container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: 'Dept. of EEE' }));

      addFmBtn.addEventListener('click', function () {
        if (container.children.length < 4) {
          container.appendChild(createFacultyRow({ name: '', designation: 'Assistant Professor', department: 'Dept. of EEE' }));
        } else {
          showToast('Maximum 4 faculty members allowed', '⚠️');
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = document.getElementById('addCourseCode').value.trim().toUpperCase().replace(/\s+/g, '');
        var title = document.getElementById('addCourseTitle').value.trim();
        var dept = document.getElementById('addCourseDept').value;
        var type = document.getElementById('addCourseType').value;
        var sem = document.getElementById('addSemesterText').value.trim();

        if (!code || !title) {
          showToast('Please fill in Course Code and Title', '⚠️');
          return;
        }

        // Collect faculty members
        var facultyList = [];
        container.querySelectorAll('.faculty-form-row').forEach(function (r) {
          var name = r.querySelector('.fm-name').value.trim();
          var desig = r.querySelector('.fm-desig').value.trim();
          var fDept = r.querySelector('.fm-dept').value.trim();
          if (name) {
            facultyList.push({ name: name, designation: desig, department: fDept });
          }
        });

        var payload = {
          courseCode: code,
          courseTitle: title,
          department: dept,
          courseType: type,
          semesterText: sem || '8th Semester B.Sc Engineering',
          facultyMembers: facultyList,
          experiments: type === 'lab' ? [{ num: '01', title: 'Introductory Experiment' }] : [],
          updatedAt: firebase.database.ServerValue.TIMESTAMP,
        };

        db.ref('cvr3_courses/' + code).set(payload).then(function () {
          showToast('Course ' + code + ' added successfully!', '✓');
          form.reset();
          container.innerHTML = '';
          container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: 'Dept. of EEE' }));
          switchTab('viewCourses');
        }).catch(function (err) {
          console.error(err);
          showToast('Failed to add course: ' + err.message, '❌');
        });
      });
    }
  }

  // ---- EDIT COURSE ----------------------------------------------------------
  function populateCourseSelects() {
    var select = document.getElementById('selectCourseToEdit');
    if (!select) return;

    var currentVal = select.value;
    select.innerHTML = '<option value="">Choose a course to edit…</option>';

    var keys = Object.keys(coursesData).sort();
    keys.forEach(function (k) {
      var c = coursesData[k];
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = (c.courseCode || k) + ' — ' + (c.courseTitle || 'Untitled');
      select.appendChild(opt);
    });

    if (currentVal && coursesData[currentVal]) {
      select.value = currentVal;
    }
  }

  function openCourseEditor(code) {
    switchTab('editCourse');
    var select = document.getElementById('selectCourseToEdit');
    if (select) {
      select.value = code;
      loadCourseIntoEditForm(code);
    }
  }

  function loadCourseIntoEditForm(code) {
    var c = coursesData[code];
    if (!c) return;
    currentEditCourseKey = code;

    var form = document.getElementById('editCourseForm');
    if (!form) return;
    form.style.display = 'block';

    document.getElementById('editCourseCode').value = c.courseCode || code;
    document.getElementById('editCourseTitle').value = c.courseTitle || '';
    document.getElementById('editCourseDept').value = c.department || 'Electrical and Electronic Engineering';
    document.getElementById('editCourseType').value = c.courseType || 'lab';
    document.getElementById('editSemesterText').value = c.semesterText || '';

    // Faculty members
    var container = document.getElementById('editFacultyContainer');
    container.innerHTML = '';
    var faculty = Array.isArray(c.facultyMembers) ? c.facultyMembers : (c.teacher ? [c.teacher] : []);
    if (faculty.length) {
      faculty.forEach(function (f) {
        container.appendChild(createFacultyRow(f));
      });
    } else {
      container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: 'Dept. of EEE' }));
    }

    // Sub-sections
    var isLab = (c.courseType || 'lab') === 'lab';
    var expSection = document.getElementById('subExperimentsSection');
    var assignSection = document.getElementById('subAssignmentsSection');

    if (expSection) {
      expSection.style.display = isLab ? 'block' : 'none';
      renderCourseExperimentsList(code, c.experiments || []);
    }
    if (assignSection) {
      assignSection.style.display = !isLab || c.assignments ? 'block' : 'none';
      renderCourseAssignmentsList(code, c.assignments || {});
    }
  }

  function initEditCourse() {
    var select = document.getElementById('selectCourseToEdit');
    if (select) {
      select.addEventListener('change', function () {
        if (this.value) {
          loadCourseIntoEditForm(this.value);
        } else {
          var form = document.getElementById('editCourseForm');
          if (form) form.style.display = 'none';
          document.getElementById('subExperimentsSection').style.display = 'none';
          document.getElementById('subAssignmentsSection').style.display = 'none';
        }
      });
    }

    var addFmBtn = document.getElementById('editMoreFacultyBtn');
    var container = document.getElementById('editFacultyContainer');
    if (addFmBtn && container) {
      addFmBtn.addEventListener('click', function () {
        if (container.children.length < 4) {
          container.appendChild(createFacultyRow({ name: '', designation: 'Assistant Professor', department: 'Dept. of EEE' }));
        } else {
          showToast('Maximum 4 faculty members allowed', '⚠️');
        }
      });
    }

    var form = document.getElementById('editCourseForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;

        var title = document.getElementById('editCourseTitle').value.trim();
        var dept = document.getElementById('editCourseDept').value;
        var type = document.getElementById('editCourseType').value;
        var sem = document.getElementById('editSemesterText').value.trim();

        var facultyList = [];
        container.querySelectorAll('.faculty-form-row').forEach(function (r) {
          var name = r.querySelector('.fm-name').value.trim();
          var desig = r.querySelector('.fm-desig').value.trim();
          var fDept = r.querySelector('.fm-dept').value.trim();
          if (name) {
            facultyList.push({ name: name, designation: desig, department: fDept });
          }
        });

        var updates = {
          courseTitle: title,
          department: dept,
          courseType: type,
          semesterText: sem,
          facultyMembers: facultyList,
          updatedAt: firebase.database.ServerValue.TIMESTAMP,
        };

        db.ref('cvr3_courses/' + currentEditCourseKey).update(updates).then(function () {
          showToast('Course ' + currentEditCourseKey + ' updated!', '✓');
        }).catch(function (err) {
          showToast('Update failed: ' + err.message, '❌');
        });
      });
    }

    var deleteBtn = document.getElementById('deleteCurrentCourseBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (currentEditCourseKey) {
          deleteCourse(currentEditCourseKey);
        }
      });
    }

    // Sub-manager: Add Experiment
    var addExpForm = document.getElementById('addExperimentForm');
    if (addExpForm) {
      addExpForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;
        var num = document.getElementById('newExpNum').value.trim();
        var title = document.getElementById('newExpTitle').value.trim();
        if (!num || !title) return;

        var curExps = coursesData[currentEditCourseKey].experiments || [];
        var updatedExps = curExps.concat([{ num: num, title: title }]);

        db.ref('cvr3_courses/' + currentEditCourseKey + '/experiments').set(updatedExps).then(function () {
          showToast('Experiment ' + num + ' added!', '✓');
          addExpForm.reset();
        });
      });
    }

    // Sub-manager: Add Assignment
    var addAssignForm = document.getElementById('addCourseAssignmentForm');
    if (addAssignForm) {
      addAssignForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;
        var num = document.getElementById('newAssignNum').value.trim();
        var title = document.getElementById('newAssignTitle').value.trim();
        var date = document.getElementById('newAssignDate').value;
        if (!num || !title) return;

        var assignId = 'assign_' + Date.now();
        var payload = {
          assignmentNumber: num,
          assignmentTitle: title,
          submissionDate: date || '',
        };

        db.ref('cvr3_courses/' + currentEditCourseKey + '/assignments/' + assignId).set(payload).then(function () {
          showToast('Assignment ' + num + ' added!', '✓');
          addAssignForm.reset();
        });
      });
    }
  }

  function renderCourseExperimentsList(code, exps) {
    var tbody = document.getElementById('courseExperimentsList');
    if (!tbody) return;

    if (!exps.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No experiments added yet. Use form below to add.</td></tr>';
      return;
    }

    var html = '';
    exps.forEach(function (exp, idx) {
      var num = exp.num || (idx + 1);
      var title = exp.title || exp.expTitle || 'Experiment ' + num;
      html +=
        '<tr>' +
        '  <td><strong>' + esc(num) + '</strong></td>' +
        '  <td>' + esc(title) + '</td>' +
        '  <td style="text-align: right;"><button type="button" class="btn-small-action danger delete-exp-btn" data-idx="' + idx + '">✕ Delete</button></td>' +
        '</tr>';
    });

    tbody.innerHTML = html;
    tbody.querySelectorAll('.delete-exp-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        var curExps = coursesData[code].experiments || [];
        curExps.splice(idx, 1);
        db.ref('cvr3_courses/' + code + '/experiments').set(curExps).then(function () {
          showToast('Experiment removed', '✓');
        });
      });
    });
  }

  function renderCourseAssignmentsList(code, assignmentsObj) {
    var tbody = document.getElementById('courseAssignmentsList');
    if (!tbody) return;

    var keys = Object.keys(assignmentsObj || {});
    if (!keys.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No assignments added yet.</td></tr>';
      return;
    }

    var html = '';
    keys.forEach(function (aId) {
      var a = assignmentsObj[aId];
      html +=
        '<tr>' +
        '  <td><strong>' + esc(a.assignmentNumber || '—') + '</strong></td>' +
        '  <td>' + esc(a.assignmentTitle || 'Untitled') + '</td>' +
        '  <td>' + esc(a.submissionDate || '—') + '</td>' +
        '  <td style="text-align: right;"><button type="button" class="btn-small-action danger delete-assign-btn" data-id="' + aId + '">✕ Delete</button></td>' +
        '</tr>';
    });

    tbody.innerHTML = html;
    tbody.querySelectorAll('.delete-assign-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var aId = this.getAttribute('data-id');
        db.ref('cvr3_courses/' + code + '/assignments/' + aId).remove().then(function () {
          showToast('Assignment deleted', '✓');
        });
      });
    });
  }

  function deleteCourse(code) {
    if (confirm('Are you sure you want to delete course ' + code + ' from Firebase? This cannot be undone.')) {
      db.ref('cvr3_courses/' + code).remove().then(function () {
        showToast('Course ' + code + ' deleted!', '✓');
        if (currentEditCourseKey === code) {
          currentEditCourseKey = null;
          var form = document.getElementById('editCourseForm');
          if (form) form.style.display = 'none';
        }
      }).catch(function (err) {
        showToast('Delete failed: ' + err.message, '❌');
      });
    }
  }

  // ---- STUDENTS TAB ---------------------------------------------------------
  function renderStudentsCatalog(filterQuery) {
    var container = document.getElementById('studentCatalogGrid');
    if (!container) return;

    var keys = Object.keys(studentsData);
    if (!keys.length) {
      container.innerHTML = '<div class="admin-empty-state"><p>No student profiles registered yet. Click "Add Student" to create one.</p></div>';
      return;
    }

    var q = (filterQuery || '').toLowerCase().trim();
    var filtered = keys.filter(function (k) {
      var s = studentsData[k];
      var roll = String(s.studentId || k).toLowerCase();
      var name = (s.fullName || s.name || '').toLowerCase();
      var session = (s.session || '').toLowerCase();
      var dept = (s.department || '').toLowerCase();
      return !q || roll.includes(q) || name.includes(q) || session.includes(q) || dept.includes(q);
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="admin-empty-state"><p>No students matching "' + esc(filterQuery) + '".</p></div>';
      return;
    }

    filtered.sort();
    var html = '';
    filtered.forEach(function (k) {
      var s = studentsData[k];
      var roll = s.studentId || k;
      var name = s.fullName || s.name || 'Unnamed Student';
      var session = s.session || '2023-2024';
      var dept = s.department || 'EEE';

      html +=
        '<div class="catalog-item-card">' +
        '  <div style="display: flex; gap: 14px; align-items: center;">' +
        '    <div class="student-avatar" style="width: 44px; height: 44px; font-size: 18px;">' + esc(name.charAt(0).toUpperCase()) + '</div>' +
        '    <div>' +
        '      <h3 class="item-card-title" style="margin: 0; font-size: 15px;">' + esc(name) + '</h3>' +
        '      <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">' +
        '        <strong>ID: ' + esc(roll) + '</strong> · ' + esc(session) +
        '      </div>' +
        '      <div style="font-size: 11.5px; color: var(--text-muted);">' + esc(dept) + '</div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="item-card-actions">' +
        '    <button type="button" class="btn-small-action edit-student-trigger" data-roll="' + esc(roll) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>Edit</button>' +
        '    <button type="button" class="btn-small-action danger delete-student-trigger" data-roll="' + esc(roll) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>Delete</button>' +
        '  </div>' +
        '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.edit-student-trigger').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var roll = this.getAttribute('data-roll');
        openStudentEditor(roll);
      });
    });

    container.querySelectorAll('.delete-student-trigger').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var roll = this.getAttribute('data-roll');
        deleteStudent(roll);
      });
    });
  }

  function initAddStudent() {
    var form = document.getElementById('addStudentForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var roll = document.getElementById('addStudentRoll').value.trim();
      var name = document.getElementById('addStudentName').value.trim();
      var dept = document.getElementById('addStudentDept').value;
      var session = document.getElementById('addStudentSession').value.trim();

      if (!roll || !name) {
        showToast('Please fill in Student Roll and Name', '⚠️');
        return;
      }

      var payload = {
        studentId: roll,
        fullName: name,
        department: dept,
        session: session || deriveSession(roll),
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
      };

      db.ref('students/' + roll).set(payload).then(function () {
        showToast('Student ' + roll + ' saved!', '✓');
        form.reset();
        switchTab('viewStudents');
      }).catch(function (err) {
        showToast('Failed to add student: ' + err.message, '❌');
      });
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

  function populateStudentSelects() {
    var select = document.getElementById('selectStudentToEdit');
    if (!select) return;

    var currentVal = select.value;
    select.innerHTML = '<option value="">Choose a student…</option>';

    var keys = Object.keys(studentsData).sort();
    keys.forEach(function (k) {
      var s = studentsData[k];
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = (s.studentId || k) + ' — ' + (s.fullName || s.name || 'Unnamed');
      select.appendChild(opt);
    });

    if (currentVal && studentsData[currentVal]) {
      select.value = currentVal;
    }
  }

  function openStudentEditor(roll) {
    switchTab('editStudent');
    var select = document.getElementById('selectStudentToEdit');
    if (select) {
      select.value = roll;
      loadStudentIntoEditForm(roll);
    }
  }

  function loadStudentIntoEditForm(roll) {
    var s = studentsData[roll];
    if (!s) return;
    currentEditStudentKey = roll;

    var form = document.getElementById('editStudentForm');
    if (!form) return;
    form.style.display = 'block';

    document.getElementById('editStudentRoll').value = s.studentId || roll;
    document.getElementById('editStudentName').value = s.fullName || s.name || '';
    document.getElementById('editStudentDept').value = s.department || 'Electrical and Electronic Engineering';
    document.getElementById('editStudentSession').value = s.session || '';
  }

  function initEditStudent() {
    var select = document.getElementById('selectStudentToEdit');
    if (select) {
      select.addEventListener('change', function () {
        if (this.value) {
          loadStudentIntoEditForm(this.value);
        } else {
          var form = document.getElementById('editStudentForm');
          if (form) form.style.display = 'none';
        }
      });
    }

    var form = document.getElementById('editStudentForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditStudentKey) return;

        var name = document.getElementById('editStudentName').value.trim();
        var dept = document.getElementById('editStudentDept').value;
        var session = document.getElementById('editStudentSession').value.trim();

        var updates = {
          fullName: name,
          department: dept,
          session: session,
          updatedAt: firebase.database.ServerValue.TIMESTAMP,
        };

        db.ref('students/' + currentEditStudentKey).update(updates).then(function () {
          showToast('Student profile updated!', '✓');
        }).catch(function (err) {
          showToast('Update failed: ' + err.message, '❌');
        });
      });
    }

    var deleteBtn = document.getElementById('deleteStudentBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (currentEditStudentKey) {
          deleteStudent(currentEditStudentKey);
        }
      });
    }
  }

  function deleteStudent(roll) {
    if (confirm('Delete student ' + roll + ' from database?')) {
      db.ref('students/' + roll).remove().then(function () {
        showToast('Student ' + roll + ' deleted', '✓');
        if (currentEditStudentKey === roll) {
          currentEditStudentKey = null;
          var form = document.getElementById('editStudentForm');
          if (form) form.style.display = 'none';
        }
      });
    }
  }

  // ---- GLOBAL ASSIGNMENTS MASTER VIEW ---------------------------------------
  function renderGlobalAssignments(filterQuery) {
    var tbody = document.getElementById('globalAssignmentsTableBody');
    if (!tbody) return;

    var rows = [];
    Object.keys(coursesData).forEach(function (cKey) {
      var c = coursesData[cKey];
      if (c.assignments) {
        Object.keys(c.assignments).forEach(function (aId) {
          var a = c.assignments[aId];
          rows.push({
            courseKey: cKey,
            courseCode: c.courseCode || cKey,
            assignId: aId,
            assignNum: a.assignmentNumber || '—',
            assignTitle: a.assignmentTitle || 'Untitled',
            subDate: a.submissionDate || '—',
          });
        });
      }
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No assignments configured across any course.</td></tr>';
      return;
    }

    var q = (filterQuery || '').toLowerCase().trim();
    var filtered = rows.filter(function (r) {
      return !q || r.courseCode.toLowerCase().includes(q) || r.assignTitle.toLowerCase().includes(q);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No assignments matching "' + esc(filterQuery) + '".</td></tr>';
      return;
    }

    var html = '';
    filtered.forEach(function (r) {
      html +=
        '<tr>' +
        '  <td><span class="item-code-badge">' + esc(r.courseCode) + '</span></td>' +
        '  <td><strong>' + esc(r.assignNum) + '</strong></td>' +
        '  <td>' + esc(r.assignTitle) + '</td>' +
        '  <td>' + esc(r.subDate) + '</td>' +
        '  <td style="text-align: right;"><button type="button" class="btn-small-action danger delete-global-assign-btn" data-course="' + esc(r.courseKey) + '" data-assign="' + esc(r.assignId) + '">✕ Delete</button></td>' +
        '</tr>';
    });

    tbody.innerHTML = html;
    tbody.querySelectorAll('.delete-global-assign-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cKey = this.getAttribute('data-course');
        var aId = this.getAttribute('data-assign');
        db.ref('cvr3_courses/' + cKey + '/assignments/' + aId).remove().then(function () {
          showToast('Assignment deleted', '✓');
        });
      });
    });
  }

  // ---- BACKUP & RESTORE -----------------------------------------------------
  function initBackupRestore() {
    var backupBtn = document.getElementById('backupDataBtn');
    var restoreBtn = document.getElementById('restoreDataBtn');
    var fileInput = document.getElementById('jsonFileInput');

    if (backupBtn) {
      backupBtn.addEventListener('click', function () {
        var backup = {
          exportDate: new Date().toISOString(),
          version: '1.0',
          courses: coursesData,
          students: studentsData,
        };
        var dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backup, null, 2));
        var downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute('href', dataStr);
        downloadAnchor.setAttribute('download', 'CU_Academic_Data_Backup_' + new Date().toISOString().split('T')[0] + '.json');
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showToast('Database exported as JSON', '📥');
      });
    }

    if (restoreBtn && fileInput) {
      restoreBtn.addEventListener('click', function () {
        fileInput.click();
      });

      fileInput.addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function (evt) {
          try {
            var data = JSON.parse(evt.target.result);
            if (data.courses && db) {
              db.ref('cvr3_courses').update(data.courses);
            }
            if (data.students && db) {
              db.ref('students').update(data.students);
            }
            showToast('Database restored successfully from JSON!', '✓');
          } catch (err) {
            console.error(err);
            showToast('Invalid JSON file format', '❌');
          }
        };
        reader.readAsText(file);
      });
    }
  }

  // ---- SEARCH BINDINGS ------------------------------------------------------
  function initSearch() {
    var courseInput = document.getElementById('courseSearchInput');
    if (courseInput) {
      courseInput.addEventListener('input', function () {
        renderCoursesCatalog(this.value);
      });
    }

    var studentInput = document.getElementById('studentSearchInput');
    if (studentInput) {
      studentInput.addEventListener('input', function () {
        renderStudentsCatalog(this.value);
      });
    }

    var globalAssignInput = document.getElementById('globalAssignmentSearchInput');
    if (globalAssignInput) {
      globalAssignInput.addEventListener('input', function () {
        renderGlobalAssignments(this.value);
      });
    }
  }

  // ---- Coverpage Admin Gate -------------------------------------------------
  /*
     Two admin surfaces, deliberately separate:

       admin.html   — the coverpage admin. Edits courses, assignments and students
                      in lddb-demo. Anyone the project admin grants `coverAdmin` to.
       console.html — the project admin. Money, wallets, users. One account only.

     Signing in with Google proves *who* you are against LabDDB-Pro; it says nothing
     about lddb-demo, which is a different project entirely. So after sign-in we ask
     our own server for a **custom token** carrying a `coverAdmin` claim (the server
     is the only party holding the lddb-demo service-account key) and sign the
     default app in with it. Every existing db.ref().set() below then runs as an
     authenticated writer, and lddb-demo's rules can stay public-read / auth-write.

     The lock is cosmetic on its own — the rules are what actually stop a write. But
     an unlocked-looking panel whose every save fails is worse than a clear lock.
  */
  function lockScreen(title, message, actionLabel, onAction) {
    var host = document.getElementById('adminLock');
    if (!host) return;
    host.hidden = false;
    host.innerHTML =
      '<div class="admin-lock-card">' +
      '<div class="admin-lock-icon">🔒</div>' +
      '<h2>' + esc(title) + '</h2>' +
      '<p>' + esc(message) + '</p>' +
      (actionLabel
        ? '<button type="button" class="btn btn-primary" id="adminLockBtn">' + esc(actionLabel) + '</button>'
        : '') +
      '</div>';
    var btn = document.getElementById('adminLockBtn');
    if (btn && onAction) btn.onclick = onAction;
  }

  function unlockScreen() {
    var host = document.getElementById('adminLock');
    if (host) {
      host.hidden = true;
      host.innerHTML = '';
    }
  }

  /** Trade for an lddb-demo custom token and sign in so writes work seamlessly. */
  function signInToDataApp() {
    var bridgeApi = (global.LabDDB && global.LabDDB.api ? global.LabDDB.api('/api/cover-token') : '/api/cover-token');
    if (!firebase.apps.length && firebaseConfig) firebase.initializeApp(firebaseConfig);
    
    return fetch(bridgeApi, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.token && typeof firebase !== 'undefined' && firebase.auth) {
          return firebase.auth().signInWithCustomToken(data.token);
        }
      })
      .catch(function (err) {
        console.warn('[admin] background write authorization:', err.message);
      });
  }

  // ---- BOOTSTRAP ------------------------------------------------------------
  var booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    initFirebase();
    initAddCourse();
    initEditCourse();
    initAddStudent();
    initEditStudent();
    initBackupRestore();
    initSearch();
    signInToDataApp();
  }

  function init() {
    initTheme();
    initTabs();
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);

