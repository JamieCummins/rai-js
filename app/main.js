import baseConfig, { mergeConfig } from './config.js';
import { createBackend, EMAIL_RE, ID_RE } from './data/index.js';
import { createTrialQueue } from './data/queue.js';
import { uuid } from './data/storage.js';
import { loadContent } from './engine/content.js';
import { WordPool, bucketsFromRows, buildTrial, scoreTrial, buildSequence, literalWords } from './engine/trials.js';
import { fill, fullscreen, escapeHtml } from './ui/dom.js';
import * as screens from './ui/screens.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

let config = baseConfig;
if (DEBUG) config = mergeConfig(config, config.debug);
if (params.get('backend') === 'local') config = mergeConfig(config, { backend: { type: 'local' } });
// ?api= is for local development only: on a hosted site it would let a link send logins to another server.
const LOCAL_PAGE = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (params.get('api') && LOCAL_PAGE) config = mergeConfig(config, { backend: { type: 'rest', url: params.get('api') } });

const lang = config.languages.includes(params.get('lang')) ? params.get('lang') : config.language;
const studyCode = (params.get('study') || config.defaultStudy || (config.backend.type === 'local' ? 'demo' : '')).trim().toLowerCase();
const timepoint = /^[A-Za-z0-9_-]{1,32}$/.test(params.get('t') || '') ? params.get('t') : '1';

class CodedError extends Error { constructor(code) { super(code); this.code = code; } }

// ------------------------------------------------------------------ login ----
async function emailLogin(backend, strings) {
  let email = '';
  for (;;) {
    let devCode = null;
    await screens.form({
      strings,
      intro: `<p>${strings.login.emailIntro}</p>`,
      fields: [{ name: 'email', label: strings.login.emailLabel, type: 'email', attrs: 'autocomplete="email" inputmode="email"', value: email }],
      submit: strings.login.sendCode,
      onSubmit: async (v) => {
        email = v.email.toLowerCase();
        if (!EMAIL_RE.test(email)) throw new CodedError('email');
        devCode = (await backend.requestEmailCode({ study: studyCode, email })).devCode || null;
      },
    });
    const result = await screens.form({
      strings,
      intro: `<p>${fill(strings.login.codeIntro, { email })}</p>`,
      fields: [{ name: 'code', label: strings.login.codeLabel, attrs: 'autocomplete="one-time-code" inputmode="numeric" maxlength="8"' }],
      note: devCode ? fill(strings.login.devCode, { code: devCode }) : '',
      submit: strings.login.verify,
      links: [{ label: strings.login.otherEmail, value: null }],
      onSubmit: (v) => backend.verifyEmailCode({ study: studyCode, email, code: v.code }),
    });
    if (result) return result;
  }
}

function smartLogin(backend, strings) {
  return screens.form({
    strings,
    intro: `<p>${strings.login.smartIntro}</p>`,
    fields: [
      { name: 'username', label: strings.login.usernameLabel, attrs: 'autocomplete="username" autocapitalize="none"' },
      { name: 'pin', label: strings.login.pinLabel, type: 'password', attrs: 'autocomplete="current-password" inputmode="numeric"' },
    ],
    submit: strings.login.logIn,
    onSubmit: (v) => backend.smartLogin({ study: studyCode, username: v.username.toLowerCase(), pin: v.pin }),
  });
}

const linkId = () => (params.get('pid') || params.get('PROLIFIC_PID') || params.get('id') || '').trim();

async function idLogin(backend, strings, settings, { ignoreLink = false } = {}) {
  const fromLink = ignoreLink ? '' : linkId();
  if (ID_RE.test(fromLink)) {
    try { return await backend.idLogin({ study: studyCode, identifier: fromLink }); } catch (e) { console.warn('login with the ID in the link failed', e); }
  }
  return screens.form({
    strings,
    intro: `<p>${fill(strings.login.idIntro, { label: settings.idLabel })}</p>`,
    fields: [{ name: 'identifier', label: settings.idLabel, attrs: 'autocomplete="off" autocapitalize="none"', value: fromLink }],
    submit: strings.ui.continue,
    onSubmit: (v) => {
      if (!ID_RE.test(v.identifier)) throw new CodedError('identifier');
      return backend.idLogin({ study: studyCode, identifier: v.identifier });
    },
  });
}

