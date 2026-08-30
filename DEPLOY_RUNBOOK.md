# Backend Deploy Runbook

A step-by-step record of the production deploy procedure, including the
incident recovery we hit on 2026-05-25 (failed migration + orphaned advisory
lock). Use this alongside `DEPLOYMENT.md` (which has the environment table and
the basic command sequence).

> **Credentials are never stored here.** The droplet host, SSH user, and
> password live in your password manager / DO console only. Below, the server
> is referred to as `<droplet>`. Prefer SSH **key** auth over password auth
> (see "Security notes" at the bottom).

---

## 0. Connect

```bash
ssh root@<droplet>
```

If you must use password auth from an automated/non-interactive context, drive
the prompt with `expect` from a **local temp file that you delete afterward** —
never put the password on a command line (it would land in shell history /
process list). Better: set up key auth (`ssh-copy-id`) so no password is needed.

---

## 1. Pre-flight

Confirm origin has the commit you intend to ship:

```bash
cd /var/www/step-tracker-backend
git fetch origin
git log -1 origin/main --oneline   # should be the merge/release commit you expect
```

**Check prod's migration state _before_ running `migrate deploy`.** This tells
you whether any prior migration is half-applied, which would otherwise block the
deploy mid-run:

```bash
node scripts/check-prod-migrations.js
```

- **`VERDICT: prod is fully migrated`** → `migrate deploy` is a no-op; proceed.
- **`VERDICT: prod is MISSING migrations`** → read the `unfinished/rolledback`
  list. A migration in a *failed* state makes `migrate deploy` refuse (P3018)
  until resolved — see Troubleshooting below.
  - Known re-apply case: `20260615102652_race_results_seen`. A prior deploy
    added its column before the backfill failed, so if it shows as unfinished,
    `migrate resolve --rolled-back` it and re-run — its `ADD COLUMN IF NOT
    EXISTS` + idempotent backfill make re-apply safe.

---

## 2. Free DB connections before migrating (important)

Prod + staging + other apps share one DO managed Postgres cluster with a small
`max_connections` (50 at time of writing). A migrate/seed run needs spare
connections and a session advisory lock. **Stop staging first** so the prod
migrate has headroom:

```bash
pm2 stop steps-tracker-staging
```

(Per `DEPLOYMENT.md`, staging is safe to stop — separate DB, sandbox APNS.)

> **Always address pm2 apps by NAME, never by id.** The ids drift — they are
> assigned in start order and get reshuffled by any `pm2 delete`/`start`, a
> droplet reboot, or a resurrect from a stale dump. This runbook used to say
> `pm2 restart 3` for prod; by 2026-08-16 id 3 was **staging** and id 4 was
> prod, so following it literally would have reloaded staging, left prod on the
> old code, and still passed the step-4 health check (prod is up — just not
> updated). Names are stable; ids are not.

---

## 3. Deploy prod

```bash
cd /var/www/step-tracker-backend \
  && git pull origin main \
  && npm install \
  && npx prisma migrate deploy \
  && npx prisma generate \
  && npm run powerups:copy:sync -- --apply \
  && ./scripts/pm2-safe-prod-reload.sh
```

`powerups:copy:sync`, `balance:drift`, and the required post-reload
`referral-contest:catch-up` are the exact audited role-less production npm
commands. Their exact npm lifecycle/script pairs use the bounded `maintenance`
database pool: 2 connections by default, or a canonical 1–5 from
`DATABASE_POOL_MAX_MAINTENANCE`. Do not replace an npm command with a direct
`node scripts/...` call; unaudited role-less production processes intentionally
fail before constructing a pool.

**Use the wrapper, not a direct `restart`/`reload`, and identify apps by name,
not id.** `reload` cycles the cluster
workers one at a time (zero downtime); `restart` kills them all at once and
caused a ~10s outage with user-visible 502s the one time it was used on prod
(2026-07-12). See `DEPLOYMENT.md` for the same rule stated at the source.

