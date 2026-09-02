/**
 * scripts/test-all.js — Cross-platform test suite runner.
 * -----------------------------------------------------------------------------
 * Runs all unit and integration test suites sequentially and exits with code 1
 * if any suite fails. Works identically on Windows, Linux, and macOS.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'scripts/test-ledger.js',
  'scripts/test-domain.js',
  'scripts/test-provider.js',
  'scripts/test-reconcile.js',
  'scripts/test-audit.js',
];

console.log('============================================================');
console.log('RUNNING ALL PLATFORM TEST SUITES');
console.log('============================================================\n');

let totalFailed = 0;

for (const suite of suites) {
  console.log(`>>> Executing ${suite}...`);
  const fullPath = path.resolve(__dirname, '..', suite);
  const res = spawnSync(process.execPath, [fullPath], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\n[FAIL] Suite ${suite} exited with code ${res.status}\n`);
    totalFailed++;
  } else {
    console.log(`[PASS] ${suite} completed successfully.\n`);
  }
}

console.log('============================================================');
if (totalFailed === 0) {
  console.log('ALL TEST SUITES PASSED SUCCESSFULLY!');
  console.log('============================================================');
  process.exit(0);
} else {
  console.error(`${totalFailed} TEST SUITE(S) FAILED.`);
  console.log('============================================================');
  process.exit(1);
}
