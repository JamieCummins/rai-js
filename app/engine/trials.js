import { shuffle } from './random.js';

/**
 * Trial engine for the multiple-choice RAI. Pure functions, no DOM.
 *
 * A content row describes one trial with numbered placeholders (1-6) standing
 * for nonsense words:
 *   statement_1..5      premises shown at the top
 *   true_statements     comma-separated pool of statements that follow from the premises
 *   false_statements    comma-separated pool of statements that do not
 *   probed_truth_value  TRUE or FALSE: which kind the participant must select
 *   n_true_answers / n_false_answers  how many options to draw from each pool
 */
const STATEMENT_KEYS = ['statement_1', 'statement_2', 'statement_3', 'statement_4', 'statement_5'];
const PLACEHOLDER = /[1-6]/g;

const splitList = (s) => String(s || '').split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** Placeholders (as numbers) used anywhere in a row. */
export function placeholdersIn(row) {
  const text = [...STATEMENT_KEYS.map((k) => row[k] || ''), row.true_statements || '', row.false_statements || ''].join(' ');
  return [...new Set(text.match(PLACEHOLDER) || [])].map(Number).sort();
}

/** Replace every placeholder in one pass, so a word can never be re-substituted. */
export const substitute = (text, words) => String(text).replace(PLACEHOLDER, (d) => words[d] ?? d);

/** Words written out literally in content rows (the practice trials), e.g. CUG, JOM, VEK. */
export function literalWords(rows) {
  const text = rows.flatMap((r) => [...STATEMENT_KEYS.map((k) => r[k] || ''), r.true_statements || '', r.false_statements || '']).join(' ');
  return [...new Set(text.match(/\b[A-Z]{2,}\b/g) || [])];
}

/**
 * Hands out nonsense words without replacement within an administration, one
 * bucket per placeholder. `used` lists words that must not be handed out: those
 * shown before a resumed sitting was interrupted, and those in the practice
 * trials. A bucket is refilled (with all its words) only once it runs out.
 */
export class WordPool {
  constructor(buckets, rng = Math.random, used = []) {
    this.buckets = buckets;
    this.rng = rng;
    this.used = new Set(used);
    this.remaining = {};
  }

  draw(placeholder) {
    const bucket = this.buckets[placeholder] || [];
    if (!bucket.length) return String(placeholder);
    if (!this.remaining[placeholder]) {
      const fresh = bucket.filter((w) => !this.used.has(w));
      this.remaining[placeholder] = shuffle(fresh.length ? fresh : bucket, this.rng);
    } else if (!this.remaining[placeholder].length) {
      this.remaining[placeholder] = shuffle(bucket, this.rng);
    }
    return this.remaining[placeholder].pop();
  }

  /** Words for one trial: { 1: 'BOR', 2: 'SUR', ... } for the placeholders the row uses. */
  wordsFor(row) {
    const words = {};
    for (const p of placeholdersIn(row)) words[p] = this.draw(p);
    return words;
  }
}

/** Turn content/syllables.csv rows into { 1: [...], 2: [...], ... }. */
export function bucketsFromRows(rows) {
  const buckets = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      const m = k.match(/^bucket_(\d)$/);
      if (m && v) (buckets[m[1]] ||= []).push(v);
    }
  }
  return buckets;
}

/**
 * Build a concrete trial from a content row.
 * Returns premises, the shuffled response options and the correct option indexes.
 */
export function buildTrial(row, words = {}, rng = Math.random) {
  const probe = String(row.probed_truth_value).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
  const nTrue = Number(row.n_true_answers) || 0;
  const nFalse = Number(row.n_false_answers) || 0;
  const truePool = splitList(row.true_statements);
  const falsePool = splitList(row.false_statements);
  if (nTrue > truePool.length || nFalse > falsePool.length) {
    throw new Error(`Trial ${row.trial_num ?? row.check_id}: not enough statements to draw ${nTrue} true and ${nFalse} false options`);
  }
  const drawn = [
    ...shuffle(truePool, rng).slice(0, nTrue).map((template) => ({ template, truth: true })),
    ...shuffle(falsePool, rng).slice(0, nFalse).map((template) => ({ template, truth: false })),
  ];
  const options = shuffle(drawn, rng).map((o) => ({ ...o, text: substitute(o.template, words) }));
  const wanted = probe === 'TRUE';
  return {
    probe,
    words,
    premises: STATEMENT_KEYS.map((k) => row[k]).filter(Boolean).map((s) => substitute(s, words)),
    options,
    correctIndexes: options.map((o, i) => (o.truth === wanted ? i : -1)).filter((i) => i >= 0),
  };
}

/**
 * Score a response: correct only if the selected set equals the correct set
 * (the all-or-nothing rule of the original). Partial counts are kept for analysis.
 */
export function scoreTrial(trial, selectedIndexes) {
  const selected = new Set(selectedIndexes);
  const correct = new Set(trial.correctIndexes);
  let hits = 0;
  let falseAlarms = 0;
  for (const i of selected) { if (correct.has(i)) hits++; else falseAlarms++; }
  const misses = correct.size - hits;
  return { correct: misses === 0 && falseAlarms === 0 ? 1 : 0, hits, misses, falseAlarms };
}

/**
 * The fixed order of one administration: practice trials, then the test trials
 * with optional attention checks slotted in after the trial named in `after_trial`.
 * Each item gets a stable 1-based `seq`, which is what makes resuming possible.
 */
export function buildSequence({ practice = [], trials, attention = [], settings = {}, breakAfterTrials = [], maxTrials = 0, fromTrial = 0 }) {
  const items = [];
  if (settings.practice !== false) practice.forEach((row, i) => items.push({ phase: 'practice', row, label: i + 1 }));
  const practiceCount = items.length;
  const eligible = fromTrial > 0 ? trials.filter((r) => Number(r.trial_num) >= fromTrial) : trials;
  const rows = maxTrials > 0 ? eligible.slice(0, maxTrials) : eligible;
  const breaks = new Set(breakAfterTrials.map(Number));
  const checks = settings.attentionChecks ? attention : [];
  rows.forEach((row, i) => {
    const n = Number(row.trial_num);
    items.push({ phase: 'test', row });
    for (const c of checks) if (Number(c.after_trial) === n) items.push({ phase: 'attention', row: c });
    if (breaks.has(n) && i < rows.length - 1) items[items.length - 1].breakAfter = true;
  });
  const mainTotal = items.length - practiceCount;
  let main = 0;
  items.forEach((item, i) => {
    item.seq = i + 1;
    if (item.phase !== 'practice') { item.label = ++main; item.total = mainTotal; } else { item.total = practiceCount; }
  });
  return { items, practiceCount, mainTotal, testCount: rows.length };
}
