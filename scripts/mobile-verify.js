/**
 * mobile-verify.js — static verification. No network, no credentials, no browser.
 * -----------------------------------------------------------------------------
 *   1. JS syntax across the WHOLE project (node --check), discovered by reading
 *      the directories rather than from a hardcoded list — the 1.0 version of
 *      this script listed six files by hand and silently stopped covering the
 *      ones 2.0 added.
 *   2. Mobile/responsive markup on every page, with per-page expectations.
 *   3. The script load-order contract: labddb-config.js before labddb-auth.js.
 *   4. The CSS rules the mobile layout depends on.
 *
 * Exit code is non-zero if anything fails, so it is CI-friendly.
 *   node scripts/mobile-verify.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

console.log('=== MissionUprint static verification ===\n');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

let errors = 0;
const fail = (msg, extra) => {
  errors += 1;
  if (extra === undefined) console.error(`   FAIL ${msg}`);
  else console.error(`   FAIL ${msg}`, extra);
};
const pass = (msg) => console.log(`   ok   ${msg}`);

/* -- 1. JS syntax, everywhere ---------------------------------------------- */
// Directory-driven: a file added tomorrow is checked without editing this list.
console.log('1. JavaScript syntax (node --check):');

const jsTargets = ['server.js'];
for (const dir of ['lib', 'src', 'scripts', 'public/js']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).sort()) {
    if (f.endsWith('.js')) jsTargets.push(`${dir}/${f}`);
  }
}

/**
 * `node --check` parses a .js file as CommonJS unless package.json declares
 * "type": "module". This project is CommonJS *except* src/worker.js, which must
 * be ESM because that is the Workers module format — so checking it directly
 * fails with "Cannot use import statement outside a module" on Node 20.
 *
 * A .mjs copy is unambiguously a module on every supported version. Detecting
 * ESM loosely is safe here: `require`/`module.exports` are valid syntax inside a
 * module, so a false positive still parses, while a false negative would break.
 */
function checkSyntax(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  let target = abs;
  let tmp = null;

  if (/^\s*(?:import|export)\b/m.test(src)) {
    tmp = path.join(os.tmpdir(), `labddb-check-${Date.now()}-${path.basename(rel)}.mjs`);
    fs.writeFileSync(tmp, src);
    target = tmp;
  }

  const res = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (tmp) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
  }
  return res;
}

let syntaxOk = 0;
for (const rel of jsTargets) {
  const res = checkSyntax(rel);
  if (res.status === 0) syntaxOk += 1;
  else fail(`${rel}\n${res.stderr}`);
}
if (syntaxOk === jsTargets.length) pass(`all ${syntaxOk} JS files parse`);
else console.log(`   (${syntaxOk}/${jsTargets.length} parsed)`);

/* -- 2. Page markup -------------------------------------------------------- */
// Generators carry the full mobile chrome. The two admin surfaces are different
// shapes on purpose: admin.html has the nav, console.html navigates by tabs and
// scrolls wide tables in wrappers.
const GENERATOR_CHROME = ['mobile-nav', 'preview-floating-dock', 'modal-drag-handle', 'history-drawer'];
const PAGE_CHECKS = {
  'index.html': GENERATOR_CHROME,
  'experiment-cover.html': GENERATOR_CHROME,
  'experiment-main-cover.html': GENERATOR_CHROME,
  'experiment-index.html': GENERATOR_CHROME,
  'admin.html': ['mobile-nav'],
  'console.html': ['console-tabs', 'console-table-wrap'],
};

console.log('\n2. Page markup:');
const pageSource = {};
for (const [page, required] of Object.entries(PAGE_CHECKS)) {
  const abs = path.join(PUBLIC_DIR, page);
  if (!fs.existsSync(abs)) {
    fail(`missing page: ${page}`);
    continue;
  }
  const html = fs.readFileSync(abs, 'utf8');
  pageSource[page] = html;

  const missing = [];
  if (!/<meta\s+name=["']viewport["']/i.test(html)) missing.push('viewport');
  for (const cls of required) {
    if (!html.includes(`class="${cls}"`)) missing.push(cls);
  }

  if (missing.length) fail(`${page} missing`, missing);
  else pass(`${page} (viewport, ${required.join(', ')})`);
}

/* -- 3. Load-order contract ------------------------------------------------ */
// labddb-auth.js reads window.LabDDB on entry and bails out if the config has
// not loaded, so getting this backwards disables sign-in silently.
console.log('\n3. Script load order (labddb-config.js before labddb-auth.js):');
for (const [page, html] of Object.entries(pageSource)) {
  const cfg = html.indexOf('js/labddb-config.js');
  const auth = html.indexOf('js/labddb-auth.js');
  if (cfg === -1) fail(`${page} never loads labddb-config.js`);
  else if (auth === -1) fail(`${page} never loads labddb-auth.js`);
  else if (cfg > auth) fail(`${page} loads labddb-auth.js before labddb-config.js`);
  else pass(`${page}`);
}

/* -- 4. Responsive CSS ----------------------------------------------------- */
console.log('\n4. Responsive CSS rules:');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'styles.css'), 'utf8');
for (const pat of [
  '--safe-top',
  '100dvh',
  'preview-floating-dock',
  'modal-drag-handle',
  '@media (max-width: 640px)',
  'font-size: 16px !important', // iOS zooms any input below 16px on focus
]) {
  if (css.includes(pat)) pass(`styles.css contains "${pat}"`);
  else fail(`styles.css missing "${pat}"`);
}

console.log('\n----------------------------------------');
if (errors === 0) {
  console.log('STATIC VERIFICATION PASSED ✅');
  console.log(`(${jsTargets.length} JS files, ${Object.keys(pageSource).length} pages)\n`);
} else {
  console.error(`STATIC VERIFICATION FAILED ❌ — ${errors} issue${errors === 1 ? '' : 's'}.\n`);
  process.exit(1);
}
