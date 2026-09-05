/**
 * scripts/test-catalogue-defaults.js — Unit tests for latest-added course & experiment defaults.
 * -----------------------------------------------------------------------------
 * Tests the shared catalogue data/selection layer across:
 *   1. Recency determination by createdAt, updatedAt, and catalogue database order.
 *   2. Experiment recency by array creation order and timestamps.
 *   3. Default placeholder selection for courses and experiments.
 *   4. Preservation of manual user selection across catalogue refreshes.
 *   5. Empty state and error resilience with no courses or experiments.
 *   6. Retention of all items in dropdown candidate lists.
 */

'use strict';

const assert = require('assert');
const path = require('path');

// Require the shared config/catalogue module
const LabDDB = require(path.join(__dirname, '../public/js/labddb-config.js'));
const { catalogue } = LabDDB;

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

console.log('\n--- Catalogue Defaults & Selection Layer Tests ---');

console.log('\n1. Course Recency Determination:');

test('Selects newest course by createdAt timestamp', () => {
  const candidates = ['EEE-101', 'EEE-201', 'EEE-301'];
  const coursesMap = {
    'EEE-101': { courseCode: 'EEE-101', createdAt: 1000 },
    'EEE-201': { courseCode: 'EEE-201', createdAt: 3000 }, // Newest
    'EEE-301': { courseCode: 'EEE-301', createdAt: 2000 },
  };

  const selected = catalogue.getLatestCourse(candidates, coursesMap);
  assert.strictEqual(selected, 'EEE-201');
});

test('Selects newest course by updatedAt timestamp when createdAt is absent', () => {
  const candidates = ['CSE-101', 'CSE-102', 'CSE-103'];
  const coursesMap = {
    'CSE-101': { courseCode: 'CSE-101', updatedAt: 1700000001000 },
    'CSE-102': { courseCode: 'CSE-102', updatedAt: 1700000005000 }, // Newest RTDB timestamp
    'CSE-103': { courseCode: 'CSE-103', updatedAt: 1700000002000 },
  };

  const selected = catalogue.getLatestCourse(candidates, coursesMap);
  assert.strictEqual(selected, 'CSE-102');
});

test('Selects newest course by catalogue insertion order (_rawIndex) when timestamps absent', () => {
  const candidates = ['PHY-101', 'PHY-102', 'PHY-103'];
  const coursesMap = {
    'PHY-101': { courseCode: 'PHY-101', _rawIndex: 0 },
    'PHY-102': { courseCode: 'PHY-102', _rawIndex: 1 },
    'PHY-103': { courseCode: 'PHY-103', _rawIndex: 2 }, // Last added to catalogue
  };

  const selected = catalogue.getLatestCourse(candidates, coursesMap);
  assert.strictEqual(selected, 'PHY-103');
});

test('createdAt takes precedence over updatedAt if both exist on differing records', () => {
  const candidates = ['MATH-101', 'MATH-102'];
  const coursesMap = {
    'MATH-101': { courseCode: 'MATH-101', createdAt: 5000, updatedAt: 1000 },
    'MATH-102': { courseCode: 'MATH-102', createdAt: 2000, updatedAt: 9000 },
  };

  const selected = catalogue.getLatestCourse(candidates, coursesMap);
  assert.strictEqual(selected, 'MATH-101');
});

console.log('\n2. Experiment Recency Determination:');

test('Selects newest experiment by array creation order (last item)', () => {
  const experiments = [
    { num: '01', title: 'Ohm Law' },
    { num: '02', title: 'Kirchhoff Laws' },
    { num: '03', title: 'Superposition Theorem' }, // Added last
  ];

  const latest = catalogue.getLatestExperiment(experiments);
  assert.notStrictEqual(latest, null);
  assert.strictEqual(latest.index, 2);
  assert.strictEqual(latest.experiment.num, '03');
  assert.strictEqual(latest.experiment.title, 'Superposition Theorem');
});

test('Selects newest experiment by explicit timestamp when present', () => {
  const experiments = [
    { num: '01', title: 'First Exp', updatedAt: 100 },
    { num: '02', title: 'Second Exp', updatedAt: 500 }, // Highest timestamp
    { num: '03', title: 'Third Exp', updatedAt: 200 },
  ];

  const latest = catalogue.getLatestExperiment(experiments);
  assert.strictEqual(latest.index, 1);
  assert.strictEqual(latest.experiment.num, '02');
});

test('Handles experiment list given as an object instead of array', () => {
  const experimentsObj = {
    exp_1: { num: '01', title: 'Intro' },
    exp_2: { num: '02', title: 'Advanced' },
  };

  const latest = catalogue.getLatestExperiment(experimentsObj);
  assert.notStrictEqual(latest, null);
  assert.strictEqual(latest.experiment.num, '02');
});

console.log('\n3. Course Selection Resolution & User Override:');

