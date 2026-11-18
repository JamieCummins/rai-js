# RAI server on Cloudflare (Workers + D1)

A small worker, `rai-api`, that implements `server/API.md`. It stores its data
in `rai_` tables inside the existing SMART D1 database (`smart`), which is what
lets SMART participants log in with the username and PIN they already have.

What it does and does not touch in that database:

- It creates and writes only tables whose names start with `rai_`.
- It reads the SMART `users` table to check a username and PIN. It never
  writes to `users`, `progress`, `sessions` or `trials`.
- The SMART worker (`smart-api`) is not redeployed or changed in any way.

## One-time setup

```bash
cd server/cloudflare
npm install
npx wrangler login
```

Create the tables. Every statement is `CREATE ... IF NOT EXISTS`, so this is
safe to run on the live database and safe to run again later:

```bash
npx wrangler d1 execute smart --remote --file=schema.sql
```

Set the secrets. `AUTH_SECRET` is any long random string of your own (at least
16 characters; it does not need to match the SMART worker's, and without it
the worker refuses every login); `ADMIN_TOKEN` is the password for
`admin.html`:

```bash
npx wrangler secret put AUTH_SECRET
npx wrangler secret put ADMIN_TOKEN
```

Deploy:

```bash
npx wrangler deploy
```

The command prints the worker's URL (`https://rai-api.<subdomain>.workers.dev`).
Put it in `app/config.js` (`backend.url`), and make sure the origin of the
site that hosts the test is listed in `ALLOWED_ORIGINS` in `wrangler.toml`.

## Login by email

Studies with login `email` send a 6-digit code to the participant's address.
The worker sends it through [Resend](https://resend.com), which has a free
tier that is ample for this:

1. Create a Resend account and an API key.
2. Verify a sending domain in Resend and set `MAIL_FROM` in `wrangler.toml`
   to an address on it, for example `RAI <login@your-domain.org>`. Without a
   verified domain, Resend only delivers to your own account address, which
   is enough for a first test but not for participants.
3. Store the key and deploy again:

```bash
npx wrangler secret put RESEND_API_KEY
```

Login codes are limited to 5 per hour for one address and to
`EMAIL_CODES_PER_HOUR` (in `wrangler.toml`, default 100) per hour over all
studies and addresses; codes that have been used do not count towards either.

Until this is done, studies with login `email` answer "Login by email is not
available". Studies with login `id` or `smart` do not need it. To use another
email provider, replace `sendLoginEmail` in `worker.js`.

## Accounts from another SMART database

To let accounts from a second SMART database log in (for example
`smart-carina`), uncomment the `DB_CARINA` block in `wrangler.toml`, deploy,
and set the study's "SMART database binding" to `DB_CARINA` in `admin.html`.
That database is only read; the RAI data of those participants is stored with
everything else in the `rai_` tables of the main database.

## Local development

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 execute smart --local --file=schema.sql
npx wrangler dev
```

This runs the worker on `http://localhost:8787` against a local, empty copy of
the database (nothing remote is touched). `.dev.vars` sets `DEV_SHOW_CODES=1`,
which shows login codes on screen instead of emailing them. Open the test with
`?api=http://localhost:8787&study=CODE` after creating a study in `admin.html`.

## Account limits

The worker shares the Cloudflare account's request and D1 storage limits with
the SMART workers. One administration is about 30 requests and well under 1 MB
of storage.
