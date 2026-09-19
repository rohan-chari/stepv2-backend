# Bara Backend Operations

This is the canonical operational source of truth for the Bara backend.

Use this file for production/staging topology, deploys, database backups, migrations,
PM2 operations, queue/Redis rollout, verification, and rollback. Historical release
notes live under `docs/archive/` and must not be used as current instructions.

## Authority and safety

- Never deploy to production or mutate production data without explicit,
  in-the-moment user authorization.
- Approval to implement, commit, push, test, or merge is not deploy approval.
- Production commands address PM2 apps by **name**, never numeric PM2 id.
- Never run integration/e2e tests against production.
- Never run `prisma db push` against production.
- Never run `prisma/seed.js` as a normal live deploy step.
- Staging is stopped by default. Start/reload it only with explicit authorization
  for that staging task, then stop it again when the task is complete.
- Exact frontend build commands live in the frontend repo `README.md`.
- Agent engineering policy lives in `AGENTS.md`.

## Current environment map

| Environment | Checkout | Public API | App process |
| --- | --- | --- | --- |
| Production | `/var/www/step-tracker-backend` | `https://steptracker-api.org` | `steps-tracker` |
| Staging | `/var/www/step-tracker-backend-staging` | `https://staging.steptracker-api.org` | `steps-tracker-staging` |

There is no `api.steptracker-api.org` production host.

Production branch: `main`.

Staging uses an explicitly selected release/feature branch when authorized. Do not
assume it tracks `main`.

## Production process topology

`ecosystem.config.js` is the source of truth.

Current reviewed production topology:

| PM2 app | Count | Role | DB pool max |
| --- | ---: | --- | ---: |
| `steps-tracker` | 2 | `http` | 10 each |
| `steps-tracker-step` | 1 | `step` | 3 |
| `steps-tracker-resolution` | 1 | `resolution` | 6 |
| `steps-tracker-event` | 1 | `event` | 3 |
| `steps-tracker-notification` | 1 | `notification` | 4 |
| `steps-tracker-cron` | 1 | `cron` | 3 |

Reviewed aggregate database pool budget: **39**.

Staging is one stopped `steps-tracker-staging` process using
`STEPS_PROCESS_ROLE=staging_all` and `DATABASE_POOL_MAX_ALL=10`.

Do not repair topology with ad-hoc `pm2 scale`, `pm2 restart <id>`, or
`pm2 save`. Use the guarded reload wrapper.

## Queue-first deployment requirements

The queue-first architecture uses a dedicated queue Redis connection through
`QUEUE_REDIS_URL`. For the current single-droplet architecture this is a
second Redis server process on the production droplet, separate from ordinary
HTTP/cache Redis. Horizontal Redis failover is a future scaling goal.

Before any queue-first production deploy:

1. Provision and set `QUEUE_REDIS_URL` for every process that owns queue work.
2. Verify the queue Redis endpoint is reachable from the production host.
3. Verify all required Redis stream consumer groups can be created/read.
4. Verify stream trimming is owned by the cron role and is running.
5. Verify step, powerup, race-dirty, recovery, and global-event workers have an
   explicit production owner.
6. Verify **notification delivery has an explicit production owner**.

### Split worker ownership

Production ownership is explicit:

- `step` owns STEP_SYNC intake.
- `resolution` owns POWERUP_RECALC, RACE_DIRTY and resolution-coupled work.
- `event` owns global-event Redis scheduling/boundary consumption.
- `notification` owns notification projection/release/inbox/stream delivery.
- `cron` owns true periodic maintenance and stream trimming.

The race-dirty worker remains with resolution because it directly invokes the
resolver and core/post-task work shares one in-process work budget.

## Deploy checklists

- Pre-deploy provisioning and GO/NO-GO: `PRE_DEPLOY_README.md`
- Post-deploy verification and observation: `POST_DEPLOY_README.md`

Agents with SSH access should follow those files in order rather than
reconstructing commands from historical notes.

## Merge gate for major backend branches

Before recommending merge to `main`:

1. Run the required automated release gate:
   ```bash
   REDIS_URL=redis://127.0.0.1:6379 \
   QUEUE_REDIS_URL=redis://127.0.0.1:6379 \
   npm run test:release
   ```
   `test:release` runs `test:unit` first and then `test:integration`. It does
   **not** deploy anything.

   Unit tests are intentionally isolated from Redis. The `test:unit` script
   forces `REDIS_URL=`, `QUEUE_REDIS_URL=`, and `CACHE_ENV_PREFIX=unit:`
   so dependency-injected unit tests cannot read shared/local Redis cache state.
   The outer `test:release` command may still provide Redis URLs because the
   integration suite requires them.
2. Review migrations and production environment additions.
3. Verify this operations file matches any topology or deployment changes.
4. For queue-first/scalability work, verify the split topology, queue Redis
   requirements, and deploy checklists are represented in code/docs.
5. Review the final branch diff against `main`.

