/**
 * RAI configuration. Task parameters that apply to every study live here.
 * Per-study choices (login method, attention checks, demographics, completion
 * code, ...) are stored on the server and edited in admin.html; `studyDefaults`
 * below documents them and is what the browser-only backend uses.
 *
 * URL parameters:
 *   ?study=CODE         which study this link belongs to (required unless defaultStudy is set)
 *   ?t=pre              timepoint label for this administration (default: "1")
 *   ?pid=...            participant identifier for studies with login "id" (PROLIFIC_PID also works)
 *   ?debug              short run (see `debug` below); the administration is flagged as debug
 *   ?from=81            (debug only) start the test at this trial, e.g. to preview a block
 *   ?backend=local      browser-only backend, no server (demos, piloting)
 *   ?api=http://...     REST backend base URL (overrides backend.url); only when the page is served from localhost
 */
export default {
  language: 'en',
  languages: ['en'],

  backend: {
    type: 'rest',                                      // 'rest' (server/API.md) or 'local' (this browser only)
    url: 'https://rai-api.zita-meijer.workers.dev',    // printed by `npx wrangler deploy`
  },

  // Used when the link has no ?study=. Leave empty to require a study link.
  defaultStudy: '',

  trial: {
    timeoutMs: 60000,          // no submission within this time ends the trial as incorrect
    itiMs: 250,                // fixation cross between trials
    showTimer: true,
    requireSelection: false,   // true: Submit stays disabled until at least one option is selected
  },

  // Offer a break after these test trials (trial_num in content/trials/<lang>.csv).
  breakAfterTrials: [48, 96],

  // An unfinished administration is continued on the next login if it was started this recently.
  resumeHours: 24,

  data: {
    batchSize: 5,              // trials per upload
    flushIntervalMs: 15000,
  },

  /**
   * Per-study settings and their defaults. On the REST backend these come from
   * the server (admin.html, "Studies"); anything a study does not set falls back
   * to the values here.
   */
  studyDefaults: {
    login: 'email',            // 'email' (one-time code by email), 'smart' (SMART username + PIN), 'id' (typed or from the link)
    registration: 'open',      // 'open', or 'invited' (only identifiers added in admin.html may take part)
    idLabel: 'Participant ID', // field label for login "id"
    practice: true,            // the 3 practice trials
    attentionChecks: false,    // the 6 attention-check trials
    demographics: false,       // age and gender questions before the instructions
    completionCode: '',        // shown on the final screen when set (e.g. a Prolific code)
    completionUrl: '',         // link offered on the final screen when set (e.g. a Prolific return URL)
    showScore: false,          // show the number of correct trials on the final screen
    repeatable: false,         // false: one completed administration per participant and timepoint
    fullscreen: true,          // enter fullscreen on the first click and re-enter if it is left
  },

  // Overrides applied when the page is opened with ?debug
  debug: {
    maxTrials: 8,
    trial: { timeoutMs: 20000 },
    breakAfterTrials: [4],
  },
};

/** Deep-merge helper used for debug overrides and study settings. */
export function mergeConfig(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeConfig(base[k] || {}, v) : v;
  }
  return out;
}
