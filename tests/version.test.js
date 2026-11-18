import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { currentVersion } from '../tools/build-version.js';

test('version.json matches the files under app/ (run "npm run stamp" after changing them)', () => {
  const stored = JSON.parse(fs.readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  assert.deepEqual(stored, currentVersion());
});
