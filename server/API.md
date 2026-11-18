# RAI data API

The test talks to its server through this small JSON API. The reference
implementation is `server/cloudflare` (Cloudflare Workers + D1). Any server
that implements the same endpoints can be used instead: set `backend.url` in
`app/config.js`.

All requests and responses are JSON. Authenticated endpoints expect
`Authorization: Bearer <token>`, where the token was returned by one of the
`/auth` endpoints. Errors are `{ "error": "<code>", "message": "..." }` with an
HTTP error status; the app shows a message for these codes: `study`, `email`,
`code`, `invalid`, `identifier`, `notInvited`, `tooMany`, `busy`, `emailUnavailable`,
`emailFailed`, `unauthorized`, `network`.

## Studies

A study is one use of the test: a research study, a consulting client, a pilot.
It has a code (used in the link, `?study=CODE`), a name and settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `login` | `email` | `email`: address + one-time code sent by email. `smart`: SMART username + PIN. `id`: an identifier typed in or passed in the link (`?pid=`). |
| `registration` | `open` | `invited`: only identifiers added by an admin may take part (not used for `smart`). |
| `idLabel` | `Participant ID` | Label of the field for login `id`. |
| `practice` | `true` | Present the practice trials. |
| `attentionChecks` | `false` | Present the attention-check trials. |
| `demographics` | `false` | Ask age and gender before the instructions. |
| `completionCode` | | Shown on the final screen. |
| `completionUrl` | | Offered as a link on the final screen. |
| `showScore` | `false` | Show the number of correct trials on the final screen. |
| `repeatable` | `false` | Allow more than one completed administration per participant and timepoint. |
| `fullscreen` | `true` | Keep the browser in fullscreen. |
| `accountDb` | `DB` | Login `smart`: the D1 binding whose `users` table holds the accounts. |
| `smartStudy` | | Login `smart`: only accounts with one of these comma-separated study tags. |

`completionCode`, `completionUrl`, `accountDb` and `smartStudy` are never sent
to the browser by `GET /studies/:code`; the completion code and link are
returned only once an administration has been completed.

## Participant endpoints

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/studies/:code` | | `{code, label, settings}` (public) |
| POST | `/auth/email/request` | `{study, email}` | `{ok}`; emails a 6-digit code valid for 15 minutes |
| POST | `/auth/email/verify` | `{study, email, code}` | `{token, participant, study}` |
| POST | `/auth/smart` | `{study, username, pin}` | `{token, participant, study}` |
| POST | `/auth/id` | `{study, identifier}` | `{token, participant, study}` |
| GET | `/me` | | `{participant, study}` |
| POST | `/administrations` | `{id, timepoint, language, settings, nTrials, resumeHours, debug, userAgent, screen, viewport}` | `{administration, resumed, nextSeq, totalCorrect, usedWords}` |
| PATCH | `/administrations/:id` | `{demographics}` or `{status: 'completed', endedAt}` | `{ok}`; on completion also `{totalCorrect, trialsCompleted, nTrials, completionCode, completionUrl}` |
| POST | `/trials` | `{trials: [record, ...]}` (max 200) | `{saved, received}` |

`participant` is `{id, identifier, study, source}`.

`POST /administrations` either starts a new administration with the given `id`
(`201`), or returns the participant's unfinished one for the same timepoint if
it was started within `resumeHours` (`200`, `resumed: true`). `nextSeq` is the
position to continue from and `usedWords` lists the made-up words already shown
in that administration, which the app does not draw again. If the participant has already completed this
timepoint and the study is not `repeatable`, the response is `409` with error
`completed` (plus the completion code and link).

An administration that is not a debug run can only be completed once all 128
test trials are stored; before that the response is `409` with error
`incomplete`. The completion code and link are never returned for debug runs.

Trial uploads are idempotent: records are unique by `(administrationId, seq)`
and a re-sent batch creates no duplicates (the client retries after network
errors). Totals on a completed administration are computed by the server from
the stored trials.

## Trial record

Each record is the object built in `app/main.js`:

```
administrationId, seq, participantId, identifier, study, timepoint,
phase ('practice'|'test'|'attention'), position (number shown in "Trial n of N"),
trialNum, trialId, block, difficulty, probe ('TRUE'|'FALSE'),
premises [as shown], options [{text, template, truth, selected}] in displayed order,
nOptions, nCorrectOptions, correct (0/1), hits, misses, falseAlarms,
rtMs, timedOut (0/1), words {placeholder: nonsense word}, row {the CSV row},
fullscreen (0/1), viewport, shownAt, clientTime
```

`correct` is 1 only if exactly the correct options were selected and the trial
did not time out. The reference server stores the key columns for querying and
the whole record as JSON in `payload`.

## Admin endpoints (Bearer ADMIN_TOKEN)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/studies` | studies with settings and participant counts |
| PUT | `/admin/studies` | `{code, label?, active?, settings?}` create or update a study; settings not mentioned are kept |
| GET | `/admin/participants?study=` | participants with administration and trial counts |
| POST | `/admin/participants` | `{study, identifiers: [...]}` add participants ahead of time (needed for `invited`) |
| DELETE | `/admin/participants?id=` | remove a participant and all their data |
| GET | `/admin/export/trials?study=&identifier=&since=&until=&format=csv|json&payload=0` | streamed in pages, any size; also `administrations`, `participants` |

`admin.html` in the repository root is a small page that uses these.
