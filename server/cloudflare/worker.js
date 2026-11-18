/**
 * RAI API - Cloudflare Worker + D1 implementation of server/API.md.
 *
 * Bindings (wrangler.toml / dashboard):
 *   DB               D1 database holding the rai_ tables (schema.sql). When this is the SMART
 *                    database, SMART accounts in its `users` table can log in (login 'smart').
 *   DB_<NAME>        optional extra D1 databases whose `users` table may be used for login
 *                    'smart' (study setting accountDb). Only ever read, never written.
 *   AUTH_SECRET      secret used to sign login tokens          (wrangler secret put AUTH_SECRET)
 *   ADMIN_TOKEN      secret for the /admin endpoints            (wrangler secret put ADMIN_TOKEN)
 *   RESEND_API_KEY   secret for sending login codes by email    (wrangler secret put RESEND_API_KEY)
 *   MAIL_FROM        sender of those emails, e.g. "RAI <login@your-domain.org>"
 *   ALLOWED_ORIGINS  comma-separated list of allowed origins, or "*"
 *   DEV_SHOW_CODES   "1" returns the login code in the API response instead of emailing it.
 *                    For local development only (.dev.vars); never set it on the deployed worker.
 */

const TOKEN_TTL_SEC = 24 * 3600;
const MAX_TRIALS_PER_REQUEST = 200;
const CODE_TTL_MIN = 15;
const MAX_CODES_PER_HOUR = 5;
const MAX_CODE_ATTEMPTS = 5;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const DEFAULT_RESUME_HOURS = 24;
// Test trials in one full administration (rows in content/trials/<lang>.csv). An administration that
// is not a debug run can only be completed, and the completion code released, once this many are stored.
const TEST_TRIALS = 128;

const STUDY_RE = /^[a-z0-9_-]{2,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_RE = /^[A-Za-z0-9._@+-]{2,64}$/;
const TIMEPOINT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const BINDING_RE = /^DB(_[A-Z0-9]+)?$/;

/** Study settings and their defaults (mirrors studyDefaults in app/config.js). */
const SETTING_DEFAULTS = {
  login: 'email', registration: 'open', idLabel: 'Participant ID',
  practice: true, attentionChecks: false, demographics: false,
  completionCode: '', completionUrl: '', showScore: false, repeatable: false, fullscreen: true,
  accountDb: 'DB', smartStudy: '',
};
/** Settings that are never sent to a participant's browser before they have finished. */
const PRIVATE_SETTINGS = ['completionCode', 'completionUrl', 'accountDb', 'smartStudy'];

// ---------------------------------------------------------------- helpers ----
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const now = () => new Date().toISOString();
const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Same PIN hashing as the SMART worker, so SMART accounts can be verified. */
async function hashPin(pin, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function makeToken(env, participantId) {
  const payload = b64url(enc.encode(JSON.stringify({ pid: participantId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC })));
  return `${payload}.${await hmac(env.AUTH_SECRET, payload)}`;
}

async function verifyToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if ((await hmac(env.AUTH_SECRET, payload)) !== sig) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (!data.pid || data.exp < Date.now() / 1000) return null;
    return data.pid;
  } catch { return null; }
}

class HttpError extends Error {
  constructor(status, error, message, extra) { super(message || error); this.status = status; this.error = error; this.extra = extra; }
}

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'bad_request', 'Body must be JSON'); }
}

function requireAdmin(env, request) {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) throw new HttpError(401, 'unauthorized');
}

// ---------------------------------------------------------------- studies ----
function parseSettings(text) {
  let stored = {};
  try { stored = JSON.parse(text || '{}') || {}; } catch { /* keep defaults */ }
  return { ...SETTING_DEFAULTS, ...stored };
}

function publicSettings(settings) {
  const out = { ...settings };
  for (const k of PRIVATE_SETTINGS) delete out[k];
  return out;
}

/** Keep only known settings, coerced to the type of their default. */
function cleanSettings(input) {
  const out = {};
  for (const [k, def] of Object.entries(SETTING_DEFAULTS)) {
    if (input?.[k] === undefined) continue;
    out[k] = typeof def === 'boolean' ? Boolean(input[k]) : String(input[k]).trim().slice(0, 300);
  }
  if (out.login && !['email', 'smart', 'id'].includes(out.login)) throw new HttpError(400, 'bad_request', 'login must be email, smart or id');
  if (out.registration && !['open', 'invited'].includes(out.registration)) throw new HttpError(400, 'bad_request', 'registration must be open or invited');
  if (out.accountDb && !BINDING_RE.test(out.accountDb)) throw new HttpError(400, 'bad_request', 'accountDb must be a D1 binding name such as DB or DB_CARINA');
  return out;
}

