# Steps Tracker Backend — Deployment

Both environments run on the same DigitalOcean droplet, as separate pm2 processes against separate Postgres databases. Both track the `main` branch.

| Env     | Path                                          | pm2 name                | Port | DB                     | APNS host |
| ------- | --------------------------------------------- | ----------------------- | ---- | ---------------------- | --------- |
| prod    | `/var/www/step-tracker-backend`               | `3` (id)                | 3000 | `step-tracker`         | production |
| staging | `/var/www/step-tracker-backend-staging`       | `step-tracker-staging`  | 3003 | `step-tracker-staging` | sandbox   |

Staging is fronted by nginx + Let's Encrypt at `https://staging.steptracker-api.org`.

## Deploy to production

```bash
ssh <droplet>
cd /var/www/step-tracker-backend && \
  git pull origin main && \
  npm install && \
  npx prisma migrate deploy && \
  npx prisma generate && \
  node prisma/seed.js && \
  pm2 restart 3
```

## Deploy to staging

Same flow, just the staging path and pm2 name. Always deploy here first to validate before prod.

```bash
ssh <droplet>
cd /var/www/step-tracker-backend-staging && \
  git pull origin main && \
  npm install && \
  npx prisma migrate deploy && \
  npx prisma generate && \
  pm2 restart step-tracker-staging
```

Note: no `prisma/seed.js` on staging — seeding is for prod only.

## Sync prod data into staging (or local)

Run from your laptop, not the droplet. Requires `STAGING_DATABASE_URL` (or `DATABASE_URL` for local) in your local `.env`.

```bash
# Stop staging so it isn't holding connections
ssh <droplet> 'pm2 stop step-tracker-staging'

# From steps-tracker-backend/
node scripts/sync-prod-to-local.js --target=staging   # or --target=local

# Restart staging
ssh <droplet> 'pm2 start step-tracker-staging'
```

The script:
1. Refuses if destination URL matches `PROD_DATABASE_URL`.
2. Prompts for `yes` confirmation (staging target only).
3. Resets the destination schema (`DROP SCHEMA public CASCADE`).
4. Streams `pg_dump prod | psql dest`.
5. Truncates `device_tokens` so dev/staging never pushes to real-user APNS tokens.
6. Runs `npx prisma migrate deploy` against the destination.

## Why staging is safe from prod data

Three independent barriers:

1. **Separate database.** Staging's `.env` sets `DATABASE_URL` to `step-tracker-staging`. The running staging process never sees prod's connection string.
2. **APNS sandbox host.** Staging's `.env` sets `APNS_PRODUCTION=false`, so `src/services/apns.js` routes pushes to `api.sandbox.push.apple.com`. Real App Store device tokens are rejected by the sandbox host with `BadDeviceToken`, so it's physically impossible for staging to push to a production user.
3. **Isolated device_tokens.** Staging only ever stores tokens registered against the staging URL (your Xcode dev build, which produces sandbox tokens). The `sync-prod-to-local` script truncates this table after every prod sync.

## Frontend launch commands

```bash
# Local backend (laptop on hotspot)
flutter run --dart-define=BACKEND_BASE_URL=http://127.0.0.1:3000

# Staging
flutter run --dart-define=BACKEND_BASE_URL=https://staging.steptracker-api.org

# Production
flutter run --dart-define=BACKEND_BASE_URL=https://<prod-domain>
```

A colored banner shows on every screen in non-prod builds so you always know which environment you're hitting.