**Why `startOrReload ecosystem.config.js --only …` instead of a bare
`pm2 reload steps-tracker`:** the bare form reloads whatever pm2 currently has,
so if the process had drifted to 1 instance the deploy happily preserves the
drift. Going through the config file re-asserts `instances: 2` on every deploy,
which is what stops the 2026-08-16 half-capacity incident recurring. `--only`
scopes it to one app. The wrapper saves only after static, transition, topology,
memory-sentinel, and final strict pool-budget checks pass.

### 3a. Database pool budget — staged 80 → 32 rollout

Production pool ceilings are environment-configurable per process role, with
the reviewed source of truth committed in `ecosystem.config.js`. Deploy the two
recorded revisions sequentially: Deployment A has no production role variables
and safely remains at the legacy 80 aggregate; Deployment B adds this table and
fails closed if its exact role variable is missing:

| Role | Processes | Variable | Per process | Role total |
|---|---:|---|---:|---:|
| HTTP | 2 | `DATABASE_POOL_MAX_HTTP` | 10 | 20 |
| Resolution | 1 | `DATABASE_POOL_MAX_RESOLUTION` | 8 | 8 |
| Cron | 1 | `DATABASE_POOL_MAX_CRON` | 4 | 4 |
| **Production** | **4** | `DATABASE_POOL_TOTAL_BUDGET` | — | **32** |

Every supplied maximum must be a canonical integer from 1 through 50.
Deployment A is the sole compatibility exception. Deployment B production
requires the exact variable for `STEPS_PROCESS_ROLE`; generic fallbacks are
local/test-only. The capacity harness keeps its isolated
`DB_POOL_MAX` contract and production cannot use it as an alias.

Before the reload, verify in the DigitalOcean control plane and record the
managed-pool mode, pool size, reserve size (if any), and direct database
maximum. Then run the wrapper, which performs static preflight and transitions
resolution → cron → both HTTP workers. Before the first reload it captures the
exact live per-process pool baseline; every untransitioned process must remain
identical to that snapshot, and every transitioned process must exactly match
the current ecosystem target. This also applies when reviewed targets change.
Do not run `pm2 save` manually after a failed wrapper.

Afterward, confirm the startup records and take a read-only SQL census:

```bash
pm2 logs steps-tracker --lines 100 --nostream | grep '"event":"database_pool_configuration_v1"'
pm2 logs steps-tracker-resolution --lines 50 --nostream | grep '"event":"database_pool_configuration_v1"'
pm2 logs steps-tracker-cron --lines 50 --nostream | grep '"event":"database_pool_configuration_v1"'
psql "$DBU" -c "SELECT application_name, state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1,2 ORDER BY 1,2;"
```

Expect exactly `http:0=10`, `http:1=10`, `resolution:0=8`, and `cron:0=4`
in startup/admin telemetry. Lower ceilings are containment, not a throughput
optimization; continue monitoring endpoint latency and long transactions.

### 3b. Cluster instances — verify BOTH workers came back

Prod runs **2 HTTP pm2 cluster instances**. Staging is one process and remains
stopped by default. **The topology is declared in `ecosystem.config.js` at the
repo root** — that file, not the server's memory, is the source of truth. Scaling
past 1 is safe *only* because `src/index.js:188-201` gates the whole
`startCrons()` call behind `process.env.NODE_APP_INSTANCE === "0"` — pm2 sets
that per worker, and without the guard every one of the ~17 schedulers (race
resolution, live placement push, payout reconcile) would double-run on each
extra worker.

A cluster app shows **one `pm2 list` row per instance, sharing a name**. Two
rows named `steps-tracker` is correct; one row means prod is running at half
capacity.

```bash
pm2 list                      # expect TWO HTTP, ONE resolution, ONE cron; staging stopped
pm2 describe steps-tracker | grep -E "instances|exec mode|status"
```