test('Defaults to latest course when user has not made a manual selection', () => {
  const candidates = ['A', 'B', 'C'];
  const coursesMap = {
    'A': { courseCode: 'A', updatedAt: 10 },
    'B': { courseCode: 'B', updatedAt: 30 },
    'C': { courseCode: 'C', updatedAt: 20 },
  };

  const result = catalogue.resolveCourseSelection(candidates, coursesMap, null);
  assert.strictEqual(result, 'B');
});

test('Preserves manual user selection when user has chosen a course', () => {
  const candidates = ['A', 'B', 'C'];
  const coursesMap = {
    'A': { courseCode: 'A', updatedAt: 10 },
    'B': { courseCode: 'B', updatedAt: 30 }, // Latest
    'C': { courseCode: 'C', updatedAt: 20 },
  };

  // User manually clicked course 'A'
  const userSelected = 'A';
  const result = catalogue.resolveCourseSelection(candidates, coursesMap, userSelected);
  assert.strictEqual(result, 'A', 'User manual choice must not be overwritten by latest');
});

test('Falls back to latest if user manually selected code is no longer in candidate list', () => {
  const candidates = ['B', 'C'];
  const coursesMap = {
    'B': { courseCode: 'B', updatedAt: 30 },
    'C': { courseCode: 'C', updatedAt: 20 },
  };

  // User had previously selected 'A', which got removed from catalogue
  const userSelected = 'A';
  const result = catalogue.resolveCourseSelection(candidates, coursesMap, userSelected);
  assert.strictEqual(result, 'B');
});

console.log('\n4. Experiment Selection Resolution & User Override:');

test('Defaults to latest experiment when user has not made a manual selection', () => {
  const experiments = [
    { num: '01', title: 'Exp 1' },
    { num: '02', title: 'Exp 2' },
  ];

  const result = catalogue.resolveExperimentSelection(experiments, null);
  assert.strictEqual(result.index, 1);
  assert.strictEqual(result.experiment.title, 'Exp 2');
});

test('Preserves manual user selection for experiment index', () => {
  const experiments = [
    { num: '01', title: 'Exp 1' },
    { num: '02', title: 'Exp 2' },
    { num: '03', title: 'Exp 3' },
  ];

  // User manually picked Exp 1 (index 0)
  const result = catalogue.resolveExperimentSelection(experiments, '0');
  assert.strictEqual(result.index, 0);
  assert.strictEqual(result.experiment.title, 'Exp 1');
});

test('Falls back to latest experiment if manual selection index is out of bounds', () => {
  const experiments = [
    { num: '01', title: 'Exp 1' },
    { num: '02', title: 'Exp 2' },
  ];

  const result = catalogue.resolveExperimentSelection(experiments, '99');
  assert.strictEqual(result.index, 1);
  assert.strictEqual(result.experiment.title, 'Exp 2');
});

console.log('\n5. Empty & Edge Case Resilience:');

test('Empty course candidates list returns null safely without throwing', () => {
  assert.strictEqual(catalogue.getLatestCourse([], {}), null);
  assert.strictEqual(catalogue.resolveCourseSelection([], {}, null), null);
  assert.strictEqual(catalogue.resolveCourseSelection(null, null, null), null);
});

test('Empty experiments list returns null safely without throwing', () => {
  assert.strictEqual(catalogue.getLatestExperiment([]), null);
  assert.strictEqual(catalogue.getLatestExperiment(null), null);
  assert.strictEqual(catalogue.resolveExperimentSelection([], null), null);
  assert.strictEqual(catalogue.resolveExperimentSelection(null, null), null);
});

test('Single course candidate selects that course', () => {
  const single = ['EEE-SINGLE'];
  const map = { 'EEE-SINGLE': { courseCode: 'EEE-SINGLE' } };
  assert.strictEqual(catalogue.getLatestCourse(single, map), 'EEE-SINGLE');
  assert.strictEqual(catalogue.resolveCourseSelection(single, map, null), 'EEE-SINGLE');
});

test('Single experiment selects that experiment', () => {
  const singleExp = [{ num: '01', title: 'Sole Exp' }];
  const res = catalogue.resolveExperimentSelection(singleExp, null);
  assert.strictEqual(res.index, 0);
  assert.strictEqual(res.experiment.title, 'Sole Exp');
});

console.log('\n6. Candidate List Integrity:');

test('All courses remain in candidate list for dropdown population', () => {
  const candidates = ['EEE-101', 'EEE-201', 'EEE-301'];
  const coursesMap = {
    'EEE-101': { courseCode: 'EEE-101', updatedAt: 100 },
    'EEE-201': { courseCode: 'EEE-201', updatedAt: 300 },
    'EEE-301': { courseCode: 'EEE-301', updatedAt: 200 },
  };

  const selected = catalogue.resolveCourseSelection(candidates, coursesMap, null);
  assert.strictEqual(selected, 'EEE-201');

  // Candidate list remains intact with all 3 courses
  assert.strictEqual(candidates.length, 3);
  assert(candidates.includes('EEE-101'));
  assert(candidates.includes('EEE-201'));
  assert(candidates.includes('EEE-301'));
});

console.log('------------------------------------------------------------');
console.log(`Catalogue defaults unit tests: ${passed} passed, 0 failed.\n`);
