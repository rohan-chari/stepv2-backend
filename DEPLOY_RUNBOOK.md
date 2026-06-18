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
pm2 stop steps-tracker-staging      # id 4
```

(Per `DEPLOYMENT.md`, staging is safe to stop — separate DB, sandbox APNS.)

---

## 3. Deploy prod

```bash
cd /var/www/step-tracker-backend \
  && git pull origin main \
  && npm install \
  && npx prisma migrate deploy \
  && npx prisma generate \
  && node prisma/seed.js \
  && pm2 restart 3
```

`seed.js` upserts cosmetics from `data/cosmetics.json` (items with
`active: false` stay hidden from the shop).

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
pm2 list                                         # id 3 online, restart count stable
```

Healthy boot prints all three lines:

```
Steps Tracker API running on 0.0.0.0:3002
[CRON] Race expiry check scheduled (hourly)
[CRON] Seeded race renewal scheduled (every 300s)
```

To distinguish **fresh** errors from stale log history, flush then watch:

```bash
pm2 flush 3
sleep 25
pm2 logs 3 --lines 200 --nostream | grep -iE "error|P2002|unhandled|TooManyConnections"
```

(The pm2 error log is **not** cleared on restart, so old errors look current
until you flush — this caused a false "prod is down" scare during the 2026-05-25
deploy.)

---

## 5. Restart staging

```bash
pm2 start steps-tracker-staging
curl -s https://staging.steptracker-api.org/health
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