If only one row is present, stop the deployment. Do not reload, scale, or save
PM2 directly. Fix the reviewed ecosystem definition if necessary, then rerun
`./scripts/pm2-safe-prod-reload.sh`; that serialized wrapper is the only authorized path
because it validates topology, captures the live pool baseline, reloads roles
in order, verifies every target, and saves only after the final checks pass.

> **Do not use `pm2 scale` on a shared droplet without checking the other apps
> first.** On 2026-08-16 a `pm2 scale steps-tracker-staging 2` rebuilt pm2's
> whole process table and dropped **prod** from 2 workers to 1 as a side effect,
> restarting both apps. Always `pm2 list` before and after.

**Confirm exactly one worker schedules crons after any scale or reload.** This
is the invariant the guard exists to protect, and it is the thing that silently
breaks:

```bash
pm2 logs steps-tracker --lines 200 --nostream | grep -E "\[CRON\]"
# Expect: the scheduling lines ONCE (from NODE_APP_INSTANCE=0), plus
#         "[CRON] Skipping cron scheduling on NODE_APP_INSTANCE=1" from the other.
# Two copies of "Race expiry check scheduled" = the guard is broken. Stop and
# fix before walking away; duplicate race resolution and duplicate pushes follow.
```

### 3c. Converge referral-contest ledgers after BOTH workers are new

Run this only after `startOrReload` has completed and section 3b confirms both
`steps-tracker` workers are online on the new release. During a rolling reload,
an old worker can still accept a race participant or write a point review
without the new ownership columns; running catch-up earlier would leave a new
gap behind it.

```bash
# Read-only audit first. It prints only host/database identity and missing-row counts.
npm run referral-contest:catch-up

# Idempotent apply after reviewing the target and counts.
npm run referral-contest:catch-up -- --apply

# Required convergence check: both counts must now be zero.
npm run referral-contest:catch-up
```

The apply pass uses ownership-safe `INSERT ... SELECT ... ON CONFLICT DO
NOTHING` for referral race activity. It fills null point-review ownership from
the durable qualification fact first, then from a live terminal/reviewable
referral when no durable fact exists; mutable `PENDING` attribution is never
backfilled. Do not consider the joined-contest recent activity reader converged
until the final dry-run reports zero for both `raceActivities` and
`reviewOwnership`.

> **Known live drift, 2026-08-16.** Both apps were found running a *single*
> instance despite the above, i.e. the `pm2 scale` had been lost since
> 2026-08-15. Crons were unaffected (the sole worker is `NODE_APP_INSTANCE=0`,
> so the guard still admits exactly one), but prod was serving at half its
> intended capacity. If you find one row per app, that is this drift, not a new
> design. Stop and use the serialized production reload procedure above; never
> repair or persist this state with an ad-hoc PM2 command.

`prisma/seed.js` no longer runs on a deploy. It is the bootstrap for a *fresh*
database; against a live one it reasserts rows that other systems own. Its one
deploy-relevant job — refreshing user-facing powerup copy — is now
`powerups:copy:sync`, which touches only the `PowerupCopy` table, prints the
database it is pointed at, dry-runs without `--apply`, and never deactivates a
row it does not find in the seed file. (The `--` is required; without it npm
swallows the flag and you get a dry run.) Run it on staging first and read the
diff.

If you ever do need the full seed against a live DB, note that the
challenge/stake `active` sweep is now opt-in behind `--deactivate-removed`. The
default run will not flip `active` on rows that are absent from the file, which
is what used to resurrect anything an admin had switched off.

Neither script touches cosmetics — the DB is the single source of truth (there
is no `data/cosmetics.json` anymore). New items are born via `POST /admin/shop/items`,
edits mirror prod ↔ staging via the admin tuner's peer mirror, drift is
reconciled with `npm run cosmetics:sync-peer`, and a fresh DB gets its catalog
with `npm run cosmetics:clone`. See `DEPLOYMENT.md` → "Adding a new accessory".

