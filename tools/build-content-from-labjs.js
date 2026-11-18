#!/usr/bin/env node
/**
 * One-off importer: reads the lab.js export of the multiple-choice RAI
 * (validating-multiple-choice-rai/experiment 3/materials/rai_study3/script.js)
 * and writes the CSV content files used by this app.
 *
 *   node tools/build-content-from-labjs.js "/path/to/rai_study3/script.js"
 *
 * Output:
 *   content/trials/en.csv            the 128 test trials, in their fixed order
 *   content/practice/en.csv          the 3 practice trials
 *   content/attention_checks/en.csv  the 6 attention checks + the trial they follow
 *   content/syllables.csv            nonsense-word buckets (one column per placeholder 1-6)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from '../app/engine/csv.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-content-from-labjs.js <script.js>'); process.exit(1); }
const code = fs.readFileSync(src, 'utf8');

// Evaluate the export with a stub `lab` object to get the study tree.
let study;
const lab = { util: { fromObject: (o) => { study = o; return { run() {} }; } } };
new Function('lab', 'window', 'document', code)(lab, {}, {});

const loops = {};
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (n.templateParameters) loops[n.title] = n;
  if (n.template) walk(n.template);
  if (Array.isArray(n.content)) n.content.forEach(walk);
  else walk(n.content);
})(study);

const clean = (s) => String(s ?? '').replace(/…/g, '...').replace(/\s+/g, ' ').trim();
const list = (s) => String(s ?? '').split(',').map(clean).filter(Boolean).join(', ');
const STATEMENTS = ['statement_1', 'statement_2', 'statement_3', 'statement_4', 'statement_5'];
const tidy = (r) => {
  const o = {};
  for (const k of STATEMENTS) o[k] = clean(r[k]);
  o.true_statements = list(r.true_statements);
  o.false_statements = list(r.false_statements);
  o.probed_truth_value = r.probed_truth_value;
  o.n_answers = r.n_answers;
  o.n_true_answers = r.n_true_answers;
  o.n_false_answers = r.n_false_answers;
  return o;
};

const main = loops.main_trials.templateParameters;
const trials = [];
const checks = [];
let last = 0;
for (const r of main) {
  if (/^\d+$/.test(r.trial_num)) {
    last = Number(r.trial_num);
    trials.push({ trial_num: last, trial_id: r.trial_id, block: r.block, difficulty: r.difficulty, ...tidy(r) });
  } else {
    checks.push({ check_id: `AC${checks.length + 1}`, after_trial: last, ...tidy(r) });
  }
}
const practice = loops.practice_trials.templateParameters.map((r) => ({ trial_num: r.trial_num, ...tidy(r) }));

// Nonsense-word buckets are defined in the main loop's before:prepare handler.
const handler = loops.main_trials.messageHandlers['before:prepare'].toString();
const buckets = [];
for (let i = 1; i <= 6; i++) {
  const m = handler.match(new RegExp(`stimulus_${i}_bucket\\s*=\\s*\\[([^\\]]*)\\]`));
  buckets.push(m ? m[1].split(',').map((w) => w.replace(/['"\s]/g, '')).filter(Boolean) : []);
}
const rows = [];
for (let i = 0; i < Math.max(...buckets.map((b) => b.length)); i++) {
  const o = {};
  buckets.forEach((b, j) => { o[`bucket_${j + 1}`] = b[i] || ''; });
  rows.push(o);
}

const write = (file, data) => { fs.writeFileSync(path.join(root, file), toCsv(data)); console.log(`${file}: ${data.length} rows`); };
write('content/trials/en.csv', trials);
write('content/practice/en.csv', practice);
write('content/attention_checks/en.csv', checks);
write('content/syllables.csv', rows);
