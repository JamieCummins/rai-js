-- RAI database schema (Cloudflare D1 / SQLite).
--
-- Every table is prefixed rai_ so this can live in the same D1 database as the
-- SMART training tables (users, progress, sessions, trials) without touching
-- them. All statements are CREATE ... IF NOT EXISTS: applying this file to a
-- database that is in use is safe and changes no existing table.

-- One row per study (a research study, a consulting client, a pilot, ...).
-- `settings` is a JSON object; see studyDefaults in app/config.js.
CREATE TABLE IF NOT EXISTS rai_studies (
  code TEXT PRIMARY KEY,
  label TEXT,
  settings TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

-- One row per person per study. `identifier` is the email address, SMART
-- username or participant ID, depending on the study's login method.
CREATE TABLE IF NOT EXISTS rai_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study TEXT NOT NULL,
  identifier TEXT NOT NULL,
  source TEXT NOT NULL,          -- 'email' | 'id' | 'smart:<D1 binding>'
  external_id TEXT,              -- users.id of the SMART account (login 'smart')
  external_study TEXT,           -- users.study of the SMART account (login 'smart')
  invited INTEGER DEFAULT 0,     -- 1 when added through admin.html
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE(study, identifier)
);

-- One-time login codes sent by email (only a hash of the code is stored).
CREATE TABLE IF NOT EXISTS rai_email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rai_email_codes_email ON rai_email_codes(study, email, created_at);

-- Failed SMART username + PIN attempts. Kept here so that this worker never
-- writes to the SMART users table.
CREATE TABLE IF NOT EXISTS rai_login_attempts (
  key TEXT PRIMARY KEY,
  failed INTEGER DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT
);

-- One row per sitting of the test.
CREATE TABLE IF NOT EXISTS rai_administrations (
  id TEXT PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES rai_participants(id),
  study TEXT NOT NULL,
  timepoint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',   -- 'started' | 'completed'
  started_at TEXT,
  ended_at TEXT,
  language TEXT,
  settings TEXT,                 -- JSON snapshot of what was presented (practice, attention checks, ...)
  demographics TEXT,             -- JSON, when the study collects them
  n_trials INTEGER,              -- test trials planned
  trials_completed INTEGER,      -- test trials answered (filled in on completion)
  total_correct INTEGER,         -- test trials correct (filled in on completion)
  timeouts INTEGER,
  mean_rt_ms REAL,
  attention_total INTEGER,
  attention_passed INTEGER,
  user_agent TEXT,
  screen TEXT,
  viewport TEXT,
  debug INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rai_administrations_participant ON rai_administrations(participant_id, timepoint, started_at);
CREATE INDEX IF NOT EXISTS rai_administrations_study ON rai_administrations(study, started_at);

-- One row per trial (practice, test and attention-check trials).
CREATE TABLE IF NOT EXISTS rai_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  administration_id TEXT NOT NULL,
  participant_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,          -- position in the administration, 1-based
  phase TEXT,                    -- 'practice' | 'test' | 'attention'
  trial_num TEXT,                -- trial_num (test, practice) or check_id (attention)
  trial_id TEXT,
  block INTEGER,
  difficulty INTEGER,
  probe TEXT,                    -- 'TRUE' | 'FALSE'
  n_options INTEGER,
  n_correct_options INTEGER,
  correct INTEGER,
  hits INTEGER,
  misses INTEGER,
  false_alarms INTEGER,
  rt_ms REAL,
  timed_out INTEGER,
  premises TEXT,                 -- as shown, joined with " | "
  options TEXT,                  -- JSON: [{text, template, truth, selected}] in displayed order
  words TEXT,                    -- nonsense words used, in placeholder order
  payload TEXT,                  -- full JSON record including the content row
  client_time TEXT,
  created_at TEXT,
  UNIQUE(administration_id, seq)
);
CREATE INDEX IF NOT EXISTS rai_trials_participant ON rai_trials(participant_id, created_at);