> **Forward-compat note — unlimited races (`maxParticipants: null`).** The
> backend now returns `maxParticipants: null` for unlimited races and accepts
> `null` on race creation. No currently-shipped app sends `null` (old clients
> always send an integer), so deploying this backend alone creates no unlimited
> races and old clients keep receiving integers — **safe to deploy on its own.**
> This becomes a client concern only when you ship an app build that can create
> unlimited races: confirm the **shipped** binary parses `maxParticipants`
> null-tolerantly before releasing that client, or older clients viewing those
> races may choke.

---

## 4. Verify prod

```bash
git rev-parse --short HEAD                      # matches what you shipped
curl -s localhost:3002/health                   # {"status":"ok"}
curl -s https://steptracker-api.org/health       # {"status":"ok"}  (real prod URL; no api. subdomain)
pm2 list                                         # BOTH steps-tracker rows online, restart count stable

# Marketing site (served from the COMMITTED web/dist — see below). All three
# must be 200: /privacy is the URL on the App Store listing.
curl -sI https://barastep.com/ | head -1
curl -sI https://barastep.com/privacy | head -1
curl -sI https://barastep.com/support | head -1
```

> **The marketing site is not built on the droplet.** `web/` (Vite + Vue +
> shadcn-vue) builds to `web/dist`, and **`web/dist` is committed to git** — the
> droplet only ever `git pull`s it. This is deliberate: the rollback procedure in
> `DEPLOYMENT.md` has no build step, so a build-artifact-only dist would leave
> barastep.com stale or 500ing after a rollback, and building a Vue toolchain on
> the one-vCPU box during live traffic is cost with no upside.
>
> After changing anything under `web/`, run `cd web && npm install && npm run
> build` **locally**, verify, and commit the regenerated `web/dist` with your
> change. The build fails loudly if Vite's asset directory ever collides with the
> `/assets` CDN mount.

Healthy boot prints all three lines:

```
Steps Tracker API running on 0.0.0.0:3002
[CRON] Race expiry check scheduled (hourly)
[CRON] Seeded race renewal scheduled (every 300s)
```

To distinguish **fresh** errors from stale log history, flush then watch:

```bash
pm2 flush steps-tracker
sleep 25
pm2 logs steps-tracker --lines 200 --nostream | grep -iE "error|P2002|unhandled|TooManyConnections"
```

(The pm2 error log is **not** cleared on restart, so old errors look current
until you flush — this caused a false "prod is down" scare during the 2026-05-25
deploy.)

### Pool telemetry observation preflight

