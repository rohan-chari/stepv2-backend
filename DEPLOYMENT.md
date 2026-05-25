# Backend Deployment

Two pm2 processes running on the same DigitalOcean droplet, each from its own git checkout against its own Postgres database. Both track different branches.

| Env     | Checkout path                            | pm2 name                | Port | Database               | Branch       | APNS host  |
| ------- | ---------------------------------------- | ----------------------- | ---- | ---------------------- | ------------ | ---------- |
| prod    | `/var/www/step-tracker-backend`          | `3` (id)                | 3000 | `step-tracker`         | `main`       | production |
| staging | `/var/www/step-tracker-backend-staging`  | `step-tracker-staging`  | 3003 | `step-tracker-staging` | release branch (`1.1.5`, `1.1.6`, …) | sandbox |

Staging is fronted by nginx + Let's Encrypt at `https://staging.steptracker-api.org`.
Prod is at the production API URL.

---

## Branch model

- **`main` = what's live in prod.** Never push speculative work directly here.
- **Release branches** (`1.1.5`, `1.1.6`, …) are where in-progress work lives. Staging deploys from these.
- **Promote with a merge to `main` only when the release is actually being cut to prod.** Tag the deployed commit immediately afterward.

---

## Working on a new release (e.g., 1.1.5)

### 1. Create the branch locally (both repos, day one)

```bash
cd /Users/rohan/Documents/steps-tracker-backend
git checkout main && git pull
git checkout -b 1.1.5
git push -u origin 1.1.5
```

Do the same on the frontend repo. Frontend and backend release branches share the same name so they're easy to track in pairs.

### 2. Iterate on the branch

Commit work to `1.1.5`. Never commit directly to `main`.

### 3. Deploy the branch to staging

From your laptop:

```bash
ssh <droplet>
cd /var/www/step-tracker-backend-staging
git fetch origin
git checkout 1.1.5
git pull origin 1.1.5
npm install
npx prisma migrate deploy
npx prisma generate
pm2 restart steps-tracker-staging
```

Confirm it came up:

```bash
pm2 logs step-tracker-staging --lines 30
```

### 4. Test against staging

The Flutter "Bara Staging" app on your phone (TestFlight build, baked with `BACKEND_BASE_URL=https://staging.steptracker-api.org`) now talks to this code. Test thoroughly.

If you push fixes to `1.1.5`, repeat step 3.

---

## Cutting the prod release

Only do this when staging has been stable for the changes and you're ready to ship.

### 1. Merge the release branch into `main`

```bash
cd /Users/rohan/Documents/steps-tracker-backend
git checkout main && git pull
git merge --ff-only 1.1.5    # use --ff-only to keep history linear; if it refuses, rebase 1.1.5 onto main first
git push origin main
```

### 2. Tag the soon-to-be-deployed prod commit

This is your rollback anchor. Do it **before** the deploy so a clean rollback target exists.

```bash
git tag -a pre-1.1.5 -m "Last commit before 1.1.5 prod deploy"
git push origin pre-1.1.5
```

### 3. Deploy backend to prod

```bash
ssh <droplet>
cd /var/www/step-tracker-backend
git pull origin main
npm install
npx prisma migrate deploy
npx prisma generate
node prisma/seed.js
pm2 restart 3
```

### 4. Smoke test

```bash
pm2 logs 3 --lines 50
curl https://api.steptracker-api.org/health    # or your prod URL
```

Hit the app on your phone, check sign-in / home / races / leaderboard.

### 5. Tag the deployed version

```bash
git tag -a v1.1.5-deployed -m "Deployed to prod"
git push origin v1.1.5-deployed
```

---

## Rollback

If prod is broken and you need to revert:

```bash
ssh <droplet>
cd /var/www/step-tracker-backend
git checkout pre-1.1.5
npm install                        # in case dependencies changed
npx prisma generate                # in case Prisma client needs regen
pm2 restart 3
```

**Do NOT run `prisma migrate deploy` during rollback.** Migrations are forward-only. If a migration was applied as part of 1.1.5, the schema stays migrated. The reverted code must be compatible with the new schema, OR you need to write a new "down" migration (rare; usually means redesigning the change).

This is why **destructive migrations stay out of 1.1.5 until you're confident**. See "Schema migrations" below.

---

## Schema migrations

Migrations are the one thing that's hard to undo. Rules:

1. **Always run `prisma migrate dev --name <something>` against staging first.** Inspect the generated `.sql` file in `prisma/migrations/`. Confirm the SQL does what you intend.
2. **Never `prisma db push` against prod.** It bypasses migration history. Always `prisma migrate deploy`.
3. **For destructive migrations (DROP TABLE, DROP COLUMN), separate them into their own release.** Don't combine schema cleanup with feature work.
4. **Once a migration is in `prisma/migrations/` and committed, do not edit it.** If you need to change it, write a follow-up migration instead. Editing already-applied migrations corrupts the migration history.

---

## Syncing prod data into staging

From your laptop, not the droplet. Requires `STAGING_DATABASE_URL` in your local `.env`.

```bash
ssh <droplet> 'pm2 stop step-tracker-staging'
node scripts/sync-prod-to-local.js --target=staging
ssh <droplet> 'pm2 start step-tracker-staging'
```

The script:
1. Refuses if dest URL matches `PROD_DATABASE_URL`.
2. Prompts for `yes` confirmation.
3. Resets the destination schema (`DROP SCHEMA public CASCADE`).
4. Streams `pg_dump prod | psql dest`.
5. Truncates `device_tokens` so staging never pushes to real user APNS tokens.
6. Runs `npx prisma migrate deploy` against destination.

---

## Why staging is safe from prod data

Three independent barriers:

1. **Separate database.** Staging's `.env` sets `DATABASE_URL` to `step-tracker-staging`. The running staging process never sees the prod connection string.
2. **APNS sandbox host.** Staging's `.env` sets `APNS_PRODUCTION=false`, so `src/services/apns.js` routes pushes to `api.sandbox.push.apple.com`. Production device tokens are rejected by the sandbox host with `BadDeviceToken`, so staging cannot push to App Store users.
3. **Isolated device_tokens.** Staging only stores tokens from "Bara Staging" builds (Xcode + TestFlight), which produce sandbox tokens. The `sync-prod-to-local` script truncates this table after every prod sync.
