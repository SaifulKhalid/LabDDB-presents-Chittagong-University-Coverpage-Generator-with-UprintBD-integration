/**
 * scripts/test-provider.js — Comprehensive tests for UprintBDAdapter & scrapers.
 * -----------------------------------------------------------------------------
 * Uses local fixtures (_print_history.html, etc.) to verify parser robustness
 * without needing live network access or real credentials.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { CookieJar } = require('../lib/infrastructure/uprint/cookie-jar.js');
const { SessionQueue } = require('../lib/infrastructure/uprint/session-queue.js');
const {
  cellText,
  extractCsrfInput,
  parseBalance,
  parseCountdownCell,
  parseQueuedRecordIds,
  parsePrintHistory,
  dhakaDate,
} = require('../lib/infrastructure/uprint/parsers.js');
const { UprintBDAdapter } = require('../lib/infrastructure/uprint/adapter.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

(async () => {
  console.log('\n--- UprintBD Provider & Scraper Tests ---');

  console.log('\n1. CookieJar Mechanics:');
  test('absorb parses standard and getSetCookie arrays', () => {
    const jar = new CookieJar();
    jar.absorb({
      headers: {
        getSetCookie: () => [
          'csrftoken=abc123csrf; Path=/; SameSite=Lax',
          'sessionid=sess789xyz; Path=/; HttpOnly',
        ],
      },
    });
    assert.strictEqual(jar.get('csrftoken'), 'abc123csrf');
    assert.strictEqual(jar.get('sessionid'), 'sess789xyz');
    assert.strictEqual(jar.header(), 'csrftoken=abc123csrf; sessionid=sess789xyz');
  });

  test('absorb handles single header fallback', () => {
    const jar = new CookieJar();
    jar.absorb({
      headers: {
        get: () => 'csrftoken=single_token; Path=/',
      },
    });
    assert.strictEqual(jar.get('csrftoken'), 'single_token');
  });

  console.log('\n2. Scrapers & HTML Parsers:');
  test('cellText strips tags and decodes entities', () => {
    const raw = '<td> &nbsp;LabDDB&amp;Co.&lt;test&gt; </td>';
    assert.strictEqual(cellText(raw), 'LabDDB&Co.<test>');
  });

  test('extractCsrfInput extracts token from input tag', () => {
    const html = '<input type="hidden" name="csrfmiddlewaretoken" value="CSRF_TOKEN_SAMPLE_99">';
    assert.strictEqual(extractCsrfInput(html), 'CSRF_TOKEN_SAMPLE_99');
  });

  test('parseBalance reads institutional balance', () => {
    const html = '<div class="sidebar"><p>Balance: 120.50 Tk</p></div>';
    assert.strictEqual(parseBalance(html), 120.5);

    const intHtml = '<p>Balance: 8 Tk</p>';
    assert.strictEqual(parseBalance(intHtml), 8);
  });

  test('parseCountdownCell supports seconds, mm:ss, and hh:mm:ss', () => {
    const htmlSec = '<td id="seconds101"> 1800 </td>';
    assert.strictEqual(parseCountdownCell(htmlSec, '101'), 1800);

    const htmlMin = '<td id="seconds102"> 45:30 </td>';
    assert.strictEqual(parseCountdownCell(htmlMin, '102'), 2730);

    const htmlHour = '<td id="seconds103"> 01:10:05 </td>';
    assert.strictEqual(parseCountdownCell(htmlHour, '103'), 4205);
  });

  test('parseQueuedRecordIds finds all active dashboard records', () => {
    const html = '<td id="seconds501"></td> ... <td id="seconds502"></td>';
    const set = parseQueuedRecordIds(html);
    assert.strictEqual(set.size, 2);
    assert.ok(set.has('501'));
    assert.ok(set.has('502'));
  });

  test('dhakaDate returns Asia/Dhaka YYYY-MM-DD', () => {
    // 2026-09-02T20:00:00Z + 6h = 2026-09-03T02:00:00 (Dhaka)
    const d = dhakaDate(Date.parse('2026-09-02T20:00:00Z'));
    assert.strictEqual(d, '2026-09-03');
  });

  console.log('\n3. Real Captured Fixtures Verification:');
  const histPath = path.join(__dirname, '_print_history.html');
  if (fs.existsSync(histPath)) {
    test('parsePrintHistory successfully parses _print_history.html fixture', () => {
      const html = fs.readFileSync(histPath, 'utf8');
      const rows = parsePrintHistory(html);
      assert.ok(Array.isArray(rows), 'history rows should be an array');
      assert.ok(rows.length > 0, 'should extract rows from captured fixture');
      const first = rows[0];
      assert.ok(first.filename, 'row must contain a filename');
      assert.ok(first.status, 'row must contain status');
      assert.ok(typeof first.cost === 'number', 'cost must be numeric');
    });
  } else {
    console.log('  (skipped: _print_history.html fixture not present)');
  }

  console.log('\n4. SessionQueue Concurrency:');
  await testAsync('SessionQueue executes concurrent tasks sequentially', async () => {
    const queue = new SessionQueue();
    const order = [];

    const p1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 'res1';
    });

    const p2 = queue.enqueue(async () => {
      order.push(2);
      return 'res2';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1, 'res1');
    assert.strictEqual(r2, 'res2');
    assert.deepStrictEqual(order, [1, 2], 'task 1 must complete before task 2 starts');
  });

  console.log('\n------------------------------------------------------------');
  console.log(`Provider tests: ${passed} passed, 0 failed.\n`);
})();