async function login(backend, strings, study) {
  const s = { ...config.studyDefaults, ...study.settings };
  let ignoreLink = false;
  // A login left in this tab (after a reload) is only continued once the person has confirmed it is
  // theirs, and never when the link names a different participant.
  const restored = await backend.restore();
  if (restored) {
    const who = restored.participant.identifier;
    const sameStudy = restored.participant.study === study.code;
    const otherInLink = s.login === 'id' && ID_RE.test(linkId()) && linkId() !== who;
    if (sameStudy && !otherInLink) {
      const choice = await screens.message({
        html: `<p>${fill(strings.login.loggedInAs, { identifier: escapeHtml(who) })}</p>`,
        button: strings.ui.continue, link: strings.login.notMe,
      });
      if (choice !== 'link') return restored;
      ignoreLink = true;
    }
    await backend.logout();
  }
  if (s.login === 'smart') return smartLogin(backend, strings);
  if (s.login === 'id') return idLogin(backend, strings, s, { ignoreLink });
  return emailLogin(backend, strings);
}

// ------------------------------------------------------------------- test ----
function demographics(strings) {
  return screens.form({
    strings,
    intro: `<p>${strings.demographics.intro}</p>`,
    fields: [
      { name: 'age', label: strings.demographics.age, type: 'number', attrs: 'min="5" max="120" inputmode="numeric"' },
      { name: 'gender', label: strings.demographics.gender },
    ],
    submit: strings.ui.continue,
    onSubmit: (v) => {
      const age = Number(v.age);
      if (!Number.isInteger(age) || age < 5 || age > 120 || !v.gender) throw new CodedError('demographics');
      return { age, gender: v.gender };
    },
  });
}

async function finish({ backend, strings, settings, info, text }) {
  fullscreen.release();
  screens.completion({
    strings,
    text,
    score: settings.showScore && info.nTrials ? { correct: info.totalCorrect ?? 0, total: info.nTrials } : null,
    code: info.completionCode,
    url: info.completionUrl,
    onDownload: backend.exportCsv ? () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([backend.exportCsv()], { type: 'text/csv' }));
      a.download = 'rai-data.csv';
      a.click();
    } : null,
  });
  await backend.logout();
}

