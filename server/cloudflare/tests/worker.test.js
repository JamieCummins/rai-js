/**
 * Tests of the worker against an in-memory D1 database, run with Miniflare (the
 * local runtime that `wrangler dev` uses; it is installed with wrangler).
 * Nothing here touches Cloudflare or any real database.
 *
 *   cd server/cloudflare && npm test
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as miniflare from 'miniflare';

const { Miniflare, convertV4MiniflareOptions } = miniflare;

const here = (f) => new URL(`../${f}`, import.meta.url);
const ADMIN = 'test-admin-token';
const ORIGIN = 'http://localhost:8080';

const statements = (sql) => sql.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

async function startWorker(bindings = {}) {
  // Written in Miniflare's v4 option names; newer versions convert them.
  const options = {
    modules: true,
    scriptPath: here('worker.js').pathname,
    compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'rai-test' },
    bindings: { AUTH_SECRET: 'test-secret-0123456789', ADMIN_TOKEN: ADMIN, DEV_SHOW_CODES: '1', ALLOWED_ORIGINS: `https://example.org,${ORIGIN}`, ...bindings },
  };
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  const db = await mf.getD1Database('DB');
  for (const s of statements(fs.readFileSync(here('schema.sql'), 'utf8'))) await db.prepare(s).run();
  // A SMART users table as in smart-js/server/cloudflare/schema.sql, with two accounts (PIN 1234).
  await db.prepare('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL, language TEXT, study TEXT, created_at TEXT NOT NULL, last_login_at TEXT, failed_logins INTEGER DEFAULT 0, locked_until TEXT)').run();
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync('1234', salt, 100000, 32, 'sha256').toString('hex');
  for (const [name, tag] of [['kid1', 'tagA'], ['kid2', 'tagB']]) {
    await db.prepare('INSERT INTO users (username, pin_hash, salt, language, study, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(name, hash, salt.toString('hex'), 'nl', tag, '2026-01-01').run();
  }
  const call = async (method, path, body, token, headers = {}) => {
    const res = await mf.dispatchFetch(`http://rai.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data, text, headers: res.headers };
  };
  const study = (code, settings) => call('PUT', '/admin/studies', { code, settings }, ADMIN);
  return { mf, db, call, study };
}

/** A trial record like the ones app/main.js builds. */
const record = (administrationId, seq, phase, correct, words) => ({
  administrationId, seq, phase, trialNum: seq, probe: 'TRUE', premises: ['A is B'], options: [{ text: 'x', truth: true, selected: true }],
  nOptions: 2, nCorrectOptions: 1, correct, hits: 1, misses: 0, falseAlarms: 0, rtMs: 1000, timedOut: 0, words,
});

let w;
before(async () => { w = await startWorker(); });
after(async () => { await w.mf.dispose(); });

test('admin endpoints need the admin token', async () => {
  assert.equal((await w.call('GET', '/admin/studies')).status, 401);
  assert.equal((await w.call('GET', '/admin/studies', null, 'wrong')).status, 401);
  assert.equal((await w.call('GET', '/admin/studies', null, ADMIN)).status, 200);
});

test('a study is public without its private settings; unknown and inactive studies are not found', async () => {
  await w.study('pub', { login: 'id', completionCode: 'SECRET1', completionUrl: 'https://example.org/done', smartStudy: 'tagA' });
  const res = await w.call('GET', '/studies/pub');
  assert.equal(res.status, 200);
  assert.equal(res.data.settings.login, 'id');
  for (const k of ['completionCode', 'completionUrl', 'accountDb', 'smartStudy']) assert.ok(!(k in res.data.settings), `${k} is public`);
  assert.ok(!res.text.includes('SECRET1'));
  assert.equal((await w.call('GET', '/studies/nope')).status, 404);
  await w.call('PUT', '/admin/studies', { code: 'pub', active: false }, ADMIN);
  assert.equal((await w.call('GET', '/studies/pub')).status, 404);
});

test('CORS: only listed origins are echoed', async () => {
  const ok = await w.call('GET', '/health');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const other = await w.call('GET', '/health', null, null, { Origin: 'https://evil.example' });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), 'https://example.org');
});

test('login by ID: open and invitation-only studies, and the login mode is enforced', async () => {
  await w.study('ids', { login: 'id' });
  const a = await w.call('POST', '/auth/id', { study: 'ids', identifier: 'P-001' });
  assert.equal(a.status, 200);
  assert.equal(a.data.participant.identifier, 'P-001');
  assert.equal((await w.call('GET', '/me', null, a.data.token)).data.participant.identifier, 'P-001');
  assert.equal((await w.call('POST', '/auth/id', { study: 'ids', identifier: 'has space' })).status, 400);
  assert.equal((await w.call('POST', '/auth/smart', { study: 'ids', username: 'kid1', pin: '1234' })).status, 400);
  assert.equal((await w.call('GET', '/me', null, `${a.data.token}x`)).status, 401);

  await w.study('invited', { login: 'id', registration: 'invited' });
  assert.equal((await w.call('POST', '/auth/id', { study: 'invited', identifier: 'guest' })).data.error, 'notInvited');
  await w.call('POST', '/admin/participants', { study: 'invited', identifiers: ['guest'] }, ADMIN);
  assert.equal((await w.call('POST', '/auth/id', { study: 'invited', identifier: 'guest' })).status, 200);
});

