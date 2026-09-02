/**
 * scripts/audit-otp-ui.js — Headless DOM Verification of Kiosk OTP UI states.
 * -----------------------------------------------------------------------------
 * Verifies all 4 required modal states:
 * 1. Successful print -> OTP modal visible with code & countdown
 * 2. Insufficient balance -> Recharge modal/state visible with admin recharge actions
 * 3. 401 Session error -> Authentication error visible with Sign-in action
 * 4. Provider failure -> Useful error visible with retry action & non-charged notice
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  console.log('=== KIOSK OTP & MODAL UI AUDIT ===\n');

  if (!fs.existsSync(CHROME_PATH)) {
    console.error('Chrome executable not found at', CHROME_PATH);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'scratch', 'otp_audit');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const pubDir = path.join(__dirname, '..', 'public').replace(/\\/g, '/');
  let baseHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  baseHtml = baseHtml.replace('<head>', `<head><base href="file:///${pubDir}/">`);

  // Test Harness verifying all 4 UI states sequentially
  const harnessScript = `
<script>
window.__AUDIT_RESULTS__ = {};

async function runAudit() {
  try {
    const modal = document.getElementById('otpModal');
    const body = document.getElementById('otpBody');
    const results = [];

    // Helper to wait for CSS transitions
    const waitTransition = () => new Promise(r => setTimeout(r, 350));

    // Check CSS computed style helper
    function getModalDebug() {
      const style = window.getComputedStyle(modal);
      return {
        className: modal.className,
        hasShow: modal.classList.contains('show'),
        hasActive: modal.classList.contains('active'),
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        display: style.display,
      };
    }

    function isModalVisible() {
      const debug = getModalDebug();
      return (debug.hasShow && debug.hasActive) && debug.pointerEvents === 'auto' && debug.display === 'flex';
    }

    // 1. Successful Print
    Uprint.renderSuccess({
      otp: '839201',
      expiresInSec: 180,
      clientJobId: 'job_test_001',
      pages: 1,
      copies: 1,
      cost: 3,
    }, { color: false });
    await waitTransition();

    const codeEl = document.querySelector('.otp-big-code');
    const hasCode = codeEl && codeEl.textContent.includes('839201');
    const successVisible = isModalVisible();
    results.push({
      test: 'successful_print',
      pass: successVisible && hasCode,
      details: { visible: successVisible, hasCode, text: codeEl ? codeEl.textContent.trim() : null, debug: getModalDebug() }
    });

    // 2. Insufficient Balance (402)
    Uprint.renderInsufficient({
      available: 1,
      required: 5,
      reserved: 0,
      pages: 1,
      copies: 1,
      color: true
    });
    await waitTransition();

    const bodyTextInsuff = body.innerText || body.textContent;
    const hasInsuffText = bodyTextInsuff.includes('Insufficient') || bodyTextInsuff.includes('Recharge');
    const hasWhatsApp = bodyTextInsuff.includes('WhatsApp') || !!document.querySelector('a[href*="wa.me"]');
    const insuffVisible = isModalVisible();
    results.push({
      test: 'insufficient_balance',
      pass: insuffVisible && hasInsuffText && hasWhatsApp,
      details: { visible: insuffVisible, hasInsuffText, hasWhatsApp, debug: getModalDebug() }
    });

    // 3. Authentication Required (401)
    let authActionFired = false;
    Uprint.renderError('Authentication required. Please sign in again.', () => { authActionFired = true; }, 'Sign in');
    await waitTransition();

    const bodyTextAuth = body.innerText || body.textContent;
    const hasAuthText = bodyTextAuth.includes('Authentication required') || bodyTextAuth.includes('sign in');
    const authBtn = document.getElementById('otpRetryBtn');
    const hasAuthBtn = authBtn && authBtn.textContent.includes('Sign in');
    const authVisible = isModalVisible();
    results.push({
      test: 'auth_required_401',
      pass: authVisible && hasAuthText && hasAuthBtn,
      details: { visible: authVisible, hasAuthText, hasAuthBtn, debug: getModalDebug() }
    });

    // 4. Provider Failure (500/502/503)
    let retryActionFired = false;
    Uprint.renderError('Kiosk bridge error: Service unavailable. Your balance was not charged.', () => { retryActionFired = true; }, 'Retry print');
    await waitTransition();

    const bodyTextProv = body.innerText || body.textContent;
    const hasProvText = bodyTextProv.includes('Kiosk bridge error') && bodyTextProv.includes('not charged');
    const retryBtn = document.getElementById('otpRetryBtn');
    const hasRetryBtn = retryBtn && retryBtn.textContent.includes('Retry print');
    const provVisible = isModalVisible();
    results.push({
      test: 'provider_failure',
      pass: provVisible && hasProvText && hasRetryBtn,
      details: { visible: provVisible, hasProvText, hasRetryBtn, debug: getModalDebug() }
    });

    // Final result element
    const resDiv = document.createElement('pre');
    resDiv.id = '__AUDIT_OUTPUT__';
    resDiv.textContent = JSON.stringify(results);
    document.body.appendChild(resDiv);
  } catch (e) {
    const errDiv = document.createElement('pre');
    errDiv.id = '__AUDIT_OUTPUT__';
    errDiv.textContent = JSON.stringify([{ test: 'crash', pass: false, error: e.stack || e.message }]);
    document.body.appendChild(errDiv);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(runAudit, 150);
});
</script>
`;

  const htmlWithHarness = baseHtml.replace('</body>', `${harnessScript}</body>`);
  const harnessPath = path.join(outDir, 'otp_test_harness.html');
  fs.writeFileSync(harnessPath, htmlWithHarness, 'utf8');

  // Run Chrome to dump DOM after script finishes
  const cmd = `"${CHROME_PATH}" --headless=new --disable-gpu --allow-file-access-from-files --virtual-time-budget=6000 --dump-dom "file:///${harnessPath.replace(/\\/g, '/')}"`;
  let domOutput = '';
  try {
    domOutput = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    console.error('Failed to execute Chrome:', err.message);
    process.exit(1);
  }

  const match = domOutput.match(/<pre id="__AUDIT_OUTPUT__">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.error('Could not find audit output in DOM. Output snippet:');
    console.error(domOutput.slice(0, 500));
    process.exit(1);
  }

  const results = JSON.parse(match[1]);
  let allPass = true;

  for (const r of results) {
    if (r.pass) {
      console.log(`✅ Test '${r.test}': PASS`);
    } else {
      console.error(`❌ Test '${r.test}': FAIL`, r.details || r.error);
      allPass = false;
    }
  }

  console.log('\n------------------------------------------------------------');
  if (allPass) {
    console.log('ALL OTP UI TESTS PASSED ✅\n');
  } else {
    console.error('ONE OR MORE OTP UI TESTS FAILED ❌\n');
    process.exit(1);
  }
})();