async function run() {
  const strings = (await import(`./i18n/${lang}.js`)).default;
  document.title = strings.title;
  if (!studyCode) { screens.fatal(strings.errors.noStudy); return; }

  const backend = createBackend(config, params);
  let study;
  let content;
  try {
    [study, content] = await Promise.all([backend.getStudy(studyCode), loadContent(lang)]);
  } catch (e) {
    screens.fatal(strings.errors[e.code] || strings.errors.load);
    return;
  }

  const session = await login(backend, strings, study);
  const participant = session.participant;
  const settings = { ...config.studyDefaults, ...(session.study || study).settings };
  if (settings.fullscreen) fullscreen.keep();
  screens.loading(strings);

  // Upload anything left over from an interrupted sitting before asking where to continue.
  const queue = createTrialQueue(backend, { owner: `${study.code}:${participant.identifier}`, batchSize: config.data.batchSize, flushIntervalMs: config.data.flushIntervalMs });
  await queue.flush();

  const planned = { practice: settings.practice, attentionChecks: settings.attentionChecks, maxTrials: config.maxTrials || 0, fromTrial: DEBUG ? Number(params.get('from')) || 0 : 0, breakAfterTrials: config.breakAfterTrials };
  const sequenceFor = (p) => buildSequence({ ...content, settings: p, breakAfterTrials: p.breakAfterTrials || [], maxTrials: p.maxTrials || 0, fromTrial: p.fromTrial || 0 });
  const plannedSequence = sequenceFor(planned);
  let start;
  try {
    start = await backend.startAdministration({
      id: uuid(), timepoint, language: lang, debug: DEBUG, settings: planned, nTrials: plannedSequence.testCount, resumeHours: config.resumeHours,
      userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}`,
    });
  } catch (e) {
    if (e.code === 'completed') { await finish({ backend, strings, settings, info: e.data || {}, text: strings.alreadyCompleted }); return; }
    screens.fatal(strings.errors[e.code] || strings.errors.server);
    return;
  }

  // A resumed administration is rebuilt from the settings it was started with.
  const admin = start.administration;
  const used = { ...planned, ...(start.resumed ? admin.settings : {}) };
  const sequence = start.resumed ? sequenceFor(used) : plannedSequence;
  const { items, practiceCount, mainTotal } = sequence;
  let nextSeq = start.nextSeq;
  let totalCorrect = start.totalCorrect;
  // Words that must not be drawn: those in the practice trials and instructions, and those already
  // shown in this administration (stored on the server, or still waiting to be uploaded).
  const usedWords = [...literalWords(content.practice), ...(start.usedWords || [])];
  for (const t of queue.items) {
    if (t.administrationId !== admin.id) continue;
    usedWords.push(...Object.values(t.words || {}));
    if (t.seq < nextSeq) continue;
    nextSeq = t.seq + 1;
    if (t.phase === 'test') totalCorrect += t.correct;
  }
  queue.start();

  // --- before the first trial --------------------------------------------------
  const seconds = Math.round(config.trial.timeoutMs / 1000);
  const limit = seconds === 60 ? strings.limitMinute : fill(strings.limitSeconds, { seconds });
  const firstBreak = sequence.items.some((x) => x.breakAfter) ? (used.breakAfterTrials || [])[0] : 0;
  const beginParams = { total: mainTotal, breaks: firstBreak ? fill(strings.breaksEvery, { every: firstBreak }) : '' };

  if (nextSeq > 1) {
    await screens.message({ html: `<p>${strings.welcomeBack}</p>`, button: strings.ui.continue });
  } else {
    if (settings.demographics && !admin.hasDemographics) {
      const answers = await demographics(strings);
      try { await backend.updateAdministration(admin.id, { demographics: answers }); } catch (e) { console.warn('saving demographics failed', e); }
    }
    for (const html of strings.instructions) await screens.message({ html: `<p>${html}</p>`, button: strings.ui.continue });
    const last = fill(strings.instructionsLast, { limit });
    if (practiceCount) await screens.message({ html: `<p>${last}<br><br>${strings.practiceIntro}</p>`, button: strings.ui.begin });
    else await screens.message({ html: `<p>${last}</p>`, button: strings.ui.continue });
  }

  // --- trials ------------------------------------------------------------------
  const pool = new WordPool(bucketsFromRows(content.syllables), Math.random, usedWords);
  for (let i = nextSeq - 1; i < items.length; i++) {
    const item = items[i];
    if (i === practiceCount) {
      const html = fill(practiceCount ? strings.beginPracticeDone : strings.beginNoPractice, beginParams);
      await screens.message({ html: `<p>${html}</p>`, button: strings.ui.begin });
    }
    await screens.fixation(config.trial.itiMs);
    const t = buildTrial(item.row, pool.wordsFor(item.row));
    const shownAt = new Date().toISOString();
    const progress = fill(item.phase === 'practice' ? strings.trial.practiceProgress : strings.trial.progress, { n: item.label, total: item.total });
    const response = await screens.trial({ trial: t, progress, strings, config });
    const score = scoreTrial(t, response.selected);
    if (response.timedOut) score.correct = 0; // as in the original: no submission within the limit is an error
    if (item.phase === 'test') totalCorrect += score.correct;

    queue.push({
      administrationId: admin.id, seq: item.seq, participantId: participant.id, identifier: participant.identifier, study: study.code, timepoint,
      phase: item.phase, position: item.label,
      trialNum: item.row.trial_num ?? item.row.check_id, trialId: item.row.trial_id ?? null,
      block: item.row.block ?? null, difficulty: item.row.difficulty ?? null,
      probe: t.probe, premises: t.premises,
      options: t.options.map((o, j) => ({ text: o.text, template: o.template, truth: o.truth, selected: response.selected.includes(j) })),
      nOptions: t.options.length, nCorrectOptions: t.correctIndexes.length,
      ...score, rtMs: response.rtMs, timedOut: response.timedOut,
      words: t.words, row: item.row,
      fullscreen: fullscreen.active() ? 1 : 0, viewport: `${innerWidth}x${innerHeight}`,
      shownAt, clientTime: new Date().toISOString(),
    });

    if (item.breakAfter && i < items.length - 1) await screens.message({ html: `<p>${strings.breakScreen}</p>`, button: strings.ui.continue });
  }

  // --- finish: nothing is marked complete until every trial is on the server ---
  screens.loading({ ui: { loading: strings.saving } });
  let info = null;
  while (!info) {
    await queue.flush();
    if (!queue.pending) {
      try { info = await backend.updateAdministration(admin.id, { status: 'completed', endedAt: new Date().toISOString() }); } catch (e) { console.warn('completing the administration failed', e); }
    }
    if (!info) {
      await screens.message({ html: `<p>${strings.savingFailed}</p>`, button: strings.ui.retry });
      screens.loading({ ui: { loading: strings.saving } });
    }
  }
  queue.stop();
  await finish({ backend, strings, settings, info: { nTrials: sequence.testCount, totalCorrect, ...info }, text: strings.completion });
}

run().catch((e) => {
  console.error(e);
  screens.fatal('Something went wrong. Please reload the page to continue.');
});