async function loadStudy(env, code) {
  const c = String(code || '').trim().toLowerCase();
  const row = STUDY_RE.test(c) ? await env.DB.prepare('SELECT * FROM rai_studies WHERE code = ?').bind(c).first() : null;
  if (!row || !row.active) throw new HttpError(404, 'study');
  return { code: row.code, label: row.label || row.code, settings: parseSettings(row.settings) };
}

const publicStudy = (s) => ({ code: s.code, label: s.label, settings: publicSettings(s.settings) });
const completionInfo = (s) => ({ completionCode: s.settings.completionCode || '', completionUrl: s.settings.completionUrl || '' });

// ----------------------------------------------------------- participants ----
const publicParticipant = (p) => ({ id: p.id, identifier: p.identifier, study: p.study, source: p.source });

async function findParticipant(env, study, identifier) {
  return env.DB.prepare('SELECT * FROM rai_participants WHERE study = ? AND identifier = ?').bind(study, identifier).first();
}

/** Create the participant on first login (or reuse the invited row) and stamp the login time. */
async function signIn(env, study, identifier, source, external = {}) {
  let p = await findParticipant(env, study.code, identifier);
  if (!p) {
    if (study.settings.registration === 'invited' && !source.startsWith('smart')) throw new HttpError(403, 'notInvited');
    await env.DB.prepare('INSERT OR IGNORE INTO rai_participants (study, identifier, source, external_id, external_study, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(study.code, identifier, source, external.id ?? null, external.study ?? null, now()).run();
    p = await findParticipant(env, study.code, identifier);
  }
  await env.DB.prepare('UPDATE rai_participants SET last_login_at = ?, source = ?, external_id = COALESCE(?, external_id), external_study = COALESCE(?, external_study) WHERE id = ?')
    .bind(now(), source, external.id ?? null, external.study ?? null, p.id).run();
  return json({ token: await makeToken(env, p.id), participant: publicParticipant({ ...p, source }), study: publicStudy(study) });
}

async function requireParticipant(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const pid = await verifyToken(env, auth.replace(/^Bearer\s+/i, ''));
  if (!pid) throw new HttpError(401, 'unauthorized');
  const p = await env.DB.prepare('SELECT * FROM rai_participants WHERE id = ?').bind(pid).first();
  if (!p) throw new HttpError(401, 'unauthorized');
  return p;
}

// ------------------------------------------------------------------ login ----
/**
 * Sends the login code through Resend's HTTP API (https://resend.com). Swap this
 * function for another provider if preferred; nothing else depends on Resend.
 */
async function sendLoginEmail(env, email, code, study) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'RAI <onboarding@resend.dev>',
      to: [email],
      subject: `Your login code: ${code}`,
      text: `Your login code for ${study.label} is ${code}.\n\nEnter it on the page where you asked for it. The code is valid for ${CODE_TTL_MIN} minutes.\n\nIf you did not ask for this code, you can ignore this email.\n`,
    }),
  });
  if (!res.ok) {
    console.error('sendLoginEmail failed', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'emailFailed');
  }
}

const codeHash = (env, study, email, code) => hmac(env.AUTH_SECRET, `code:${study}:${email}:${code}`);

async function requestEmailCode(env, body) {
  const study = await loadStudy(env, body.study);
  if (study.settings.login !== 'email') throw new HttpError(400, 'login');
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'email');
  const devMode = env.DEV_SHOW_CODES === '1';
  if (!env.RESEND_API_KEY && !devMode) throw new HttpError(503, 'emailUnavailable');
  // Invitation-only studies answer the same way for unknown addresses, but send nothing.
  if (study.settings.registration === 'invited' && !(await findParticipant(env, study.code, email))) return json({ ok: true });

  const since = new Date(Date.now() - 3600000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM rai_email_codes WHERE study = ? AND email = ? AND created_at > ?').bind(study.code, email, since).first();
  if (recent.n >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'tooMany');

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rai_email_codes WHERE created_at < ?').bind(new Date(Date.now() - 24 * 3600000).toISOString()),
    env.DB.prepare('INSERT INTO rai_email_codes (study, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(study.code, email, await codeHash(env, study.code, email, code), minutesFromNow(CODE_TTL_MIN), now()),
  ]);
  if (devMode) return json({ ok: true, devCode: code });
  await sendLoginEmail(env, email, code, study);
  return json({ ok: true });
}

