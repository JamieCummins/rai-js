/**
 * Writes version.json: a fingerprint of the app's scripts and stylesheet, and
 * the list of script files. index.html reads it (never from cache) and loads
 * every script with ?v=<fingerprint>, so that after an update browsers fetch
 * the whole new set instead of mixing cached old files with new ones.
 *
 *   npm run stamp      after changing anything under app/
 *
 * `npm test` fails if version.json is out of date.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}

export function currentVersion() {
  const files = walk('app').filter((f) => /\.(js|css)$/.test(f)).sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(fs.readFileSync(path.join(root, f))).update('\0');
  return { version: hash.digest('hex').slice(0, 12), modules: files.filter((f) => f.endsWith('.js')) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = currentVersion();
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify(v, null, 2) + '\n');
  console.log(`version.json: ${v.version} (${v.modules.length} scripts)`);
}
