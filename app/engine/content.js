import { parseCsv } from './csv.js';

/** Loads the CSV content files (relative to index.html). */
async function loadCsv(path, { optional = false } = {}) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) {
    if (optional) return [];
    throw new Error(`Could not load ${path} (${res.status})`);
  }
  return parseCsv(await res.text());
}

export async function loadContent(lang, base = 'content') {
  const [trials, practice, attention, syllables] = await Promise.all([
    loadCsv(`${base}/trials/${lang}.csv`),
    loadCsv(`${base}/practice/${lang}.csv`, { optional: true }),
    loadCsv(`${base}/attention_checks/${lang}.csv`, { optional: true }),
    loadCsv(`${base}/syllables.csv`),
  ]);
  return { trials, practice, attention, syllables };
}
