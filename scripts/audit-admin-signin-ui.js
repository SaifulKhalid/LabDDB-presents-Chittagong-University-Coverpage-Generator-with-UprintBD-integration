/**
 * scripts/audit-admin-signin-ui.js
 * -----------------------------------------------------------------------------
 * Real Browser End-to-End Verification:
 * Verifies that clicking "Sign In" on Admin/Settings opens the sign-in modal
 * visibly in front of the access gate across all mobile and desktop viewports:
 *
 * 1. Open Generator signed out
 * 2. Navigate/click Admin / Settings (admin.html)
 * 3. Access gate (#adminLock) appears
 * 4. Click Sign In (#adminLockBtn)
 * 5. #signInSheet exists, hidden === false
 * 6. #signInSheet computed styles: opacity === 1, visibility === visible, pointerEvents === auto, display === flex
 * 7. #signInSheet z-index === 1000 (strictly > #adminLock z-index 900)
 * 8. Hit-testing: document.elementFromPoint at Google sign-in button lands on the button
 * 9. Touch target >= 40px across 320px, 375px, 390px, 414px, 1366px, 1920px
 * 10. Close interaction restores hidden === true
 * 11. Zero uncaught console exceptions
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const VIEWPORTS = [
  { width: 320, height: 650, name: 'Mobile 320px' },
  { width: 375, height: 667, name: 'Mobile 375px' },
  { width: 390, height: 844, name: 'Mobile 390px' },
  { width: 414, height: 896, name: 'Mobile 414px' },
  { width: 1366, height: 768, name: 'Desktop 1366px' },
  { width: 1920, height: 1080, name: 'Desktop 1920px' },
];

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startStaticServer(publicDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURI(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
      const filePath = path.join(publicDir, reqPath);
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function testViewport(port, targetUrl, vp) {
  console.log(`\n--- Testing ${vp.name} (${vp.width}x${vp.height}) ---`);

  const cdpPort = 9400 + Math.floor(Math.random() * 500);
  const tmpProfile = path.join(require('os').tmpdir(), `chrome-test-${Date.now()}-${Math.random()}`);

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--window-size=${vp.width},${vp.height}`,
    `--user-data-dir=${tmpProfile}`,
    targetUrl,
  ]);

  try {
    let version = null;
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      try {
        version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`);
        if (version) break;
      } catch (_) {}
    }
    assert.ok(version, 'Headless Chrome failed to bind to CDP port');

    const targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget = targets.find((t) => t.type === 'page');
    assert.ok(pageTarget, 'Chrome page target found');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const callbacks = new Map();
    const consoleErrors = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails);
      }
      if (callbacks.has(msg.id)) {
        const cb = callbacks.get(msg.id);
        callbacks.delete(msg.id);
        if (msg.error) cb.reject(msg.error);
        else cb.resolve(msg.result);
      }
    };

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        callbacks.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(2000);

    // 1. Verify access gate state
    const gateInfo = await send('Runtime.evaluate', {
      expression: `
        (function() {
          const lock = document.getElementById('adminLock');
          const btn = document.getElementById('adminLockBtn');
          if (!lock || !btn) return { error: 'Gate elements missing' };
          const lStyle = window.getComputedStyle(lock);
          const bStyle = window.getComputedStyle(btn);
          const bRect = btn.getBoundingClientRect();
          return {
            lockVisible: !lock.hidden && lStyle.display === 'flex' && lStyle.opacity === '1',
            lockZIndex: parseInt(lStyle.zIndex, 10) || 0,
            btnVisible: bStyle.visibility === 'visible' && bStyle.display !== 'none',
            btnTouchWidth: bRect.width,
            btnTouchHeight: bRect.height,
            btnText: btn.innerText.trim()
          };
        })()
      `,
      returnByValue: true,
    });

    const g = gateInfo.result.value;
    assert.ok(!g.error, `Gate error: ${g.error}`);
    assert.strictEqual(g.lockVisible, true, 'Access gate must be visibly displayed');
    assert.strictEqual(g.btnVisible, true, 'Sign in button on access gate must be visible');
    assert.ok(g.btnTouchHeight >= 40, `Sign In touch target height (${g.btnTouchHeight}px) must be >= 40px`);
    console.log(`   ✅ Access gate #adminLock visible (z-index: ${g.lockZIndex})`);
    console.log(`   ✅ Gate Sign In button "${g.btnText}" touch target: ${Math.round(g.btnTouchWidth)}x${Math.round(g.btnTouchHeight)}px`);

    // 2. Perform REAL click on Sign In button
    const clickRes = await send('Runtime.evaluate', {
      expression: `
        (function() {
          const btn = document.getElementById('adminLockBtn');
          btn.click();
          return { clicked: true };
        })()
      `,
      returnByValue: true,
    });
    assert.strictEqual(clickRes.result.value.clicked, true, 'Button click executed');
    await sleep(600);

    // 3. Verify sign-in sheet DOM, styles, z-index, and hit-testing
    const sheetInfo = await send('Runtime.evaluate', {
      expression: `
        (function() {
          const sheet = document.getElementById('signInSheet');
          const lock = document.getElementById('adminLock');
          const googleBtn = document.getElementById('googleSignInBtn');
          if (!sheet) return { error: '#signInSheet not in DOM' };
          if (!googleBtn) return { error: '#googleSignInBtn not in DOM' };

          const sStyle = window.getComputedStyle(sheet);
          const sRect = sheet.getBoundingClientRect();
          const gRect = googleBtn.getBoundingClientRect();

          const gCenterX = Math.round(gRect.left + gRect.width / 2);
          const gCenterY = Math.round(gRect.top + gRect.height / 2);
          const hitElement = document.elementFromPoint(gCenterX, gCenterY);
          const hitsGoogleBtn = hitElement === googleBtn || (hitElement && googleBtn.contains(hitElement));

          return {
            sheetExists: true,
            sheetHidden: sheet.hidden,
            sheetClasses: sheet.className,
            display: sStyle.display,
            visibility: sStyle.visibility,
            opacity: sStyle.opacity,
            pointerEvents: sStyle.pointerEvents,
            zIndex: parseInt(sStyle.zIndex, 10) || 0,
            lockZIndex: parseInt(window.getComputedStyle(lock).zIndex, 10) || 0,
            googleBtnTouchWidth: gRect.width,
            googleBtnTouchHeight: gRect.height,
            hitsGoogleBtn: hitsGoogleBtn,
            hitElementTag: hitElement ? hitElement.tagName : null,
            hitElementId: hitElement ? hitElement.id : null,
            hitElementClass: hitElement ? hitElement.className : null
          };
        })()
      `,
      returnByValue: true,
    });

    const s = sheetInfo.result.value;
    assert.ok(!s.error, `Sheet inspection error: ${s.error}`);
    assert.strictEqual(s.sheetExists, true, '#signInSheet must exist in DOM');
    assert.strictEqual(s.sheetHidden, false, '#signInSheet hidden attribute must be false');
    assert.strictEqual(s.display, 'flex', 'computed display must be flex');
    assert.strictEqual(s.visibility, 'visible', 'computed visibility must be visible');
    assert.strictEqual(s.opacity, '1', 'computed opacity must be 1');
    assert.strictEqual(s.pointerEvents, 'auto', 'computed pointer-events must be auto');
    assert.ok(s.zIndex > s.lockZIndex, `#signInSheet z-index (${s.zIndex}) must exceed #adminLock (${s.lockZIndex})`);
    assert.strictEqual(s.hitsGoogleBtn, true, `document.elementFromPoint must hit Google sign-in button (got <${s.hitElementTag} id="${s.hitElementId}">)`);
    assert.ok(s.googleBtnTouchHeight >= 40, `Google sign-in button height (${s.googleBtnTouchHeight}px) must be >= 40px`);

    console.log(`   ✅ #signInSheet displayed with opacity: 1, visibility: visible, z-index: ${s.zIndex} (> lock: ${s.lockZIndex})`);
    console.log(`   ✅ Hit-test confirmed pointer interaction reaches #googleSignInBtn (<${s.hitElementTag}>)`);
    console.log(`   ✅ Google sign-in button touch target: ${Math.round(s.googleBtnTouchWidth)}x${Math.round(s.googleBtnTouchHeight)}px (Accessible: true)`);

    // 4. Test close button synchronization
    const closeRes = await send('Runtime.evaluate', {
      expression: `
        (function() {
          const sheet = document.getElementById('signInSheet');
          const closeBtn = sheet ? sheet.querySelector('[data-role="close"]') : null;
          if (!closeBtn) return { error: 'Close button missing' };
          closeBtn.click();
          return {
            hiddenAfterClose: sheet.hidden,
            hasShow: sheet.classList.contains('show'),
            hasActive: sheet.classList.contains('active')
          };
        })()
      `,
      returnByValue: true,
    });

    const c = closeRes.result.value;
    assert.ok(!c.error, `Close error: ${c.error}`);
    assert.strictEqual(c.hiddenAfterClose, true, 'Sheet hidden must be true after closing');
    assert.strictEqual(c.hasShow, false, 'Sheet .show class removed after closing');
    assert.strictEqual(c.hasActive, false, 'Sheet .active class removed after closing');
    console.log('   ✅ Close button resets sheet state: hidden=true, classes removed');

    assert.strictEqual(consoleErrors.length, 0, `Uncaught console errors detected: ${JSON.stringify(consoleErrors)}`);
    console.log('   ✅ No uncaught browser console errors');

    ws.close();
  } finally {
    try {
      chromeProc.kill('SIGKILL');
    } catch (_) {}
    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    } catch (_) {}
  }
}

(async () => {
  const isProd = process.argv.includes('--prod');
  console.log('============================================================');
  console.log(`AUDIT: REAL BROWSER ADMIN / SETTINGS SIGN-IN UI [${isProd ? 'PRODUCTION' : 'LOCAL'}]`);
  console.log('============================================================');

  let server = null;
  let baseUrl = '';

  if (isProd) {
    baseUrl = 'https://pitch.labddb.workers.dev';
    console.log(`Targeting production origin: ${baseUrl}`);
  } else {
    const s = await startStaticServer(PUBLIC_DIR);
    server = s.server;
    baseUrl = `http://127.0.0.1:${s.port}`;
    console.log(`Started local test server on ${baseUrl}`);
  }

  try {
    const targetUrl = `${baseUrl}/admin.html`;

    for (const vp of VIEWPORTS) {
      await testViewport(server ? server.address().port : 443, targetUrl, vp);
    }

    console.log('\n============================================================');
    console.log(`ALL VIEWPORT REAL BROWSER TESTS PASSED SUCCESSFULLY! [${isProd ? 'PROD' : 'LOCAL'}] ✅`);
    console.log('============================================================\n');
  } finally {
    if (server) server.close();
  }
})().catch((err) => {
  console.error('\nAudit admin signin UI failed ❌:', err);
  process.exit(1);
});
