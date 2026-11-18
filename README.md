# Relational Abilities Index (RAI), multiple-choice version

A web version of the multiple-choice Relational Abilities Index: 128 trials in
8 blocks, in which participants read two to four statements relating made-up
words and select every response option that is true (or false) given those
statements. It is the measure that accompanies the SMART training programme.

The task is a plain static site (ES modules, no build step). Data are stored
through a small JSON API; the reference server is a Cloudflare Worker with a
D1 database (`server/cloudflare`), sharing the database used by SMART.

This build replaces the lab.js version used in Experiment 3 of the validation
studies (`validating-multiple-choice-rai`). The trial content and procedure
are the same; the differences are listed at the end of this file.

## Running a study

1. Deploy the server once (`server/cloudflare/README.md`) and put its URL in
   `app/config.js`.
2. Host this folder as a static site (GitHub Pages: Settings, Pages, deploy
   from the `main` branch).
3. Open `admin.html`, enter the API URL and admin token, and create a study.
4. Send participants the study's link: `https://<site>/?study=CODE`.

Each study chooses how its participants identify themselves and which
optional parts of the procedure it uses:

| Choice | Options |
| --- | --- |
| Login | Email address with a one-time code sent by email (default); SMART username + PIN; or a participant ID that is typed in or passed in the link (`?pid=`, `?PROLIFIC_PID=`) |
| Who may take part | Anyone with the link (default), or only participants added in `admin.html` |
| Practice trials | on (default) or off |
| Attention checks | off (default) or on: 6 extra trials, 134 in total |
| Demographics | off (default) or on: age and gender |
| Completion code and link | none (default), or shown on the final screen |
| Show score at the end | off (default) or on |
| Fullscreen | on (default) or off |

A participant identifier is always required. For repeated measurement, add a
timepoint to the link, for example `?study=CODE&t=pre` and
`?study=CODE&t=post`. A participant can complete each timepoint once (unless
the study is set to be repeatable). Someone who is interrupted and logs in
again within 24 hours continues from the trial they had reached.

## Procedure

- Three instruction screens, 3 practice trials (no feedback), then the test.
- Every trial shows the statements, the question "select all statements which
  are TRUE" (or FALSE) and 2 to 4 response buttons, in random positions.
  Participants select any number of buttons and press Submit.
- A trial is correct only if exactly the correct buttons were selected. Each
  trial has a 60 second limit; a trial that runs out of time is incorrect.
- The made-up words are drawn at random for each trial and are not repeated
  within an administration, including after an interruption. The words used
  in the practice trials and instructions are not drawn.
- A break is offered after trials 48 and 96.

Timing, break positions and upload settings are in `app/config.js`.

## Content

| File | Contents |
| --- | --- |
| `content/trials/en.csv` | the 128 test trials, in presentation order |
| `content/practice/en.csv` | the 3 practice trials |
| `content/attention_checks/en.csv` | the 6 attention checks; `after_trial` is the test trial each one follows |
| `content/syllables.csv` | the made-up words, one column per placeholder |

In the trial files, the digits 1 to 6 are placeholders for made-up words.
`true_statements` and `false_statements` are comma-separated pools from which
`n_true_answers` and `n_false_answers` options are drawn on each presentation.
`<br>` marks a line break inside a statement. To add a language, add
`content/trials/<code>.csv`, `content/practice/<code>.csv`,
`content/attention_checks/<code>.csv` and `app/i18n/<code>.js`, and list the
code under `languages` in `app/config.js`.

## Data

`admin.html` exports three CSV files:

- **trials**: one row per trial, with the participant identifier, study,
  timepoint, phase (`practice`, `test`, `attention`), block, difficulty, the
  statements and options as shown (including which were selected), `correct`,
  `hits`, `misses`, `false_alarms`, `rt_ms` and `timed_out`. The `payload`
  column holds the complete record as JSON.
- **administrations**: one row per sitting, with status, start and end time,
  `total_correct`, the number of timeouts, mean response time, attention
  checks passed and any demographics.
- **participants**: one row per participant per study.

The RAI score is `total_correct` out of 128 (test trials only). Rows with
`debug = 1` come from links opened with `?debug` and should be excluded.

Email addresses and other identifiers are personal data. They are stored in
the database so that scores can be attributed; delete a participant in
`admin.html` to remove them together with all their data.

## Development

```bash
npm test
```

runs the engine tests (content integrity, trial construction, scoring, order).
`npm run test:server` runs the tests of the worker against an in-memory
database (after `npm install` in `server/cloudflare`).

After changing anything under `app/`, run

```bash
npm run stamp
```

which rewrites `version.json`. The page loads every script with that version
in its address, so that after an update participants get the complete new set
of files instead of a mixture of cached and new ones. `npm test` fails if
`version.json` is out of date.

```bash
npm run serve
```

serves the site on http://localhost:8080. Useful links:

- `?backend=local` runs entirely in the browser with no server, for demos.
  Options can be switched on in the link, for example
  `?backend=local&login=id&attentionChecks=1&demographics=1&showScore=1`.
- `?debug` gives a short run (8 trials) and flags the data as debug. A debug
  run never shows the study's completion code or link. Add
  `&from=81` to start at a given trial, for example to look at one block.
- `?api=http://localhost:8787&study=CODE` uses a local server
  (`server/cloudflare/README.md`). `?api=` is ignored unless the page itself
  is served from localhost.

Layout: `app/engine` (trial construction and scoring, no DOM), `app/ui`
(screens), `app/data` (backends and the upload queue), `app/i18n` (interface
text), `server` (API contract and the Cloudflare implementation), `tools`
(the importer that produced `content/` from the lab.js export).

## Differences from the lab.js version (Experiment 3)

- Made-up words are no longer repeated within an administration. In the
  lab.js version the used word was meant to be removed from its bucket after
  each trial, but the removal was not kept, so only immediate repeats were
  prevented.
- Attention checks, demographics and the completion code are optional per
  study and off by default. With attention checks on, they appear in the same
  positions as before.
- The trial counter counts every trial shown ("Trial 21 of 134" with attention
  checks on); the lab.js version showed "Trial XX of 128" on attention checks.
- Response options are shuffled directly; the lab.js version placed them in
  random grid cells, which could leave gaps. On narrow screens the options
  stack in one column.
- Each trial record now also stores partial-credit counts (hits, misses,
  false alarms), the displayed option order and whether the window was in
  fullscreen.
- Fullscreen is entered on the participant's first click after logging in and
  re-entered on the next click if they leave it (browsers do not allow
  fullscreen without a click).
- Data upload is retried until it succeeds and an administration is only
  marked complete once every trial is stored. Interrupted administrations can
  be resumed.
- Small corrections to the instruction text ("a number of buttons", spacing).

## Licence

GPL-3.0, see `LICENSE`.