async function verifyEmailCode(env, body) {
  const study = await loadStudy(env, body.study);
  if (study.settings.login !== 'email') throw new HttpError(400, 'login');
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\D/g, '');
  const row = await env.DB.prepare('SELECT * FROM rai_email_codes WHERE study = ? AND email = ? AND expires_at > ? ORDER BY id DESC LIMIT 1').bind(study.code, email, now()).first();
  if (!row || row.attempts >= MAX_CODE_ATTEMPTS) throw new HttpError(401, 'code');
  if ((await codeHash(env, study.code, email, code)) !== row.code_hash) {
    await env.DB.prepare('UPDATE rai_email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    throw new HttpError(401, 'code');
  }
  await env.DB.prepare('DELETE FROM rai_email_codes WHERE study = ? AND email = ?').bind(study.code, email).run();
  return signIn(env, study, email, 'email');
}

/** Login with an existing SMART username + PIN, checked against a SMART `users` table (read only). */
async function smartLogin(env, body) {
  const study = await loadStudy(env, body.study);
  if (study.settings.login !== 'smart') throw new HttpError(400, 'login');
  const binding = study.settings.accountDb || 'DB';
  const accounts = BINDING_RE.test(binding) ? env[binding] : null;
  if (!accounts) throw new HttpError(500, 'server', `D1 binding ${binding} is not configured`);
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();
  const key = `smart:${binding}:${username}`;
  const attempts = await env.DB.prepare('SELECT * FROM rai_login_attempts WHERE key = ?').bind(key).first();
  if (attempts?.locked_until && new Date(attempts.locked_until) > new Date()) throw new HttpError(429, 'invalid', 'Too many attempts; try again later');

  const u = username ? await accounts.prepare('SELECT id, username, pin_hash, salt, study FROM users WHERE username = ?').bind(username).first() : null;
  const allowedTags = String(study.settings.smartStudy || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = u && (await hashPin(pin, u.salt)) === u.pin_hash && (!allowedTags.length || allowedTags.includes(u.study));
  if (!ok) {
    const failed = (attempts?.failed || 0) + 1;
    const locked = failed >= MAX_FAILED_LOGINS ? minutesFromNow(LOCK_MINUTES) : null;
    await env.DB.prepare('INSERT INTO rai_login_attempts (key, failed, locked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET failed = excluded.failed, locked_until = excluded.locked_until, updated_at = excluded.updated_at')
      .bind(key, locked ? 0 : failed, locked, now()).run();
    throw new HttpError(401, 'invalid');
  }
  if (attempts) await env.DB.prepare('DELETE FROM rai_login_attempts WHERE key = ?').bind(key).run();
  return signIn(env, study, u.username, `smart:${binding}`, { id: String(u.id), study: u.study });
}

async function idLogin(env, body) {
  const study = await loadStudy(env, body.study);
  if (study.settings.login !== 'id') throw new HttpError(400, 'login');
  const identifier = String(body.identifier || '').trim();
  if (!ID_RE.test(identifier)) throw new HttpError(400, 'identifier');
  return signIn(env, study, identifier, 'id');
}

// --------------------------------------------------------- administrations ----
async function progressOf(env, administrationId) {
  const r = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS last, COALESCE(SUM(CASE WHEN phase = 'test' THEN correct ELSE 0 END), 0) AS correct FROM rai_trials WHERE administration_id = ?")
    .bind(administrationId).first();
  // The nonsense words already shown, so a resumed sitting does not repeat them.
  const { results } = await env.DB.prepare('SELECT words FROM rai_trials WHERE administration_id = ? AND words IS NOT NULL').bind(administrationId).all();
  const usedWords = [...new Set(results.flatMap((w) => String(w.words).split(' ').filter(Boolean)))];
  return { nextSeq: r.last + 1, totalCorrect: r.correct, usedWords };
}

async function startAdministration(env, p, body) {
  const study = await loadStudy(env, p.study);
  const timepoint = TIMEPOINT_RE.test(String(body.timepoint || '')) ? String(body.timepoint) : '1';
  const debug = body.debug ? 1 : 0;

  if (!study.settings.repeatable && !debug) {
    const done = await env.DB.prepare("SELECT id, total_correct, n_trials FROM rai_administrations WHERE participant_id = ? AND timepoint = ? AND status = 'completed' AND debug = 0 LIMIT 1").bind(p.id, timepoint).first();
    if (done) throw new HttpError(409, 'completed', 'Already completed', { ...completionInfo(study), totalCorrect: done.total_correct, nTrials: done.n_trials });
  }

  const hours = Math.min(Math.max(num(body.resumeHours) ?? DEFAULT_RESUME_HOURS, 0), 720);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const open = await env.DB.prepare("SELECT * FROM rai_administrations WHERE participant_id = ? AND timepoint = ? AND status = 'started' AND debug = ? AND started_at > ? ORDER BY started_at DESC LIMIT 1")
    .bind(p.id, timepoint, debug, since).first();
  if (open) {
    const progress = await progressOf(env, open.id);
    return json({
      administration: { id: open.id, timepoint, startedAt: open.started_at, settings: JSON.parse(open.settings || '{}'), hasDemographics: Boolean(open.demographics) },
      resumed: true, ...progress,
    });
  }

  if (!body.id) throw new HttpError(400, 'bad_request', 'administration id required');
  const startedAt = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO rai_administrations
    (id, participant_id, study, timepoint, status, started_at, language, settings, n_trials, user_agent, screen, viewport, debug)
    VALUES (?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(String(body.id), p.id, p.study, timepoint, startedAt, body.language || null, JSON.stringify(body.settings || {}), num(body.nTrials),
      body.userAgent || null, body.screen || null, body.viewport || null, debug).run();
  return json({
    administration: { id: String(body.id), timepoint, startedAt, settings: body.settings || {}, hasDemographics: false },
    resumed: false, nextSeq: 1, totalCorrect: 0, usedWords: [],
  }, 201);
}

async function updateAdministration(env, p, id, body) {
  const a = await env.DB.prepare('SELECT * FROM rai_administrations WHERE id = ? AND participant_id = ?').bind(id, p.id).first();
  if (!a) throw new HttpError(404, 'not_found');
  if (body.demographics) {
    await env.DB.prepare('UPDATE rai_administrations SET demographics = ? WHERE id = ?').bind(JSON.stringify(body.demographics).slice(0, 2000), id).run();
  }
  if (body.status !== 'completed') return json({ ok: true });

  // Totals are computed from the stored trials, not taken from the browser.
  const s = await env.DB.prepare(`SELECT
      SUM(CASE WHEN phase = 'test' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN phase = 'test' THEN correct ELSE 0 END) AS correct,
      SUM(CASE WHEN phase = 'test' THEN timed_out ELSE 0 END) AS timeouts,
      AVG(CASE WHEN phase = 'test' AND timed_out = 0 THEN rt_ms END) AS mean_rt,
      SUM(CASE WHEN phase = 'attention' THEN 1 ELSE 0 END) AS att_total,
      SUM(CASE WHEN phase = 'attention' THEN correct ELSE 0 END) AS att_passed
    FROM rai_trials WHERE administration_id = ?`).bind(id).first();
  if (!a.debug && (s.done || 0) < TEST_TRIALS) throw new HttpError(409, 'incomplete', `Only ${s.done || 0} of ${TEST_TRIALS} test trials are stored`);
  if (a.status !== 'completed') {
    await env.DB.prepare("UPDATE rai_administrations SET status = 'completed', ended_at = ?, trials_completed = ?, total_correct = ?, timeouts = ?, mean_rt_ms = ?, attention_total = ?, attention_passed = ? WHERE id = ?")
      .bind(body.endedAt || now(), s.done || 0, s.correct || 0, s.timeouts || 0, s.mean_rt, s.att_total || 0, s.att_passed || 0, id).run();
  }
  const study = await loadStudy(env, p.study).catch(() => null);
  return json({ ok: true, totalCorrect: s.correct || 0, trialsCompleted: s.done || 0, nTrials: a.n_trials, ...(study && !a.debug ? completionInfo(study) : {}) });
}

async function saveTrials(env, p, trials) {
  if (!Array.isArray(trials) || !trials.length) return json({ saved: 0 });
  if (trials.length > MAX_TRIALS_PER_REQUEST) throw new HttpError(413, 'too_many', `Max ${MAX_TRIALS_PER_REQUEST} trials per request`);
  const ids = [...new Set(trials.map((t) => String(t.administrationId || '')))];
  const marks = ids.map(() => '?').join(',');
  const { results: owned } = await env.DB.prepare(`SELECT id FROM rai_administrations WHERE participant_id = ? AND id IN (${marks})`).bind(p.id, ...ids).all();
  const ownedIds = new Set(owned.map((r) => r.id));
  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO rai_trials
    (administration_id, participant_id, seq, phase, trial_num, trial_id, block, difficulty, probe, n_options, n_correct_options,
     correct, hits, misses, false_alarms, rt_ms, timed_out, premises, options, words, payload, client_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Records for an administration that is not this participant's are dropped (and reported as received).
  const batch = trials.filter((t) => ownedIds.has(String(t.administrationId))).map((t) => stmt.bind(
    String(t.administrationId), p.id, Number(t.seq) || 0, t.phase || null, t.trialNum == null ? null : String(t.trialNum), t.trialId == null ? null : String(t.trialId),
    num(t.block), num(t.difficulty), t.probe || null, num(t.nOptions), num(t.nCorrectOptions),
    num(t.correct), num(t.hits), num(t.misses), num(t.falseAlarms), num(t.rtMs), Number(t.timedOut) || 0,
    Array.isArray(t.premises) ? t.premises.join(' | ') : null, JSON.stringify(t.options ?? null),
    t.words ? Object.values(t.words).join(' ') : null, JSON.stringify(t), t.clientTime || null, now(),
  ));
  const results = batch.length ? await env.DB.batch(batch) : [];
  return json({ saved: results.reduce((n, r) => n + (r.meta?.changes || 0), 0), received: trials.length });
}

// ------------------------------------------------------------------ admin ----
async function adminStudies(env) {
  const { results } = await env.DB.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM rai_participants p WHERE p.study = s.code) AS participants,
      (SELECT COUNT(*) FROM rai_administrations a WHERE a.study = s.code AND a.status = 'completed' AND a.debug = 0) AS completed
    FROM rai_studies s ORDER BY s.created_at`).all();
  return json(results.map((r) => ({ code: r.code, label: r.label, active: Boolean(r.active), settings: parseSettings(r.settings), participants: r.participants, completed: r.completed, createdAt: r.created_at })));
}

async function adminSaveStudy(env, body) {
  const code = String(body.code || '').trim().toLowerCase();
  if (!STUDY_RE.test(code)) throw new HttpError(400, 'bad_request', 'code must be 2-40 characters: a-z, 0-9, _ or -');
  const existing = await env.DB.prepare('SELECT * FROM rai_studies WHERE code = ?').bind(code).first();
  const stored = existing ? JSON.parse(existing.settings || '{}') : {};
  const settings = { ...stored, ...cleanSettings(body.settings) };
  const label = body.label != null ? String(body.label).trim().slice(0, 120) : existing?.label || code;
  const active = body.active != null ? (body.active ? 1 : 0) : existing?.active ?? 1;
  await env.DB.prepare(`INSERT INTO rai_studies (code, label, settings, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET label = excluded.label, settings = excluded.settings, active = excluded.active, updated_at = excluded.updated_at`)
    .bind(code, label, JSON.stringify(settings), active, now(), now()).run();
  return json({ ok: true, code, label, active: Boolean(active), settings: parseSettings(JSON.stringify(settings)) });
}

async function adminParticipants(env, url) {
  const study = url.searchParams.get('study');
  const { results } = await env.DB.prepare(`SELECT p.id, p.study, p.identifier, p.source, p.invited, p.created_at, p.last_login_at,
      (SELECT COUNT(*) FROM rai_administrations a WHERE a.participant_id = p.id AND a.debug = 0) AS started,
      (SELECT COUNT(*) FROM rai_administrations a WHERE a.participant_id = p.id AND a.debug = 0 AND a.status = 'completed') AS completed,
      (SELECT a.total_correct || '/' || a.n_trials || ' (' || a.timepoint || ')' FROM rai_administrations a WHERE a.participant_id = p.id AND a.debug = 0 AND a.status = 'completed' ORDER BY a.ended_at DESC LIMIT 1) AS latest_score,
      (SELECT COUNT(*) FROM rai_trials t WHERE t.participant_id = p.id) AS trials
    FROM rai_participants p ${study ? 'WHERE p.study = ?' : ''} ORDER BY p.study, p.identifier LIMIT 5000`).bind(...(study ? [study] : [])).all();
  return json(results);
}

/** Add identifiers to a study ahead of time (needed for registration 'invited'). */
async function adminInvite(env, body) {
  const study = await loadStudy(env, body.study);
  const login = study.settings.login;
  const added = [];
  const errors = [];
  for (const raw of body.identifiers || []) {
    const identifier = login === 'id' ? String(raw).trim() : String(raw).trim().toLowerCase();
    const valid = login === 'email' ? EMAIL_RE.test(identifier) : ID_RE.test(identifier);
    if (!valid) { errors.push({ identifier, error: 'invalid' }); continue; }
    const res = await env.DB.prepare('INSERT OR IGNORE INTO rai_participants (study, identifier, source, invited, created_at) VALUES (?, ?, ?, 1, ?)')
      .bind(study.code, identifier, login === 'smart' ? `smart:${study.settings.accountDb || 'DB'}` : login, now()).run();
    if (res.meta.changes) added.push(identifier); else errors.push({ identifier, error: 'exists' });
  }
  return json({ added, errors });
}

/** Permanently remove one participant and everything recorded for them. */
async function adminDeleteParticipant(env, url) {
  const id = Number(url.searchParams.get('id'));
  const p = await env.DB.prepare('SELECT * FROM rai_participants WHERE id = ?').bind(id).first();
  if (!p) throw new HttpError(404, 'not_found');
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM rai_trials WHERE participant_id = ?').bind(id),
    env.DB.prepare('DELETE FROM rai_administrations WHERE participant_id = ?').bind(id),
    env.DB.prepare('DELETE FROM rai_email_codes WHERE study = ? AND email = ?').bind(p.study, p.identifier),
    env.DB.prepare('DELETE FROM rai_participants WHERE id = ?').bind(id),
  ]);
  return json({ deleted: p.identifier, trials: results[0].meta.changes, administrations: results[1].meta.changes });
}

const EXPORTS = {
  participants: {
    sql: 'SELECT p.id AS participant_id, p.study, p.identifier, p.source, p.external_id, p.external_study, p.invited, p.created_at, p.last_login_at FROM rai_participants p',
    key: 'p.id', keyAlias: 'participant_id', study: 'p.study', identifier: 'p.identifier', time: null,
  },
  administrations: {
    sql: `SELECT a.rowid AS _k, p.identifier, a.id AS administration_id, a.participant_id, a.study, a.timepoint, a.status, a.started_at, a.ended_at, a.language,
      a.n_trials, a.trials_completed, a.total_correct, a.timeouts, a.mean_rt_ms, a.attention_total, a.attention_passed,
      a.demographics, a.settings, a.user_agent, a.screen, a.viewport, a.debug
      FROM rai_administrations a JOIN rai_participants p ON p.id = a.participant_id`,
    key: 'a.rowid', keyAlias: '_k', study: 'a.study', identifier: 'p.identifier', time: 'a.started_at',
  },
  trials: {
    sql: `SELECT t.id AS trial_row, p.identifier, a.study, a.timepoint, a.debug, t.administration_id, t.participant_id, t.seq, t.phase, t.trial_num, t.trial_id, t.block, t.difficulty,
      t.probe, t.n_options, t.n_correct_options, t.correct, t.hits, t.misses, t.false_alarms, t.rt_ms, t.timed_out, t.premises, t.options, t.words, t.client_time, t.created_at, t.payload
      FROM rai_trials t JOIN rai_administrations a ON a.id = t.administration_id JOIN rai_participants p ON p.id = t.participant_id`,
    key: 't.id', keyAlias: 'trial_row', study: 'a.study', identifier: 'p.identifier', time: 't.created_at',
  },
};

/**
 * Streams a table as CSV (or JSON) in pages of 500 rows.
 * Filters: ?study=  ?identifier=  ?since=ISO  ?until=ISO  ?format=json  ?payload=0 (trials: leave out the JSON payload column)
 */
async function exportTable(env, url, table) {
  const spec = EXPORTS[table];
  if (!spec) throw new HttpError(404, 'not_found');
  const where = [];
  const args = [];
  const q = url.searchParams;
  if (q.get('study')) { where.push(`${spec.study} = ?`); args.push(q.get('study')); }
  if (q.get('identifier')) { where.push(`${spec.identifier} = ?`); args.push(q.get('identifier')); }
  for (const [param, op] of [['since', '>='], ['until', '<']]) {
    if (q.get(param) && spec.time) { where.push(`${spec.time} ${op} ?`); args.push(q.get(param)); }
  }
  const asJson = q.get('format') === 'json';
  const dropPayload = q.get('payload') === '0';
  const PAGE = 500;
  const esc = (v) => { const t = v == null ? '' : String(v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let after = -1, first = true, cols = null;
      try {
        if (asJson) controller.enqueue(encoder.encode('['));
        for (;;) {
          const sql = `${spec.sql} WHERE ${[...where, `${spec.key} > ?`].join(' AND ')} ORDER BY ${spec.key} LIMIT ?`;
          const { results } = await env.DB.prepare(sql).bind(...args, after, PAGE).all();
          for (const r of results) {
            after = r[spec.keyAlias];
            delete r._k;
            if (dropPayload) delete r.payload;
            if (asJson) controller.enqueue(encoder.encode((first ? '' : ',') + JSON.stringify(r)));
            else {
              if (first) { cols = Object.keys(r); controller.enqueue(encoder.encode(cols.join(',') + '\n')); }
              controller.enqueue(encoder.encode(cols.map((c) => esc(r[c])).join(',') + '\n'));
            }
            first = false;
          }
          if (results.length < PAGE) break;
        }
        if (asJson) controller.enqueue(encoder.encode(']'));
        controller.close();
      } catch (e) { controller.error(e); }
    },
  });
  return new Response(stream, {
    headers: asJson
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rai-${table}.csv"` },
  });
}

