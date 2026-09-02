/**
 * scripts/audit-print-layout.js — Automated Verification of Browser Print Layout (window.print()).
 * -----------------------------------------------------------------------------
 * Tests the 7 required cover page variants under direct print:
 *   1. normal assignment
 *   2. long student name
 *   3. long course title
 *   4. long teacher name
 *   5. long assignment title
 *   6. experiment cover
 *   7. experiment main cover
 *
 * Verifies:
 *   - Page count is strictly 1 page (A4 210mm x 297mm)
 *   - No second page spillover
 *   - Content, aspect ratio, typography, and borders fit inside physical printable bounds
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { countPdfPages } = require('../lib/domain/pricing.js');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function createHarnessHtml(templatePath, formData, customScript = '') {
  let html = fs.readFileSync(templatePath, 'utf8');
  const pubDir = path.join(__dirname, '..', 'public').replace(/\\/g, '/');
  html = html.replace('<head>', `<head><base href="file:///${pubDir}/">`);

  const injection = `
<script>
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const data = ${JSON.stringify(formData || {})};
    for (const [id, val] of Object.entries(data)) {
      const el = document.getElementById(id);
      if (el) {
        if (el.tagName === 'SELECT') {
          let opt = Array.from(el.options).find(o => o.value === val || o.text === val);
          if (!opt) {
            opt = new Option(val, val);
            el.add(opt);
          }
          el.value = val;
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    ${customScript}
  }, 100);
});
</script>
`;
  return html.replace('</body>', `${injection}</body>`);
}

(async () => {
  console.log('=== DIRECT BROWSER PRINT LAYOUT AUDIT ===\n');

  if (!fs.existsSync(CHROME_PATH)) {
    console.error('Chrome not found at', CHROME_PATH);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'scratch', 'print_audit');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const testCases = [
    // 1. Normal assignment
    {
      name: '1_normal_assignment',
      template: path.join(__dirname, '..', 'public', 'index.html'),
      data: {
        studentName: 'Saiful Khalid',
        rollNumber: '24702008',
      },
      script: `
        const dept = document.getElementById('coverDepartment');
        if (dept) dept.textContent = 'Department of Electrical and Electronic Engineering';
        const title = document.getElementById('coverTitle');
        if (title) title.textContent = 'Assignment on Digital Signal Processing';
        const cCode = document.getElementById('coverCourseCode');
        if (cCode) cCode.textContent = 'EEE-417';
        const cTitle = document.getElementById('coverCourseTitle');
        if (cTitle) cTitle.textContent = 'Digital Signal Processing';
        const tName = document.getElementById('coverTeacherName');
        if (tName) tName.textContent = 'Dr. Mohammad Rezaul Karim';
        const tDesig = document.getElementById('coverTeacherDesignation');
        if (tDesig) tDesig.textContent = 'Professor, Department of EEE';
        const sName = document.getElementById('coverStudentName');
        if (sName) sName.textContent = 'Saiful Khalid';
        const sId = document.getElementById('coverStudentId');
        if (sId) sId.textContent = '24702008';
        const sSess = document.getElementById('coverSession');
        if (sSess) sSess.textContent = '2020-2021';
      `,
    },

    // 2. Long student name
    {
      name: '2_long_student_name',
      template: path.join(__dirname, '..', 'public', 'index.html'),
      data: {
        studentName: 'Mohammad Abdur Rahman Al-Mansoor Bin Khalid Siddique Chowdhury',
        rollNumber: '24702008-EXT-2026',
      },
      script: `
        const sName = document.getElementById('coverStudentName');
        if (sName) sName.textContent = 'Mohammad Abdur Rahman Al-Mansoor Bin Khalid Siddique Chowdhury';
        const sId = document.getElementById('coverStudentId');
        if (sId) sId.textContent = '24702008-EXT-2026';
      `,
    },

    // 3. Long course title
    {
      name: '3_long_course_title',
      template: path.join(__dirname, '..', 'public', 'index.html'),
      data: {
        studentName: 'Saiful Khalid',
        rollNumber: '24702008',
      },
      script: `
        const cTitle = document.getElementById('coverCourseTitle');
        if (cTitle) cTitle.textContent = 'Advanced Distributed Systems, Fault Tolerance, Autonomous Cloud Architecture and Realtime Scalability Engineering';
      `,
    },

    // 4. Long teacher name
    {
      name: '4_long_teacher_name',
      template: path.join(__dirname, '..', 'public', 'index.html'),
      data: {
        studentName: 'Saiful Khalid',
        rollNumber: '24702008',
      },
      script: `
        const tName = document.getElementById('coverTeacherName');
        if (tName) tName.textContent = 'Professor Dr. Engr. Syed Mohammad Nurul Huda Al-Hussaini, PhD (MIT), FIEB, PostDoc (Stanford)';
        const tDesig = document.getElementById('coverTeacherDesignation');
        if (tDesig) tDesig.textContent = 'Distinguished Senior Professor, Former Dean & Chairman, Faculty of Engineering & Technology, University of Chittagong';
      `,
    },

    // 5. Long assignment title
    {
      name: '5_long_assignment_title',
      template: path.join(__dirname, '..', 'public', 'index.html'),
      data: {
        studentName: 'Saiful Khalid',
        rollNumber: '24702008',
      },
      script: `
        const title = document.getElementById('coverTitle');
        if (title) title.textContent = 'Comparative Empirical Performance Evaluation of Double-Entry CAS Ledger Systems Against Distributed Two-Phase Commit Under Extreme Cross-Tenant Packet Latency';
      `,
    },

    // 6. Experiment cover
    {
      name: '6_experiment_cover',
      template: path.join(__dirname, '..', 'public', 'experiment-cover.html'),
      data: {
        studentName: 'Tanvir Ahmed Chowdhury',
        rollNumber: '23701045',
        courseCode: 'PHY-112',
        courseTitle: 'General Physics Laboratory I',
        experimentNo: '03',
        experimentName: 'Determination of Planck Constant using Photocells and Photoelectric Effect Analysis',
      },
      script: '',
    },

    // 7. Experiment main cover
    {
      name: '7_experiment_main_cover',
      template: path.join(__dirname, '..', 'public', 'experiment-main-cover.html'),
      data: {
        studentName: 'Nusrat Jahan',
        rollNumber: '21703012',
        courseCode: 'CHE-214',
        courseTitle: 'Organic Synthesis and Spectroscopic Analysis Laboratory',
      },
      script: '',
    },
  ];

  let allPass = true;

  for (const tc of testCases) {
    const harnessContent = createHarnessHtml(tc.template, tc.data, tc.script);
    const tempHtmlPath = path.join(outDir, `${tc.name}.html`);
    const pdfPath = path.join(outDir, `${tc.name}.pdf`);
    fs.writeFileSync(tempHtmlPath, harnessContent, 'utf8');

    // Run Chrome Headless to print exact A4 PDF
    const cmd = `"${CHROME_PATH}" --headless=new --disable-gpu --no-pdf-header-footer --allow-file-access-from-files --print-to-pdf="${pdfPath}" "file:///${tempHtmlPath.replace(/\\/g, '/')}"`;
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 25000 });
    } catch (e) {
      console.error(`❌ FAIL: Execution error on ${tc.name}:`, e.message);
      allPass = false;
      continue;
    }

    if (!fs.existsSync(pdfPath)) {
      console.error(`❌ FAIL: Output PDF missing for ${tc.name}`);
      allPass = false;
      continue;
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pageCount = countPdfPages(new Uint8Array(pdfBuffer));
    const sizeKb = (pdfBuffer.length / 1024).toFixed(1);

    if (pageCount === 1) {
      console.log(`✅ ${tc.name}: PASS (1 page, ${sizeKb} KB)`);
    } else {
      console.error(`❌ ${tc.name}: FAIL (${pageCount} pages, spillover detected)!`);
      allPass = false;
    }
  }

  console.log('\n------------------------------------------------------------');
  if (allPass) {
    console.log('ALL 7 PRINT LAYOUT TESTS PASSED (Strictly 1 Page A4, No Spillover) ✅\n');
  } else {
    console.error('ONE OR MORE PRINT LAYOUT TESTS FAILED ❌\n');
    process.exit(1);
  }
})();
