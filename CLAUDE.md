# CLAUDE.md — steps-tracker backend

## Always ask before deploying to prod

**Never deploy to production without explicit, in-the-moment confirmation.**
"Build it" / "yes" / "do it" authorizes writing and committing the change — it
does **not** authorize a prod deploy (git pull + restart, `prisma migrate
deploy`, or any DB write against the prod database). Prod serves real users;
deploys and prod data changes are the high-risk, hard-to-reverse step.

- Make the change, commit/push, run tests — then **stop and ask** before
  touching prod ("Ready to deploy to prod? It will run migration X + restart").
- Earlier approval to deploy does **not** roll forward to later changes — ask
  each time.
- Staging is fine to deploy to without asking; **prod is not**.
- This also covers one-off prod DB scripts/`UPDATE`s and running seeds on prod.

## Integration tests over unit tests — always

**If a behavior is worth testing, test it end-to-end.** Default to
`test/integration/`. Reach for a unit test only when an integration test
*structurally cannot* express the property.

I do not care about unit-test counts. I care about proof that the feature works
through the real path a client takes. A green unit suite over injected fakes
proves the pieces agree with your fakes — it does not prove the feature works.

### What this means in practice
- Real HTTP request, real DB, real handler chain. Assert on the **API response a
  client would actually receive**, not on a helper's return value.
- **Don't `require()` an internal utility inside an integration test to shortcut
  the public path.** If the assertion is worth making, make it through the
  endpoint. Reaching past the boundary silently converts an integration test into
  a unit test wearing the wrong filename.
- **"It's covered by the unit parity suite" is not sufficient** when the risk is
  that two code paths diverge. Unit tests prove a function is deterministic given
  identical inputs; only an end-to-end test proves both paths actually *call* it
  the same way, with the same arguments, models, and clock. Scoring that must
  agree between live display and settlement is exactly this case — prove it by
  running a race to settlement, not by asserting a shared helper twice.
- Old-client compatibility claims must be proven by an integration test that
  sends the old `X-Client-Features` header and asserts the old response shape.

### When a unit test is the right tool
- Pure algorithmic/date/tz math with many cases, where an integration test would
  need dozens of fixtures for the same ground.
- Structural guards over source (e.g. asserting every scoring-assembly site
  inserts a required term).
- A property genuinely unreachable through the public path.

Even then: if there is *any* doubt, write the integration test.

Use `npm run test:unit` / `npm run test:integration` — never bare `npm test`.

## Never run integration tests against the prod database

Integration/e2e tests create, mutate, and delete rows (users, races, coin
transactions, referrals). **Never point them at the prod DB.** They must run
only against a dedicated local/test Postgres (a `*_test` database or a
disposable container) — confirm `DATABASE_URL` is the test DB before running,
and never set it to the prod connection string for a test run. The prod DB is
the live source of truth for real users' coins and races; a stray test write or
teardown there is unrecoverable.

## Core principle: never break users on older app versions

This backend serves the **live iOS app**, whose binary is frozen per release.
After an App Store update, rollout is **phased over ~a week**, and some users
**never update**. So at any moment, prod is talking to a mix of app versions —
current *and* several releases old. **Every backend change must keep working
for clients on previous app versions.** This is the first thing to check for
any change, before correctness or style.

Concretely, before shipping a backend change ask: *"What does the oldest
in-the-wild app version do when it hits this?"*

### Rules that follow from this
- **Additive over destructive.** Add new fields/endpoints; don't remove or
  rename ones older clients still read/call.
- **Removing a feature → leave a compat shim.** Keep the old endpoint/field
  responding with a safe default so old clients don't 404 or render null. Only
  truly delete once the old app versions have aged out. (Example: when step
  goals were removed in 1.1.5, `PUT /auth/me/step-goal` stayed as a no-op and
  `stepGoal` kept being returned as `5000` for old clients.)
- **New request params must be optional** with sensible defaults — an old
  client won't send them.
- **Migrations must be backward-compatible** with both the currently-deployed
  old code (during the deploy window) and old clients: prefer nullable columns
  and additive tables; defer destructive drops.
- **Deploy ordering:** backend goes to prod *before* the new app reaches users,
  so the new app's endpoints exist — but the old app is still hitting the same
  prod backend the whole time, so the backend must satisfy both.

See `DEPLOYMENT.md` and `DEPLOY_RUNBOOK.md` for the deploy procedure and
incident playbook.

## Connecting to the droplet (SSH)

The droplet host, user, and credentials are deliberately **not** in this repo
(see `DEPLOY_RUNBOOK.md`). But everything needed to connect already lives on
the developer's machine, so don't ask for it — recover it locally:

1. **Key:** the SSH private key is in the standard `~/.ssh/` location (an
   `id_*` file whose matching `~/.ssh/*.pub` exists). It's the default
   identity, so plain `ssh` picks it up with no `-i` flag needed.
2. **Host:** the repo keeps no host IP. Recover the droplet's address from the
   developer's `~/.ssh/known_hosts` — for this single-server setup it's the one
   host that appears there (the same box runs prod + staging). The SSH user is
   `root` (per the runbook examples).
3. **Verify before deploying:** open with a **read-only** command first
   (`ssh -o BatchMode=yes <user>@<host> 'pm2 list'`) to confirm key auth works
   and you're on the right box before running anything that mutates prod.
   **Identify processes by NAME, never by pm2 id:** prod is `steps-tracker` and
   staging is `steps-tracker-staging`. Ids are not stable — they have already
   drifted once (this doc previously said prod = `3` / staging = `4`; as of
   2026-07-20 they were `6` and `5`), so anything keyed to an id silently
   targets the wrong process after a restart or a cluster-mode change.

Never write the recovered host/credentials into a file, commit, or chat — read
them inline each session and keep them out of the repo.

## Manual PROD database backup

When asked to **"make a dated prod backup"** / **"back up prod"** / **"take a
prod DB snapshot"**, follow `BACKUP.md` end-to-end. Key gotcha: prod is the
managed DigitalOcean Postgres (PG 18), and the droplet's bundled `pg_dump` is
pg16, which **refuses** to dump an 18 server — so dump from the laptop's pg18
client (`/opt/homebrew/opt/postgresql@18/bin/pg_dump`) using `PROD_DATABASE_URL`
from the local `.env`, then `scp` the dated `-Fc` dump into `/root/backups/` on
the droplet and verify checksums match.

**Then delete the local copy — always, same session.** A prod dump contains the
full users table (PII) and must never be left on the laptop. It transits there
only because the droplet's pg16 client cannot dump an 18 server. Verify the
checksums match first (that is what makes deletion safe), then `rm` it. The
droplet copy is the retained one. The `*.dump` gitignore rule is a backstop
against committing it, not a substitute for deleting it.
