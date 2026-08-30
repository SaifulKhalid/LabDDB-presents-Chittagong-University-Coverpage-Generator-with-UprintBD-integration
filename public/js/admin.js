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

  // ---- DOM Lookup Helper ----------------------------------------------------
  var domCache = {};
  function qs(id) {
    if (!id) return null;
    if (!domCache[id] || !domCache[id].isConnected) {
      domCache[id] = document.getElementById(id);
    }
    return domCache[id];
  }

  // ---- Toast Notification ---------------------------------------------------
  function showToast(message, icon) {
    var container = qs('toastContainer');
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

    var toggleBtn = qs('themeToggleBtn');
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
    var nav = qs('adminTabsNav');
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
      var isSelected = b.getAttribute('data-tab') === tabId;
      b.classList.toggle('active', isSelected);
      b.setAttribute('aria-selected', isSelected ? 'true' : 'false');
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

    var pane = qs(paneMap[tabId]);
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
        var dot = qs('dbDot');
        var text = qs('dbStatusText');
        if (dot && text) {
          dot.className = isConnected ? 'pulse-dot up' : 'pulse-dot down';
          text.textContent = isConnected ? 'Database Live' : 'Disconnected';
        }
      });

      // Realtime metadata / stats listener
      db.ref('cvr3_meta/stats/coverpageCount').on('value', function (snap) {
        var count = Number(snap.val()) || 0;
        var el = qs('metricTotalGenerated');
        if (el) el.textContent = count.toLocaleString();
        var elBadge = document.getElementById('coverpageLiveCount');
        if (elBadge) {
          if (count > 0) {
            elBadge.textContent = '⚡ ' + count.toLocaleString() + ' covers generated';
          } else {
            elBadge.textContent = '⚡ Live CU Synced';
          }
        }
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

    var totalEl = qs('metricTotalCourses');
    var labEl = qs('metricTotalLabs');
    if (totalEl) totalEl.textContent = keys.length;
    if (labEl) labEl.textContent = labCount;
  }

  function updateStudentsMetrics() {
    var keys = Object.keys(studentsData);
    var el = qs('metricTotalStudents');
    if (el) el.textContent = keys.length;
  }

  // ---- COURSES TAB ----------------------------------------------------------
  function renderCoursesCatalog(filterQuery) {
    var container = qs('courseCatalogGrid');
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

  // Official Chittagong University Faculties & 48 Departments
  var CU_FACULTIES = [
    {
      faculty: 'Faculty of Engineering',
      departments: [
        'Electrical and Electronic Engineering',
        'Computer Science & Engineering',
      ],
    },
    {
      faculty: 'Faculty of Science',
      departments: [
        'Physics',
        'Chemistry',
        'Mathematics',
        'Statistics',
        'Applied Chemistry and Chemical Engineering',
        'Forestry and Environmental Sciences',
        'Jamal Nazrul Islam Center for Advanced Research (JNICAR)',
      ],
    },
    {
      faculty: 'Faculty of Arts and Humanities',
      departments: [
        'Bangla',
        'English',
        'History',
        'Philosophy',
        'Islamic History and Culture',
        'Arabic',
        'Islamic Studies',
        'Dramatics',
        'Institute of Modern Languages',
        'Institute of Fine Arts',
        'Persian Language & Literature',
        'Pali',
        'Sanskrit',
        'Music',
        'Bangladesh Studies',
      ],
    },
    {
      faculty: 'Faculty of Business Administration',
      departments: [
        'Accounting',
        'Management',
        'Finance',
        'Marketing',
        'Human Resource Management',
        'Banking and Insurance',
        'Chittagong University Center for Business Administration',
        'Bureau of Business Research',
      ],
    },
    {
      faculty: 'Faculty of Social Sciences',
      departments: [
        'Economics',
        'Political Science',
        'Sociology',
        'Public Administration',
        'Anthropology',
        'International Relations',
        'Communication and Journalism',
        'Criminology and Police Science',
        'Development Studies',
        'Social Science Research Center',
      ],
    },
    {
      faculty: 'Faculty of Biological Sciences',
      departments: [
        'Zoology',
        'Botany',
        'Geography and Environmental Studies',
        'Biochemistry and Molecular Biology',
        'Microbiology',
        'Soil Science',
        'Genetic Engineering and Biotechnology',
        'Psychology',
        'Pharmacy',
      ],
    },
    {
      faculty: 'Faculty of Law',
      departments: [
        'Law',
      ],
    },
    {
      faculty: 'Faculty of Education',
      departments: [
        'Physical Education and Sports Science',
        'Institute of Education and Research',
      ],
    },
    {
      faculty: 'Faculty of Marine Sciences and Fisheries',
      departments: [
        'Marine Sciences',
        'Oceanography',
        'Fisheries',
      ],
    },
    {
      faculty: 'Faculty of Medicine',
      departments: [
        'Paediatrics',
        'Community Ophthalmology',
      ],
    },
  ];

  var CU_DESIGNATIONS = [
    'Professor',
    'Associate Professor',
    'Assistant Professor',
    'Lecturer',
    'Professor & Chairman',
    'Professor & Head',
    'Associate Professor & Head',
    'Assistant Professor & Head',
    'Adjunct Faculty',
  ];

  function normalizeDepartment(d) {
    if (!d) return '';
    var lower = d.toLowerCase().replace(/^dept\.\s*of\s*/i, '').replace(/^department\s*of\s*/i, '').trim();
    if (lower === 'eee') return 'Electrical and Electronic Engineering';
    if (lower === 'cse') return 'Computer Science & Engineering';
    return d.trim();
  }

  function buildDepartmentOptionsHtml(selectedVal) {
    var sVal = (selectedVal || '').trim();
    var norm = normalizeDepartment(sVal);
    var isMatched = false;
    var html = '';

    CU_FACULTIES.forEach(function (g) {
      html += '<optgroup label="' + esc(g.faculty) + '">';
      g.departments.forEach(function (d) {
        var isSelected = false;
        if (!isMatched && (d.toLowerCase() === norm.toLowerCase() || d.toLowerCase() === sVal.toLowerCase())) {
          isSelected = true;
          isMatched = true;
        }
        html += '<option value="' + esc(d) + '"' + (isSelected ? ' selected' : '') + '>' + esc(d) + '</option>';
      });
      html += '</optgroup>';
    });

    var isOther = Boolean(sVal && !isMatched);
    html += '<option value="__OTHER__"' + (isOther ? ' selected' : '') + '>Other / Custom Department…</option>';
    return { html: html, isOther: isOther, customVal: isOther ? sVal : '' };
  }

  function buildDesignationOptionsHtml(selectedVal) {
    var sVal = (selectedVal || '').trim();
    var isMatched = false;
    var html = '';

    CU_DESIGNATIONS.forEach(function (desig) {
      var isSelected = false;
      if (!isMatched && desig.toLowerCase() === sVal.toLowerCase()) {
        isSelected = true;
        isMatched = true;
      }
      html += '<option value="' + esc(desig) + '"' + (isSelected ? ' selected' : '') + '>' + esc(desig) + '</option>';
    });

    var isOther = Boolean(sVal && !isMatched);
    html += '<option value="__OTHER__"' + (isOther ? ' selected' : '') + '>Other / Custom Designation…</option>';
    return { html: html, isOther: isOther, customVal: isOther ? sVal : '' };
  }

  function populateAllDepartmentSelects() {
    ['addCourseDept', 'editCourseDept', 'addStudentDept', 'editStudentDept'].forEach(function (id) {
      var sel = qs(id);
      if (!sel) return;
      var curVal = sel.value;
      var optInfo = buildDepartmentOptionsHtml(curVal || 'Electrical and Electronic Engineering');
      sel.innerHTML = optInfo.html;
    });
  }

  // Dynamic Faculty Row Helper
  function createFacultyRow(fData) {
    var f = fData || {};
    var row = document.createElement('div');
    row.className = 'faculty-form-row';

    var desigVal = f.designation || f.title || 'Professor';
    var deptVal = f.department || 'Electrical and Electronic Engineering';

    var desigInfo = buildDesignationOptionsHtml(desigVal);
    var deptInfo = buildDepartmentOptionsHtml(deptVal);

    row.innerHTML =
      '<div class="fm-field-col">' +
        '<input type="text" class="form-input fm-name" placeholder="Faculty Name (e.g. Dr. Md. Rahman)" value="' + esc(f.name || '') + '" required />' +
      '</div>' +
      '<div class="fm-field-col">' +
        '<select class="form-input fm-desig-select">' + desigInfo.html + '</select>' +
        '<input type="text" class="form-input fm-desig-custom" placeholder="Type designation" value="' + esc(desigInfo.customVal) + '" style="margin-top:6px; display:' + (desigInfo.isOther ? 'block' : 'none') + ';" />' +
      '</div>' +
      '<div class="fm-field-col">' +
        '<select class="form-input fm-dept-select">' + deptInfo.html + '</select>' +
        '<input type="text" class="form-input fm-dept-custom" placeholder="Type dept (e.g. Dept. of ME)" value="' + esc(deptInfo.customVal) + '" style="margin-top:6px; display:' + (deptInfo.isOther ? 'block' : 'none') + ';" />' +
      '</div>' +
      '<button type="button" class="btn-icon-danger fm-remove-btn" title="Remove faculty member">✕</button>';

    var desigSelect = row.querySelector('.fm-desig-select');
    var desigCustom = row.querySelector('.fm-desig-custom');
    var deptSelect = row.querySelector('.fm-dept-select');
    var deptCustom = row.querySelector('.fm-dept-custom');

    desigSelect.addEventListener('change', function () {
      if (this.value === '__OTHER__') {
        desigCustom.style.display = 'block';
        desigCustom.focus();
      } else {
        desigCustom.style.display = 'none';
      }
    });

    deptSelect.addEventListener('change', function () {
      if (this.value === '__OTHER__') {
        deptCustom.style.display = 'block';
        deptCustom.focus();
      } else {
        deptCustom.style.display = 'none';
      }
    });

    row.querySelector('.fm-remove-btn').addEventListener('click', function () {
      if (row.parentNode) row.parentNode.removeChild(row);
    });
    return row;
  }

  function getFacultyFromRow(r) {
    var name = (r.querySelector('.fm-name') ? r.querySelector('.fm-name').value : '').trim();
    var desigSelect = r.querySelector('.fm-desig-select');
    var desigCustom = r.querySelector('.fm-desig-custom');
    var desig = '';
    if (desigSelect) {
      desig = desigSelect.value === '__OTHER__' ? (desigCustom ? desigCustom.value.trim() : '') : desigSelect.value.trim();
    }
    if (!desig) desig = 'Faculty Member';

    var deptSelect = r.querySelector('.fm-dept-select');
    var deptCustom = r.querySelector('.fm-dept-custom');
    var fDept = '';
    if (deptSelect) {
      fDept = deptSelect.value === '__OTHER__' ? (deptCustom ? deptCustom.value.trim() : '') : deptSelect.value.trim();
    }
    if (!fDept) fDept = 'Electrical and Electronic Engineering';

    return { name: name, designation: desig, department: fDept };
  }

  // ---- ADD COURSE -----------------------------------------------------------
  function initAddCourse() {
    var container = qs('addFacultyContainer');
    var addFmBtn = qs('addMoreFacultyBtn');
    var form = qs('addCourseForm');

    if (container && addFmBtn) {
      // Default 1 faculty member
      container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: 'Electrical and Electronic Engineering' }));

      addFmBtn.addEventListener('click', function () {
        if (container.children.length < 4) {
          var defaultDept = qs('addCourseDept') ? qs('addCourseDept').value : 'Electrical and Electronic Engineering';
          container.appendChild(createFacultyRow({ name: '', designation: 'Assistant Professor', department: defaultDept }));
        } else {
          showToast('Maximum 4 faculty members allowed', '⚠️');
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = qs('addCourseCode').value.trim().toUpperCase().replace(/\s+/g, '');
        var title = qs('addCourseTitle').value.trim();
        var dept = qs('addCourseDept').value;
        var type = qs('addCourseType').value;
        var sem = qs('addSemesterText').value.trim();

        if (!code || !title) {
          showToast('Please fill in Course Code and Title', '⚠️');
          return;
        }

        // Collect faculty members
        var facultyList = [];
        container.querySelectorAll('.faculty-form-row').forEach(function (r) {
          var fm = getFacultyFromRow(r);
          if (fm.name) {
            facultyList.push(fm);
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
          container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: 'Electrical and Electronic Engineering' }));
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
    var select = qs('selectCourseToEdit');
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
    var select = qs('selectCourseToEdit');
    if (select) {
      select.value = code;
      loadCourseIntoEditForm(code);
    }
  }

  function loadCourseIntoEditForm(code) {
    var c = coursesData[code];
    if (!c) return;
    currentEditCourseKey = code;

    var form = qs('editCourseForm');
    if (!form) return;
    form.style.display = 'block';

    qs('editCourseCode').value = c.courseCode || code;
    qs('editCourseTitle').value = c.courseTitle || '';
    qs('editCourseDept').value = c.department || 'Electrical and Electronic Engineering';
    qs('editCourseType').value = c.courseType || 'lab';
    qs('editSemesterText').value = c.semesterText || '';

    // Faculty members
    var container = qs('editFacultyContainer');
    container.innerHTML = '';
    var faculty = Array.isArray(c.facultyMembers) ? c.facultyMembers : (c.teacher ? [c.teacher] : []);
    if (faculty.length) {
      faculty.forEach(function (f) {
        container.appendChild(createFacultyRow(f));
      });
    } else {
      var courseDept = c.department || 'Electrical and Electronic Engineering';
      container.appendChild(createFacultyRow({ name: '', designation: 'Professor', department: courseDept }));
    }

    // Sub-sections
    var isLab = (c.courseType || 'lab') === 'lab';
    var expSection = qs('subExperimentsSection');
    var assignSection = qs('subAssignmentsSection');

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
    var select = qs('selectCourseToEdit');
    if (select) {
      select.addEventListener('change', function () {
        if (this.value) {
          loadCourseIntoEditForm(this.value);
        } else {
          var form = qs('editCourseForm');
          if (form) form.style.display = 'none';
          qs('subExperimentsSection').style.display = 'none';
          qs('subAssignmentsSection').style.display = 'none';
        }
      });
    }

    var addFmBtn = qs('editMoreFacultyBtn');
    var container = qs('editFacultyContainer');
    if (addFmBtn && container) {
      addFmBtn.addEventListener('click', function () {
        if (container.children.length < 4) {
          var defaultDept = qs('editCourseDept') ? qs('editCourseDept').value : 'Electrical and Electronic Engineering';
          container.appendChild(createFacultyRow({ name: '', designation: 'Assistant Professor', department: defaultDept }));
        } else {
          showToast('Maximum 4 faculty members allowed', '⚠️');
        }
      });
    }

    var form = qs('editCourseForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;

        var title = qs('editCourseTitle').value.trim();
        var dept = qs('editCourseDept').value;
        var type = qs('editCourseType').value;
        var sem = qs('editSemesterText').value.trim();

        var facultyList = [];
        container.querySelectorAll('.faculty-form-row').forEach(function (r) {
          var fm = getFacultyFromRow(r);
          if (fm.name) {
            facultyList.push(fm);
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

    var deleteBtn = qs('deleteCurrentCourseBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (currentEditCourseKey) {
          deleteCourse(currentEditCourseKey);
        }
      });
    }

    // Sub-manager: Add Experiment
    var addExpForm = qs('addExperimentForm');
    if (addExpForm) {
      addExpForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;
        var num = qs('newExpNum').value.trim();
        var title = qs('newExpTitle').value.trim();
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
    var addAssignForm = qs('addCourseAssignmentForm');
    if (addAssignForm) {
      addAssignForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditCourseKey) return;
        var num = qs('newAssignNum').value.trim();
        var title = qs('newAssignTitle').value.trim();
        var date = qs('newAssignDate').value;
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
    var tbody = qs('courseExperimentsList');
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
    var tbody = qs('courseAssignmentsList');
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
          var form = qs('editCourseForm');
          if (form) form.style.display = 'none';
        }
      }).catch(function (err) {
        showToast('Delete failed: ' + err.message, '❌');
      });
    }
  }

  // ---- STUDENTS TAB ---------------------------------------------------------
  function renderStudentsCatalog(filterQuery) {
    var container = qs('studentCatalogGrid');
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
    var form = qs('addStudentForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var roll = qs('addStudentRoll').value.trim();
      var name = qs('addStudentName').value.trim();
      var dept = qs('addStudentDept').value;
      var session = qs('addStudentSession').value.trim();

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
    var select = qs('selectStudentToEdit');
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
    var select = qs('selectStudentToEdit');
    if (select) {
      select.value = roll;
      loadStudentIntoEditForm(roll);
    }
  }

  function loadStudentIntoEditForm(roll) {
    var s = studentsData[roll];
    if (!s) return;
    currentEditStudentKey = roll;

    var form = qs('editStudentForm');
    if (!form) return;
    form.style.display = 'block';

    qs('editStudentRoll').value = s.studentId || roll;
    qs('editStudentName').value = s.fullName || s.name || '';
    qs('editStudentDept').value = s.department || 'Electrical and Electronic Engineering';
    qs('editStudentSession').value = s.session || '';
  }

  function initEditStudent() {
    var select = qs('selectStudentToEdit');
    if (select) {
      select.addEventListener('change', function () {
        if (this.value) {
          loadStudentIntoEditForm(this.value);
        } else {
          var form = qs('editStudentForm');
          if (form) form.style.display = 'none';
        }
      });
    }

    var form = qs('editStudentForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentEditStudentKey) return;

        var name = qs('editStudentName').value.trim();
        var dept = qs('editStudentDept').value;
        var session = qs('editStudentSession').value.trim();

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

    var deleteBtn = qs('deleteStudentBtn');
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
          var form = qs('editStudentForm');
          if (form) form.style.display = 'none';
        }
      });
    }
  }

  // ---- GLOBAL ASSIGNMENTS MASTER VIEW ---------------------------------------
  function renderGlobalAssignments(filterQuery) {
    var tbody = qs('globalAssignmentsTableBody');
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
    var backupBtn = qs('backupDataBtn');
    var restoreBtn = qs('restoreDataBtn');
    var fileInput = qs('jsonFileInput');

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
    var courseInput = qs('courseSearchInput');
    if (courseInput) {
      courseInput.addEventListener('input', function () {
        renderCoursesCatalog(this.value);
      });
    }

    var studentInput = qs('studentSearchInput');
    if (studentInput) {
      studentInput.addEventListener('input', function () {
        renderStudentsCatalog(this.value);
      });
    }

    var globalAssignInput = qs('globalAssignmentSearchInput');
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
    var host = qs('adminLock');
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
    var btn = qs('adminLockBtn');
    if (btn && onAction) btn.onclick = onAction;
  }

  function unlockScreen() {
    var host = qs('adminLock');
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
    populateAllDepartmentSelects();
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