// ---------------------------------------------------------------- router ----
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (path === '/health' && m === 'GET') return json({ ok: true, time: now() });

  const st = path.match(/^\/studies\/([^/]+)$/);
  if (st && m === 'GET') return json(publicStudy(await loadStudy(env, decodeURIComponent(st[1]))));

  if (path === '/auth/email/request' && m === 'POST') return requestEmailCode(env, await readJson(request));
  if (path === '/auth/email/verify' && m === 'POST') return verifyEmailCode(env, await readJson(request));
  if (path === '/auth/smart' && m === 'POST') return smartLogin(env, await readJson(request));
  if (path === '/auth/id' && m === 'POST') return idLogin(env, await readJson(request));

  if (path.startsWith('/admin/')) {
    requireAdmin(env, request);
    if (path === '/admin/studies' && m === 'GET') return adminStudies(env);
    if (path === '/admin/studies' && m === 'PUT') return adminSaveStudy(env, await readJson(request));
    if (path === '/admin/participants' && m === 'GET') return adminParticipants(env, url);
    if (path === '/admin/participants' && m === 'POST') return adminInvite(env, await readJson(request));
    if (path === '/admin/participants' && m === 'DELETE') return adminDeleteParticipant(env, url);
    const ex = path.match(/^\/admin\/export\/(\w+)$/);
    if (ex && m === 'GET') return exportTable(env, url, ex[1]);
    throw new HttpError(404, 'not_found');
  }

  const p = await requireParticipant(env, request);

  if (path === '/me' && m === 'GET') return json({ participant: publicParticipant(p), study: publicStudy(await loadStudy(env, p.study)) });
  if (path === '/administrations' && m === 'POST') return startAdministration(env, p, await readJson(request));
  const am = path.match(/^\/administrations\/([^/]+)$/);
  if (am && m === 'PATCH') return updateAdministration(env, p, decodeURIComponent(am[1]), await readJson(request));
  if (path === '/trials' && m === 'POST') return saveTrials(env, p, (await readJson(request)).trials);

  throw new HttpError(404, 'not_found');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: e instanceof HttpError ? e.error : 'server', message: e.message, ...(e.extra || {}) }, status, cors);
    }
  },
};
