/**
 * scripts/audit-secrets.js — Secret Hygiene and Leak Detector.
 * -----------------------------------------------------------------------------
 * Scans all tracked git files and unstaged modifications for real secret values.
 */

'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const patterns = [
  { name: 'Unredacted RSA Private Key', regex: /-----BEGIN (RSA )?PRIVATE KEY-----\s*[^-]{20,}/ },
  { name: 'Committed Service Account JSON', regex: /"private_key":\s*"-----BEGIN/ },
  { name: 'Hardcoded Uprint Password', regex: /UPRINT_PASSWORD\s*=\s*['"]?[a-zA-Z0-9!@#$%^&*()_+]{5,}['"]?/ },
  { name: 'Hardcoded Live SessionID', regex: /sessionid=[a-zA-Z0-9]{20,}/ },
];

(async () => {
  console.log('=== SECRET HYGIENE AUDIT ===\n');

  const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  let leaks = 0;

  for (const f of files) {
    if (f === '.env.example') continue; // Skip example template with dummy values
    let content = '';
    try {
      if (fs.existsSync(f)) {
        content = fs.readFileSync(f, 'utf8');
      } else {
        content = execSync(`git show HEAD:"${f}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (_) {
      continue;
    }

    for (const p of patterns) {
      if (p.regex.test(content)) {
        console.error(`❌ Potential leak detected in ${f}: matches ${p.name}`);
        leaks++;
      }
    }
  }

  if (leaks === 0) {
    console.log(`Audited ${files.length} tracked files.`);
    console.log('✅ SECRET HYGIENE AUDIT PASSED: Zero secrets detected in git-tracked files.\n');
  } else {
    console.error(`❌ FAIL: Found ${leaks} potential leaks!`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
