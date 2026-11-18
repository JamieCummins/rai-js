import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCsv } from '../app/engine/csv.js';
import { makeRng } from '../app/engine/random.js';
import { WordPool, bucketsFromRows, buildTrial, scoreTrial, buildSequence, placeholdersIn, substitute, literalWords } from '../app/engine/trials.js';

const read = (f) => parseCsv(fs.readFileSync(new URL(`../content/${f}`, import.meta.url), 'utf8'));
const trials = read('trials/en.csv');
const practice = read('practice/en.csv');
const attention = read('attention_checks/en.csv');
const buckets = bucketsFromRows(read('syllables.csv'));

test('content has the expected shape', () => {
  assert.equal(trials.length, 128);
  assert.equal(practice.length, 3);
  assert.equal(attention.length, 6);
  assert.deepEqual(trials.map((r) => Number(r.trial_num)), Array.from({ length: 128 }, (_, i) => i + 1));
  assert.deepEqual(Object.keys(buckets), ['1', '2', '3', '4', '5', '6']);
});

test('every row can be built, with the stated number of options and at least one correct option', () => {
  const rng = makeRng(1);
  const pool = new WordPool(buckets, rng);
  for (const row of [...trials, ...practice, ...attention]) {
    const t = buildTrial(row, pool.wordsFor(row), rng);
    assert.equal(t.options.length, Number(row.n_answers), `options in ${row.trial_num ?? row.check_id}`);
    assert.ok(t.correctIndexes.length >= 1);
    assert.ok(t.premises.length >= 2);
    for (const text of [...t.premises, ...t.options.map((o) => o.text)]) assert.doesNotMatch(text, /\d/, `placeholder left in "${text}"`);
  }
});

test('placeholders are substituted in one pass', () => {
  assert.equal(substitute('1 is the same as 2', { 1: 'A2', 2: 'B1' }), 'A2 is the same as B1');
  assert.deepEqual(placeholdersIn({ statement_1: '1 is more than 3', true_statements: '3 is less than 1', false_statements: '5 is 1' }), [1, 3, 5]);
});

test('words are not repeated within an administration', () => {
  const pool = new WordPool(buckets, makeRng(2));
  const seen = new Set();
  for (const row of trials) {
    for (const w of Object.values(pool.wordsFor(row))) { assert.ok(!seen.has(w), `${w} repeated`); seen.add(w); }
  }
});

test('scoring is all-or-nothing', () => {
  const row = { statement_1: '1 is the same as 2', statement_2: '2 is the same as 3', true_statements: '1 is the same as 3, 3 is the same as 1', false_statements: '1 is opposite to 3', probed_truth_value: 'TRUE', n_true_answers: '2', n_false_answers: '1' };
  const t = buildTrial(row, { 1: 'CUG', 2: 'JOM', 3: 'VEK' }, makeRng(3));
  assert.equal(t.correctIndexes.length, 2);
  assert.deepEqual(scoreTrial(t, t.correctIndexes), { correct: 1, hits: 2, misses: 0, falseAlarms: 0 });
  assert.equal(scoreTrial(t, [t.correctIndexes[0]]).correct, 0);
  assert.equal(scoreTrial(t, [0, 1, 2]).correct, 0);
  assert.deepEqual(scoreTrial(t, []), { correct: 0, hits: 0, misses: 2, falseAlarms: 0 });
  const f = buildTrial({ ...row, probed_truth_value: 'FALSE' }, { 1: 'CUG', 2: 'JOM', 3: 'VEK' }, makeRng(3));
  assert.equal(f.correctIndexes.length, 1);
  assert.equal(f.options[f.correctIndexes[0]].truth, false);
});

test('sequence: practice, test trials, optional attention checks, breaks', () => {
  const plain = buildSequence({ practice, trials, attention, settings: {}, breakAfterTrials: [48, 96] });
  assert.equal(plain.items.length, 131);
  assert.equal(plain.mainTotal, 128);
  assert.deepEqual(plain.items.map((x) => x.seq), Array.from({ length: 131 }, (_, i) => i + 1));
  assert.deepEqual(plain.items.filter((x) => x.breakAfter).map((x) => x.row.trial_num), ['48', '96']);
  assert.equal(plain.items[3].label, 1);

  const checks = buildSequence({ practice, trials, attention, settings: { attentionChecks: true, practice: false }, breakAfterTrials: [48, 96] });
  assert.equal(checks.items.length, 134);
  assert.equal(checks.practiceCount, 0);
  // same positions as the original lab.js loop (1-based rows 21, 48, 69, 81, 87, 114)
  assert.deepEqual(checks.items.map((x, i) => (x.phase === 'attention' ? i + 1 : 0)).filter(Boolean), [21, 48, 69, 81, 87, 114]);

  const short = buildSequence({ practice, trials, attention, settings: {}, breakAfterTrials: [4, 8], maxTrials: 8 });
  assert.equal(short.testCount, 8);
  assert.equal(short.items.filter((x) => x.breakAfter).length, 1);
});

test('a resumed sitting does not repeat words shown before the interruption', () => {
  const first = new WordPool(buckets, makeRng(4));
  const before = trials.slice(0, 60).flatMap((row) => Object.values(first.wordsFor(row)));
  const second = new WordPool(buckets, makeRng(5), before);
  const after = trials.slice(60).flatMap((row) => Object.values(second.wordsFor(row)));
  const all = [...before, ...after];
  assert.equal(new Set(all).size, all.length);
});

test('words used in the practice trials are not drawn in the test', () => {
  const literal = literalWords(practice);
  for (const w of ['CUG', 'JOM', 'VEK', 'DOK', 'SAF', 'WER']) assert.ok(literal.includes(w), `${w} not found`);
  const pool = new WordPool(buckets, makeRng(6), literal);
  for (const row of trials) for (const w of Object.values(pool.wordsFor(row))) assert.ok(!literal.includes(w), `${w} drawn`);
});

test('a bucket that runs out is refilled rather than left empty', () => {
  const pool = new WordPool({ 1: ['AAA', 'BBB'] }, makeRng(7), ['AAA']);
  assert.deepEqual([pool.draw(1), pool.draw(1) !== undefined, pool.draw(2)], ['BBB', true, '2']);
});