test('login with a SMART account: PIN, study tag, lock, and the users table is never written', async () => {
  await w.study('smart', { login: 'smart', smartStudy: 'tagA' });
  const before = await w.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal((await w.call('POST', '/auth/smart', { study: 'smart', username: 'kid1', pin: '0000' })).data.error, 'invalid');
  assert.equal((await w.call('POST', '/auth/smart', { study: 'smart', username: 'kid2', pin: '1234' })).data.error, 'invalid'); // wrong tag
  assert.equal((await w.call('POST', '/auth/smart', { study: 'smart', username: 'nobody', pin: '1234' })).data.error, 'invalid');
  const ok = await w.call('POST', '/auth/smart', { study: 'smart', username: 'KID1', pin: '1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.participant.identifier, 'kid1');
  assert.equal(ok.data.participant.source, 'smart:DB');

  for (let i = 0; i < 10; i++) await w.call('POST', '/auth/smart', { study: 'smart', username: 'kid2', pin: '9999' });
  assert.equal((await w.call('POST', '/auth/smart', { study: 'smart', username: 'kid2', pin: '9999' })).status, 429);

  const afterwards = await w.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.deepEqual(afterwards.results, before.results);
});

test('login by email: code, wrong-code lock, per-address limit, invitation-only', async () => {
  await w.study('mail', { login: 'email' });
  const email = 'anna@example.org';
  const req = await w.call('POST', '/auth/email/request', { study: 'mail', email: 'Anna@Example.org' });
  assert.match(req.data.devCode, /^\d{6}$/);
  assert.equal((await w.call('POST', '/auth/email/verify', { study: 'mail', email, code: '000000' === req.data.devCode ? '111111' : '000000' })).status, 401);
  const ok = await w.call('POST', '/auth/email/verify', { study: 'mail', email, code: req.data.devCode });
  assert.equal(ok.data.participant.identifier, email);
  assert.equal((await w.call('POST', '/auth/email/verify', { study: 'mail', email, code: req.data.devCode })).status, 401); // single use
  assert.equal((await w.call('POST', '/auth/email/request', { study: 'mail', email: 'not-an-address' })).status, 400);

  // Five wrong attempts lock a code, even for the right one.
  const second = await w.call('POST', '/auth/email/request', { study: 'mail', email: 'ben@example.org' });
  const wrong = second.data.devCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await w.call('POST', '/auth/email/verify', { study: 'mail', email: 'ben@example.org', code: wrong });
  assert.equal((await w.call('POST', '/auth/email/verify', { study: 'mail', email: 'ben@example.org', code: second.data.devCode })).status, 401);

  // Five codes per hour for one address.
  for (let i = 0; i < 5; i++) assert.equal((await w.call('POST', '/auth/email/request', { study: 'mail', email: 'cara@example.org' })).status, 200);
  assert.equal((await w.call('POST', '/auth/email/request', { study: 'mail', email: 'cara@example.org' })).data.error, 'tooMany');

  // Invitation-only: the same answer for an unknown address, but no code is made.
  await w.study('mail-invited', { login: 'email', registration: 'invited' });
  const unknown = await w.call('POST', '/auth/email/request', { study: 'mail-invited', email: 'dan@example.org' });
  assert.deepEqual(unknown.data, { ok: true });
  await w.call('POST', '/admin/participants', { study: 'mail-invited', identifiers: ['dan@example.org'] }, ADMIN);
  assert.match((await w.call('POST', '/auth/email/request', { study: 'mail-invited', email: 'dan@example.org' })).data.devCode, /^\d{6}$/);
});

test('an administration: upload, resume, completion only when all trials are stored, one per timepoint', async () => {
  await w.study('run', { login: 'id', completionCode: 'DONE42' });
  const { token } = (await w.call('POST', '/auth/id', { study: 'run', identifier: 'p1' })).data;
  const start = await w.call('POST', '/administrations', { id: 'adm-1', timepoint: 'pre', settings: { practice: true }, nTrials: 128 }, token);
  assert.equal(start.status, 201);
  assert.deepEqual([start.data.resumed, start.data.nextSeq, start.data.usedWords], [false, 1, []]);

  // 3 practice + 60 test trials, the last batch sent twice.
  const first = [1, 2, 3].map((seq) => record('adm-1', seq, 'practice', 1, {}))
    .concat(Array.from({ length: 60 }, (_, i) => record('adm-1', 4 + i, 'test', i % 2, { 1: `A${i}`, 2: `B${i}` })));
  assert.equal((await w.call('POST', '/trials', { trials: first }, token)).data.saved, 63);
  assert.equal((await w.call('POST', '/trials', { trials: first.slice(-20) }, token)).data.saved, 0);

  // Too early to complete, and no completion code yet.
  const early = await w.call('PATCH', '/administrations/adm-1', { status: 'completed' }, token);
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'incomplete');
  assert.ok(!early.text.includes('DONE42'));

  // Starting again resumes the same administration.
  const resumed = await w.call('POST', '/administrations', { id: 'adm-other', timepoint: 'pre', settings: {}, nTrials: 128 }, token);
  assert.equal(resumed.status, 200);
  assert.deepEqual([resumed.data.resumed, resumed.data.administration.id, resumed.data.nextSeq, resumed.data.totalCorrect], [true, 'adm-1', 64, 30]);
  assert.equal(resumed.data.usedWords.length, 120);
  assert.ok(resumed.data.usedWords.includes('B59'));

  const rest = Array.from({ length: 68 }, (_, i) => record('adm-1', 64 + i, 'test', 1, { 1: `C${i}` }));
  await w.call('POST', '/trials', { trials: rest }, token);
  const done = await w.call('PATCH', '/administrations/adm-1', { status: 'completed' }, token);
  assert.equal(done.status, 200);
  assert.deepEqual([done.data.trialsCompleted, done.data.totalCorrect, done.data.completionCode], [128, 98, 'DONE42']);

  // The same timepoint again is refused; another timepoint is fine.
  assert.equal((await w.call('POST', '/administrations', { id: 'adm-2', timepoint: 'pre', settings: {}, nTrials: 128 }, token)).status, 409);
  assert.equal((await w.call('POST', '/administrations', { id: 'adm-3', timepoint: 'post', settings: {}, nTrials: 128 }, token)).status, 201);

  // A debug run can be completed at any length but never gives the completion code.
  await w.call('POST', '/administrations', { id: 'adm-debug', timepoint: 'pre', settings: {}, nTrials: 8, debug: true }, token);
  const debug = await w.call('PATCH', '/administrations/adm-debug', { status: 'completed' }, token);
  assert.equal(debug.status, 200);
  assert.ok(!debug.text.includes('DONE42'));

  // Another participant cannot write into or complete this administration.
  const other = (await w.call('POST', '/auth/id', { study: 'run', identifier: 'p2' })).data.token;
  assert.equal((await w.call('POST', '/trials', { trials: [record('adm-3', 1, 'test', 1, {})] }, other)).data.saved, 0);
  assert.equal((await w.call('PATCH', '/administrations/adm-3', { status: 'completed' }, other)).status, 404);
});

test('exports and deleting a participant', async () => {
  const trials = await w.call('GET', '/admin/export/trials?study=run&identifier=p1&format=json', null, ADMIN);
  assert.equal(trials.data.filter((r) => r.phase === 'test').length, 128);
  const csv = await w.call('GET', '/admin/export/administrations?study=run', null, ADMIN);
  assert.match(csv.text.split('\n')[0], /identifier,administration_id/);

  const list = (await w.call('GET', '/admin/participants?study=run', null, ADMIN)).data;
  const p1 = list.find((p) => p.identifier === 'p1');
  const del = await w.call('DELETE', `/admin/participants?id=${p1.id}`, null, ADMIN);
  assert.equal(del.data.trials, 131);
  for (const table of ['rai_trials', 'rai_administrations']) {
    assert.equal((await w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE participant_id = ?`).bind(p1.id).first()).n, 0);
  }

  // Deleting a SMART participant also removes their failed-login record.
  await w.call('POST', '/auth/smart', { study: 'smart', username: 'kid1', pin: '0000' });
  const kid = (await w.call('GET', '/admin/participants?study=smart', null, ADMIN)).data.find((p) => p.identifier === 'kid1');
  await w.call('DELETE', `/admin/participants?id=${kid.id}`, null, ADMIN);
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM rai_login_attempts WHERE key = 'smart:DB:kid1'").first()).n, 0);
});

test('an overall limit on login codes per hour', async () => {
  const small = await startWorker({ EMAIL_CODES_PER_HOUR: '3' });
  try {
    await small.study('mail', { login: 'email' });
    const request = (n) => small.call('POST', '/auth/email/request', { study: 'mail', email: `person${n}@example.org` });
    for (let n = 0; n < 3; n++) assert.equal((await request(n)).status, 200);
    assert.equal((await request(3)).data.error, 'busy');
    // A code that is used no longer counts.
    const code = (await small.db.prepare('SELECT COUNT(*) AS n FROM rai_email_codes').first()).n;
    assert.equal(code, 3);
    await small.db.prepare("DELETE FROM rai_email_codes WHERE email = 'person0@example.org'").run();
    assert.equal((await request(3)).status, 200);
  } finally { await small.mf.dispose(); }
});

test('without AUTH_SECRET nobody can log in', async () => {
  const bare = await startWorker({ AUTH_SECRET: '' });
  try {
    await bare.study('ids', { login: 'id' });
    const res = await bare.call('POST', '/auth/id', { study: 'ids', identifier: 'p1' });
    assert.equal(res.status, 500);
    assert.ok(!res.data.token);
    assert.equal((await bare.call('GET', '/me', null, 'eyJwaWQiOjF9.x')).status, 500);
  } finally { await bare.mf.dispose(); }
});
