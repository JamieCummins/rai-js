import { BackendError } from './errors.js';
import { storage, sessionStore } from './storage.js';
import { toCsv } from '../engine/csv.js';

const SESSION = 'rai.local.session';
const ADMINS = 'rai.local.administrations';
const trialsKey = (who) => `rai.local.trials.${who}`;

/**
 * Browser-only backend for demos, piloting and offline testing: nothing leaves
 * this browser. Any study code is accepted and no identity is verified. Study
 * settings come from studyDefaults in app/config.js and can be overridden in
 * the link, e.g. ?backend=local&login=id&attentionChecks=1&demographics=1
 */
export function createLocalBackend({ studyDefaults, params }) {
  const settings = { ...studyDefaults };
  for (const [k, def] of Object.entries(studyDefaults)) {
    if (!params?.has(k)) continue;
    const v = params.get(k);
    settings[k] = typeof def === 'boolean' ? !['0', 'false', ''].includes(v) : v;
  }
  let current = null;
  const who = () => `${current.study}:${current.identifier}`;
  const signIn = (study, identifier, source) => {
    current = { id: `${study}:${identifier}`, identifier, study, source };
    sessionStore.set(SESSION, current);
    return { participant: current, study: { code: study, label: 'Local demo', settings } };
  };
  const admins = () => storage.get(ADMINS, []);

  return {
    type: 'local',
    async getStudy(code) { return { code, label: 'Local demo', settings }; },
    async requestEmailCode() { return { ok: true, devCode: '000000' }; },
    async verifyEmailCode({ study, email, code }) {
      if (code !== '000000') throw new BackendError('code');
      return signIn(study, email, 'email');
    },
    async smartLogin({ study, username }) { return signIn(study, username, 'smart:local'); },
    async idLogin({ study, identifier }) { return signIn(study, identifier, 'id'); },
    async restore() {
      current = sessionStore.get(SESSION);
      return current ? { participant: current, study: { code: current.study, label: 'Local demo', settings } } : null;
    },
    async logout() { sessionStore.remove(SESSION); },
    async startAdministration(body) {
      const list = admins();
      const mine = list.filter((a) => a.participant === who() && a.timepoint === body.timepoint && Boolean(a.debug) === Boolean(body.debug));
      const done = mine.find((a) => a.status === 'completed');
      if (done && !settings.repeatable && !body.debug) throw new BackendError('completed', 'Already completed', { totalCorrect: done.totalCorrect, nTrials: done.nTrials, completionCode: settings.completionCode, completionUrl: settings.completionUrl });
      const open = mine.find((a) => a.status === 'started');
      if (open) {
        const trials = storage.get(trialsKey(who()), []).filter((t) => t.administrationId === open.id);
        return {
          administration: { id: open.id, timepoint: open.timepoint, startedAt: open.startedAt, settings: open.settings, hasDemographics: Boolean(open.demographics) },
          resumed: true,
          nextSeq: Math.max(0, ...trials.map((t) => t.seq)) + 1,
          totalCorrect: trials.filter((t) => t.phase === 'test').reduce((n, t) => n + t.correct, 0),
          usedWords: trials.flatMap((t) => Object.values(t.words || {})),
        };
      }
      const a = { id: body.id, participant: who(), timepoint: body.timepoint, status: 'started', startedAt: new Date().toISOString(), settings: body.settings, nTrials: body.nTrials, debug: Boolean(body.debug) };
      storage.set(ADMINS, [...list, a]);
      return { administration: { id: a.id, timepoint: a.timepoint, startedAt: a.startedAt, settings: a.settings, hasDemographics: false }, resumed: false, nextSeq: 1, totalCorrect: 0, usedWords: [] };
    },
    async updateAdministration(id, body) {
      const list = admins();
      const a = list.find((x) => x.id === id);
      if (!a) throw new BackendError('server', 'unknown administration');
      if (body.demographics) a.demographics = body.demographics;
      let out = { ok: true };
      if (body.status === 'completed') {
        const test = storage.get(trialsKey(who()), []).filter((t) => t.administrationId === id && t.phase === 'test');
        a.status = 'completed';
        a.endedAt = new Date().toISOString();
        a.totalCorrect = test.reduce((n, t) => n + t.correct, 0);
        out = { ok: true, totalCorrect: a.totalCorrect, trialsCompleted: test.length, nTrials: a.nTrials, completionCode: settings.completionCode, completionUrl: settings.completionUrl };
      }
      storage.set(ADMINS, list);
      return out;
    },
    async saveTrials(trials) {
      const key = trialsKey(who());
      const list = storage.get(key, []);
      const seen = new Set(list.map((t) => `${t.administrationId}:${t.seq}`));
      for (const t of trials) if (!seen.has(`${t.administrationId}:${t.seq}`)) list.push(t);
      if (!storage.set(key, list)) throw new BackendError('server', 'localStorage full');
      return { saved: trials.length };
    },
    /** CSV of everything stored in this browser for the current participant. */
    exportCsv() {
      const list = storage.get(trialsKey(who()), []);
      if (!list.length) return '';
      const flat = list.map((t) => ({ ...t, premises: t.premises.join(' | '), options: JSON.stringify(t.options), words: Object.values(t.words).join(' '), row: JSON.stringify(t.row) }));
      return toCsv(flat, Object.keys(flat[0]));
    },
  };
}