Before starting a 24-hour or longer pool/failure-rate observation, confirm PM2
will retain at least 48 hours of logs. Do not infer retention merely from the
presence of old files: inspect the active `pm2-logrotate` configuration (or the
host's external log rotation policy) and verify its rotation interval plus
retained-file count covers 48 hours for all three PM2 apps.

After the telemetry build has been separately authorized and deployed, wait at
least one full minute, then verify the structured heartbeat is present for all
four process identities:

```bash
pm2 logs steps-tracker --lines 500 --nostream | grep '"event":"database_pool_telemetry_v1"'
pm2 logs steps-tracker-resolution --lines 200 --nostream | grep '"event":"database_pool_telemetry_v1"'
pm2 logs steps-tracker-cron --lines 200 --nostream | grep '"event":"database_pool_telemetry_v1"'
```

The observed identity set must be exactly `http:0`, `http:1`, `resolution:0`,
and `cron:0`. Each line is aggregate-only. If any identity is absent, log
retention is under 48 hours, or a line contains an unexpected raw field, do not
start the observation window. The Admin `SYSTEM HEALTH` section may say
`COLLECTING` during the first 60 minutes and for the longer 24-hour/7-day
windows; that is expected and must not be reported as complete coverage.

---

## 5. Staging remains stopped by default

Do not start or reload staging as part of an ordinary production deploy. With
explicit in-the-moment authorization for a staging/capacity test, start its one
`all` process (`DATABASE_POOL_MAX_ALL=10`), verify its pooler budget separately,
run the authorized work, then stop staging again. Never scale it to two as a
substitute for the four-process protected capacity harness.

---

## Troubleshooting

### `migrate deploy` fails mid-run (P3018)
A migration errored; Prisma marks it failed and blocks further deploys until
resolved. Read the actual SQL error.

- **Enum literal case**: `RaceStatus` (and other enums) are `@map`-ed to
  lowercase in the DB, so raw SQL must use `'active'`, not `'ACTIVE'`
  (Postgres validates the enum literal regardless of matching rows). This is
  exactly what failed on 2026-05-25 in `..._backfill_endsat_for_active_races`.

Recovery:
1. Fix the migration SQL in the repo, commit, push.
2. On the server, mark the failed migration rolled back:
   ```bash
   npx prisma migrate resolve --rolled-back <migration_name>
   ```
3. `git pull` the fix, then re-run `npx prisma migrate deploy`.

### `migrate` hangs / times out acquiring advisory lock (P1002)
Symptom: `Timed out trying to acquire a postgres advisory lock (... 72707369)`.
Cause: a previous failed/killed migrate left a connection holding Prisma's
migrate advisory lock — common when migrating **through the DO connection
pooler** (port 25061), because the pooler keeps the backend session alive.

Diagnose and clear (read the app DB URL from `.env`):
```bash
DBU=$(grep -E '^DATABASE_URL' .env | cut -d= -f2- | tr -d '"')
psql "$DBU" -c "SELECT pid, granted, objid FROM pg_locks WHERE locktype='advisory';"
# terminate the backend whose granted=t holds objid 72707369:
psql "$DBU" -c "SELECT pg_terminate_backend(<pid>);"
```
Then retry the migrate. **Prevention:** configure Prisma `directUrl` so
migrations bypass the pooler (use the direct port 25060 + the pool's underlying
database name — confirm the mapping in the DO console before wiring it).

### "Too many connections" (Postgres 53300 / Prisma P2010)
The shared cluster hit `max_connections`. Stop non-critical processes
(staging), and/or lower each app's Prisma pool size, and/or raise the cluster
size. Check usage:
```bash
psql "$DBU" -c "SELECT count(*) FROM pg_stat_activity;"
psql "$DBU" -c "SHOW max_connections;"
psql "$DBU" -c "SHOW superuser_reserved_connections;"
psql "$DBU" -c "SELECT application_name, state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1,2 ORDER BY 1,2;"
```

Do not infer the DigitalOcean managed-pool size from these SQL results; verify
pool mode/size/reserve in the control plane. Restore only reviewed role values
with `pm2-safe-prod-reload.sh`. A lower application pool prevents one role from
monopolizing connections but cannot improve a slow transaction's throughput.

---

## Reference (verified 2026-05-25)

| Env     | Path                                     | pm2          | App port | Public URL                          |
| ------- | ---------------------------------------- | ------------ | -------- | ----------------------------------- |
| prod    | `/var/www/step-tracker-backend`          | id `3` `steps-tracker`         | 3002 | `https://steptracker-api.org`         |
| staging | `/var/www/step-tracker-backend-staging`  | id `4` `steps-tracker-staging` | 3003 | `https://staging.steptracker-api.org` |

- There is **no** `api.steptracker-api.org` (it is NXDOMAIN). Prod is the bare domain.
- DB is reached via the DO **pooler** at `:25061`; the direct port is `:25060`.

---

## Security notes
- Prefer SSH **key auth**; disable password auth and direct root login where possible.
- Never paste the SSH password into a terminal, script, or chat. If it has been
  exposed, **rotate it**.
- This file intentionally contains no host IP, username, or password.