Unit and integration are the only required automated release suites. Queue and
worker behavior that matters to production belongs in integration coverage,
especially under `test/integration/queue`. Specialized historical suites are
not release gates.

Current release-candidate status: unit and integration both pass. Re-run
`npm run test:release` after any code change before merge/deploy.

A green release test does not waive an unresolved production topology or
deployment requirement.

## Production database backup

Production PostgreSQL is managed by DigitalOcean. A manual pre-deploy dump is
additional insurance; DigitalOcean automated backups/PITR remain separate.

The current server is PostgreSQL 18. Use a PostgreSQL 18-or-newer client.
The droplet's older `pg_dump` must not be used if its major version is below
the production server's.

The production URL is read from local ignored configuration. Never paste or
commit it.

Run the dump from the trusted developer machine using a temporary path **outside
the repository**:

```bash
PGD=/opt/homebrew/opt/postgresql@18/bin/pg_dump
PGRESTORE=/opt/homebrew/opt/postgresql@18/bin/pg_restore
PSQL=/opt/homebrew/opt/postgresql@18/bin/psql
PGURL="$(grep -E '^PROD_DATABASE_URL=' .env | cut -d= -f2-)"
DATE=$(date -u +%Y-%m-%d-%H%M%S)
TMPDIR="$(mktemp -d)"
OUT="$TMPDIR/step-tracker-prod-$DATE.dump"

"$PSQL" "$PGURL" -tAc "select 'ok', pg_size_pretty(pg_database_size(current_database()));"
"$PGD" "$PGURL" -Fc -Z6 -f "$OUT"
"$PGRESTORE" -l "$OUT" | grep -c "TABLE DATA"

ssh "$DROPLET" 'mkdir -p /root/backups'
scp "$OUT" "$DROPLET":/root/backups/
shasum -a 256 "$OUT"
ssh "$DROPLET" "sha256sum /root/backups/$(basename "$OUT")"
```

The two SHA-256 values must match.

Then, in the **same session**, delete the local temporary copy:

```bash
rm -f "$OUT"
rmdir "$TMPDIR"
```

The laptop is transit only. The retained manual dump is the droplet copy.
A production dump contains PII and must not remain on the laptop.

Never restore over production without explicit authorization.

Restore syntax for a separately approved target:

```bash
pg_restore --clean --if-exists --no-owner -d "<target DATABASE_URL>" backup.dump
```

## Pre-deploy backend checklist

After explicit production deploy authorization:

1. Confirm the required automated release gate passed on the exact release
   candidate:
   ```bash
   REDIS_URL=redis://127.0.0.1:6379 \
   QUEUE_REDIS_URL=redis://127.0.0.1:6379 \
   npm run test:release
   ```
2. Confirm the exact commit intended for production is on `origin/main`.
3. Confirm the production checkout has no unexpected local modifications.
4. Take a dated production backup when the change includes a meaningful schema,
   data, queue, or high-risk operational migration.
5. Check migration state:
   ```bash
   node scripts/check-prod-migrations.js
   ```
6. Stop staging if it is running:
   ```bash
   pm2 stop steps-tracker-staging
   ```
7. Verify static topology/pool configuration before process mutation:
   ```bash
   npm run pm2:topology:check -- --pool-budget-mode=static
   ```
8. Confirm required production environment values exist, including
   `QUEUE_REDIS_URL` when queue-first code is being deployed.

## Standard production deploy

On the production host:

```bash
cd /var/www/step-tracker-backend

git fetch origin
git log -1 origin/main --oneline
git pull origin main
npm install
npx prisma migrate deploy
npx prisma generate
npm run powerups:copy:sync -- --apply
npm run balance:drift
./scripts/pm2-safe-prod-reload.sh
```

Do not replace the guarded reload with direct PM2 mutation.

`balance:drift` is an audit. It may report intentional live tuning and should
not silently overwrite it.

`powerups:copy:sync -- --apply` is the deploy-safe copy sync. The full seed is
not a normal deploy step.

Run any feature-specific idempotent catch-up only when its current implementation
and runbook explicitly require it. Historical release docs under
`docs/archive/releases` are not authority for today's deploy.

## Migration rules

- Use committed Prisma migrations.
- Production uses `npx prisma migrate deploy`.
- Do not edit a migration already applied to a shared environment.
- Prefer additive/backward-compatible migrations.
- Separate destructive cleanup from feature rollout.
- `CREATE INDEX CONCURRENTLY` or extension/index operations that cannot run in a
  Prisma transaction must use an explicit reviewed runbook/script.
- If `migrate deploy` reports a failed historical migration, inspect the exact
  migration and error before using `prisma migrate resolve`. Never mark a
  migration rolled back just to make Prisma proceed.

## Guarded PM2 reload

The only normal production process-mutation path is:

```bash
./scripts/pm2-safe-prod-reload.sh
```

The wrapper is responsible for:

- serializing production process changes;
- validating the committed topology;
- validating database-pool targets;
- preventing unsafe overlapping worker ownership;
- restoring exactly two HTTP workers;
- validating final topology before saving PM2 state.

