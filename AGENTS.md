# AGENTS.md — steps-tracker backend

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

## Permanent behavior over release flags and kill switches

Release flags, feature flags, and kill switches are prohibited by default.
Implement permanent behavior as the default and use immutable version stamps
when old and new behavior must coexist for compatibility.

If a runtime control is truly unavoidable for mixed-version, migration, or
operational safety, stop before adding it. Explain why permanent behavior and
version-stamped compatibility are insufficient, obtain the user's explicit
approval, and document the control's owner, default, rollout plan, and concrete
deadline or removal condition.

## Backend owns product policy

The backend is the sole authority for powerup, accessory, and character
availability, retirement, prices, purchase/upgrade eligibility, and reward
pools. Apply policy consistently to every outgoing catalog, inventory, race
projection, guide, and reward response, including cached paths. Do not rely on
an app binary to hide or retire an item.

Use existing response fields or additive metadata to describe policy. Explicit
valid false, zero, and empty values must remain distinguishable from missing
or malformed data. Keep actual reward selection and purchase validation on the
server, with compatible responses for frozen clients. Client capability/channel
filtering also belongs here; the app retains truthful capability declarations
and safe renderers rather than item-specific merchant rules.

Tests must prove consistent policy through real public endpoints and warm-cache
paths. Content activation, retirement, and pricing changes must not require a
binary change when the installed renderer already supports that content.

## Backend scalability and performance guidelines

These principles apply to all future backend work. The goal is to support
substantially more users on the same infrastructure before relying on vertical
or horizontal scaling.

### Core scalability principle

**Optimize for doing less work per unit of user activity.** Before adding
infrastructure, look for ways to reduce database queries, writes and round
trips; repeated calculations; duplicate queue jobs; unnecessary object loading,
serialization/deserialization and network calls; and work performed
synchronously during API requests. Prefer designs that reduce total work over
simply moving the same amount of work somewhere else.

### Database round trips

Treat reducing database round trips as a major performance goal. Avoid loops
that repeatedly query or update the database.

Bad pattern:

```text
for each user:
    SELECT user
    UPDATE user
```

Prefer:

```text
SELECT all required users (bounded)
perform calculations in memory where appropriate
bulk update affected users
```

Actively look for N+1 queries, queries inside loops, repeated queries for the
same data, repeated flush/SaveChanges calls (or equivalent ORM operations),
row-by-row inserts and updates, and multiple queries that can safely be
combined. Load required data once and operate on it as a set where possible.
Wrapping individual commands in a transaction does not by itself make them a
bulk operation or eliminate their round trips.

### Bulk reads

Prefer bounded, targeted bulk reads when multiple records are needed: users
with `WHERE id IN (...)`, race participants, required power-up state,
leaderboard data, and related entities fetched in a planned query instead of
individual lazy loads. Select only required fields. Do not bulk-load huge
datasets unnecessarily; chunk large input sets into bounded batches.

### Bulk writes

Prefer bulk inserts, updates and deletes, set-based SQL, batched ORM writes,
and database-native update operations when many rows change. Avoid hundreds
or thousands of individual commands when a set-based operation can safely
express the work. Preserve business logic, concurrency behavior, audit
requirements and transactional correctness.

### Batching

Consider processing related events together when it significantly reduces
overhead: step updates, leaderboard recalculations, notifications, race
statistics, activity logs, analytics events and queued jobs. Do not introduce
unacceptable delays or break real-time behavior.

### Reduce write frequency

Treat high-frequency data such as step updates carefully. Do not persist every
tiny intermediate state when only the latest or accumulated result is needed.
Consider accumulating deltas, coalescing updates, debouncing writes, buffering
short bursts, writing only meaningful changes, maintaining aggregate counters,
and persisting the latest state when transient history is not required.
Before changing write semantics, confirm what must be durable and what can
safely be recomputed.

### Write amplification

Watch for one user action producing disproportionate downstream writes. A
step sync should not unnecessarily update user records, race participants,
leaderboards, activity tables, stats, notifications and queue tables.
Estimate the SELECTs, INSERTs, UPDATEs, DELETEs and queue jobs generated by each
common user action, including downstream work, and consolidate excessive work.

### Precomputed aggregates

Avoid repeatedly recalculating expensive values from large raw datasets when
an aggregate can safely be maintained. Candidates include race step totals,
leaderboard totals, daily step totals, user statistics, standings, win counts
and frequently requested summaries. Prefer incremental updates where
appropriate: instead of repeatedly computing `SUM(all_step_records)`, consider
updating a current aggregate as step data arrives. Define a clear source of
truth and a repair/rebuild path for every aggregate.

