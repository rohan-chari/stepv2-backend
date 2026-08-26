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
  && pm2 startOrReload ecosystem.config.js --only steps-tracker,steps-tracker-resolution,steps-tracker-cron \
  && pm2 save
```

**`reload`, not `restart`, and by name, not id.** `reload` cycles the cluster
workers one at a time (zero downtime); `restart` kills them all at once and
caused a ~10s outage with user-visible 502s the one time it was used on prod
(2026-07-12). See `DEPLOYMENT.md` for the same rule stated at the source.

**Why `startOrReload ecosystem.config.js --only …` instead of a bare
`pm2 reload steps-tracker`:** the bare form reloads whatever pm2 currently has,
so if the process had drifted to 1 instance the deploy happily preserves the
drift. Going through the config file re-asserts `instances: 2` on every deploy,
which is what stops the 2026-08-16 half-capacity incident recurring. `--only`
scopes it to one app; the trailing `pm2 save` updates the dump a reboot restores.

### 3a. Cluster instances — verify BOTH workers came back

Prod and staging each run **2 pm2 cluster instances**, matching the droplet's
2 vCPUs. **As of 2026-08-16 this is declared in `ecosystem.config.js` at the
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
pm2 list                      # expect TWO rows named steps-tracker, TWO named steps-tracker-staging
pm2 describe steps-tracker | grep -E "instances|exec mode|status"
```

If only one row is present, the scale was lost (a reboot, or a resurrect from a
dump that predates the change). Re-assert it **from the config file**, so the
count comes from the repo rather than being typed from memory:

```bash
pm2 startOrReload ecosystem.config.js --only steps-tracker
pm2 save                      # persist so the next resurrect keeps 2
```

The `--only` is not optional: `ecosystem.config.js` declares BOTH apps, and
omitting it would have a prod deploy reload staging too.

The manual equivalent (`pm2 scale steps-tracker 2 && pm2 save`) still works, but
prefer the config file — the whole point is that the number stops living in
someone's head. **`pm2 save` is still required either way**; the ecosystem file
governs starts and reloads, while the dump is what a *reboot* resurrects.

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

### 3b. Converge referral-contest ledgers after BOTH workers are new

Run this only after `startOrReload` has completed and section 3a confirms both
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
<<<<<<< ours
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
> design — re-scale and `pm2 save`.

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

---

## 5. Restart staging

```bash
pm2 start steps-tracker-staging
curl -s https://staging.steptracker-api.org/health
pm2 list    # staging back to TWO rows; if one, `pm2 scale steps-tracker-staging 2 && pm2 save` (see 3a)
```

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
```

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