After it completes:

```bash
pm2 list
npm run pm2:topology:check
```

Expected production identities are the ones declared by the current
`ecosystem.config.js`, not historical PM2 ids.

## Post-deploy verification

At minimum:

```bash
git rev-parse --short HEAD
curl -fsS localhost:3002/health
curl -fsS https://steptracker-api.org/health

pm2 logs steps-tracker --lines 100 --nostream
pm2 logs steps-tracker-resolution --lines 100 --nostream
pm2 logs steps-tracker-cron --lines 100 --nostream

pm2 list
npm run pm2:topology:check
```

For queue-first releases also verify:

- queue Redis connectivity;
- expected consumer groups;
- no growing unclaimed pending entries;
- step stream consumer progress;
- powerup stream consumer progress;
- race-dirty consumer progress;
- global-event boundary consumer progress;
- notification delivery consumer progress;
- stream trimmer operation;
- no unexpected database-pool pressure.

Do not treat HTTP health alone as proof that background processing is healthy.

Smoke the real app flows appropriate to the release.

## Staging

Staging is stopped by default.

With explicit staging authorization:

```bash
cd /var/www/step-tracker-backend-staging
git fetch origin
git checkout <approved-branch>
git pull origin <approved-branch>
npm install
npx prisma migrate deploy
npx prisma generate
pm2 startOrReload ecosystem.config.js --only steps-tracker-staging
```

Run the approved verification, then:

```bash
pm2 stop steps-tracker-staging
```

Do not scale staging to imitate production capacity. Use the isolated capacity
harness for production-shaped load testing.

## Sync production data to staging/local

This is destructive to the destination. Obtain explicit authorization for a
staging refresh.

From the developer machine:

```bash
ssh "$DROPLET" 'pm2 stop steps-tracker-staging'
node scripts/sync-prod-to-local.js --target=staging
# perform authorized verification
ssh "$DROPLET" 'pm2 stop steps-tracker-staging'
```

The sync tool must refuse a production destination and must remove production
push tokens from the copied environment.

## Marketing site

`web/dist` is committed and is not built on the production droplet.

For changes under `web/`:

```bash
cd web
npm install
npm run build
```

Verify and commit both source and regenerated `web/dist`.

Production smoke:

```bash
curl -fsSI https://barastep.com/ | head -1
curl -fsSI https://barastep.com/privacy | head -1
curl -fsSI https://barastep.com/support | head -1
```

## Rollback

Application rollback is not the same as schema rollback. Prisma migrations are
forward-only during ordinary incident response.

Before a deploy, identify a reviewed prior application commit/tag.

If rollback is needed:

1. Stop and understand any new-format queue/work items that old code cannot
   safely consume.
2. Drain or fence incompatible workers using the current revision's documented
   compatibility procedure.
3. Preserve the current operational safety files if the old revision predates
   current PM2/topology protections.
4. Check out the reviewed prior application revision.
5. Run `npm install` and `npx prisma generate`.
6. Use `./scripts/pm2-safe-prod-reload.sh`.
7. Verify topology, health, queues, and the user-facing smoke path.

Do **not** run `prisma migrate deploy` as a generic rollback step and do not
drop newly-added schema merely because the application revision moved backward.

If a specific release introduces a new persisted work format that requires a
special drain before rollback, that release must add the procedure to this
section before deployment. Do not rely on a dated archived release note during
an incident.

## Troubleshooting

### Failed Prisma migration

Read the underlying SQL error first. If the migration is safe to reapply after a
fix, use an explicitly reviewed `prisma migrate resolve --rolled-back <name>`
flow and then rerun deploy. Do not guess.

### Prisma advisory lock timeout

Identify the session actually holding the Prisma advisory lock before
terminating anything. Production migrations should prefer the direct database
endpoint when configured rather than relying on a transaction pooler session.

### Too many database connections

Check both application pool configuration and the DigitalOcean managed-pool
control plane. SQL `SHOW max_connections` does not by itself tell you the
managed pooler's usable ceiling.

### PM2 topology mismatch

Do not hand-edit PM2 state to make a check green. Compare the live state with
`ecosystem.config.js`, fix the reviewed config if necessary, and use the guarded
wrapper.

## Reusable specialized runbooks

These remain current because they cover uncommon, specialized operations rather
than ordinary deploy flow:

- `docs/capacity-load-runbook.md` — isolated production-shaped capacity testing.
- `docs/redis-cache-runbook.md` — Redis/cache operational procedures.
- `docs/race-experience-identity-search-index-runbook.md` — the non-transactional
  identity-search extension/index procedure invoked by the integration runner.

Do not promote a feature-specific dated rollout note back into live operational
authority. If a specialized procedure becomes part of normal deployment, merge
it into this file instead.

## Historical documentation

- `docs/archive/operations-history/` contains former root runbooks.
- `docs/archive/releases/` contains dated feature/release deployment notes.
- `docs/evidence/` and `docs/artifacts/` are retained verification evidence.

These are historical references only. They are not current operational
instructions.