### Caching

Cache frequently requested data that need not be recalculated or loaded from
PostgreSQL on every request. Possible Redis candidates include live
leaderboards, race state, active race metadata, user summaries, temporary
calculated values and short-lived application state. Do not cache blindly.
For every cache, define:

- Source of truth and cache key.
- TTL, if applicable, and invalidation behavior.
- Behavior on cache miss and when Redis is unavailable.

Redis must not become the only copy of data requiring durability unless the
system is specifically designed that way.

### Queues

Move expensive work out of synchronous API requests when users do not need
its result immediately: leaderboard recalculation, notifications, analytics,
expensive statistics, background race processing and secondary side effects.
Requests should generally do only what is needed to safely accept and validate
the action. Do not queue work merely to hide inefficient database logic;
workers must follow these same scalability guidelines.

### Queue deduplication and coalescing

Avoid duplicate background work. If a user's leaderboard needs updating eight
times before the first job runs, consider one job processing the latest state
where correctness allows it. Look for repeated jobs for the same entity, jobs
superseded by newer jobs, mergeable jobs and race-wide jobs repeatedly created
during bursts. Deduplicate or coalesce only when required effects are preserved.

### Concurrency limits and backpressure

Use bounded concurrency; more workers are not automatically better.
Database-heavy parallel jobs can overload PostgreSQL. When adding consumers or
parallel processing, consider database connection limits, CPU, lock contention,
transaction duration, Redis load, memory and downstream API limits. Absorb
bursts with backpressure instead of spawning unlimited simultaneous database
work.

### Indexes

Evaluate indexes when creating or modifying queries, based on actual access
patterns. For `WHERE race_id = ? AND user_id = ?`, consider an appropriate
composite index. Investigate execution plans, sequential/index scans, rows
examined versus returned, sorts, joins and query frequency. Account for
existing indexes and additional write overhead before adding indexes.

### Pagination and bounded queries

Every potentially growing query must have an intentional limit. Paginate or
otherwise bound activity feeds, race history, notifications, user lists,
public races, leaderboard history and administrative tools. Avoid loading
entire tables unless the dataset is known to be very small.

### Avoid unnecessary work

Before implementing backend functionality, ask:

1. Does this need a database query?
2. Can we reuse data already loaded?
3. Can several reads become one read?
4. Can several writes become one write?
5. Does this need to happen synchronously?
6. Does this need to happen every time?
7. Can it be cached?
8. Can it be incrementally maintained?
9. Can duplicate work be discarded?
10. Can the query be bounded?
11. Are we recalculating something we could maintain as an aggregate?
12. Could concurrency turn this inexpensive operation into a database
    bottleneck at scale?

### Bara-specific considerations

Design frequent paths for high user counts: Apple Health and Android Health
Connect step sync, step ingestion, race participant updates, leaderboard
calculations, race totals, power-up processing, activity feeds, notification
fan-out, scheduled race jobs, queue workers and user statistics.
**Treat step sync as a potentially high-volume operation.** When changing
step-sync-related code, explicitly consider thousands of users syncing at
approximately the same time.

### Performance investigation expectations

When investigating high CPU, database load, queue lag or scalability, do not
stop at calling a calculation expensive. Trace the full execution path:

- How frequently it runs and how many users or races trigger it.
- Database query/write counts, queue job counts and rows scanned per query.
- Queries inside loops and repeated loading of the same data.
- Repeated calculations, duplicate jobs and amplification from concurrency.

Quantify the current path and compare it with the proposed implementation
where possible. For example (illustrative numbers, not measured Bara results):

```text
One step sync before optimization:
27 SELECTs, 11 UPDATEs, 4 INSERTs, 3 queue jobs

After optimization:
4 SELECTs, 2 bulk UPDATEs, 1 bulk INSERT, 1 deduplicated queue job
```

Prefer measurable reductions over vague performance claims. Distinguish
measured results from estimates and include downstream worker work in totals.

### Correctness comes first

Do not sacrifice correctness, transaction safety, race-condition handling,
data durability or compatibility with older app versions to reduce database
usage. Preserve behavior unless a behavior change is explicitly intended.
For significant optimizations, explain current behavior, the scalability
problem, the proposed change, expected reduction in work, correctness and
concurrency risks, migration concerns, and how the change will be tested.

The goal is to increase how many users existing infrastructure can reliably
support by reducing work per user, especially database work, rather than only
making individual requests faster.

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
