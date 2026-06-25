# Backend Deployment

Two pm2 processes running on the same DigitalOcean droplet, each from its own git checkout against its own Postgres database. Both track different branches.

| Env     | Checkout path                            | pm2 name                | Port | Database               | Branch       | APNS host  |
| ------- | ---------------------------------------- | ----------------------- | ---- | ---------------------- | ------------ | ---------- |
| prod    | `/var/www/step-tracker-backend`          | `steps-tracker` (id `3`) | 3002 | `step-tracker`         | `main`       | production |
| staging | `/var/www/step-tracker-backend-staging`  | `steps-tracker-staging` (id `4`) | 3003 | `step-tracker-staging` | release branch (`1.1.5`, `1.1.6`, …) | sandbox |

nginx + Let's Encrypt front both:
- prod:    `https://steptracker-api.org`         → `localhost:3002`
- staging: `https://staging.steptracker-api.org` → `localhost:3003`

(Note: there is no `api.` subdomain — `api.steptracker-api.org` does not resolve.)

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
pm2 logs steps-tracker-staging --lines 30
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
curl https://steptracker-api.org/health    # prod (also: localhost:3002/health)
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
ssh <droplet> 'pm2 stop steps-tracker-staging'
node scripts/sync-prod-to-local.js --target=staging
ssh <droplet> 'pm2 start steps-tracker-staging'
```

The script:
1. Refuses if dest URL matches `PROD_DATABASE_URL`.
2. Prompts for `yes` confirmation.
3. Resets the destination schema (`DROP SCHEMA public CASCADE`).
4. Streams `pg_dump prod | psql dest`.
5. Truncates `device_tokens` so staging never pushes to real user APNS tokens.
6. Runs `npx prisma migrate deploy` against destination.

---

## Shareable race links & deep links

### Domain split: API on steptracker-api.org, user-facing links on barastep.com

The **API stays on `steptracker-api.org`** (and `staging.steptracker-api.org`) —
that's `BACKEND_BASE_URL`, baked into every shipped binary, and it never changes,
so installed apps keep working with zero risk. Only the **user-facing web surface**
moves to **`barastep.com`**: share links (`/r/:token`), the static pages
(`/`, `/support`, `/privacy`), the deep-link verification files, and `share-card.png`.
The win: links sent in iMessage show `barastep.com` (branded, not "suspicious")
instead of the API hostname.

This works because it's **one backend + one DB** behind nginx — `barastep.com` is
just a second `server_name` pointing at the same app. The share token is minted
into the same DB regardless of which host is advertised; the app extracts the
token (the Dart parser is host-agnostic) and calls its own API base
(`steptracker-api.org`) to join. iMessage sees barastep, the API stays on steptracker.

Server setup (additive, ~zero downtime):
- DNS (Cloudflare, records DNS-only / grey-cloud so the proxy can't break
  Let's Encrypt or the `.well-known` files): `A barastep.com → <droplet IP>`
  (+ `www`, + `staging.barastep.com` if mirroring staging).
- TLS: `sudo certbot --nginx -d steptracker-api.org -d barastep.com --expand`.
- nginx: add `barastep.com` to the prod block's `server_name` (same `proxy_pass`),
  `staging.barastep.com` to staging. `nginx -t && systemctl reload nginx`.
- Static-page redirects on the OLD host are fine (browser GETs, not the API):
  `301 /privacy`,`/support` on steptracker-api.org → barastep.com.
- Email: Cloudflare Email Routing forwards `support@barastep.com` → your inbox
  (the static pages now use that address). Set this up BEFORE deploying the pages
  or the mail bounces.

| Env var | staging | prod | What it controls |
|---|---|---|---|
| `PUBLIC_BASE_URL` | `https://staging.barastep.com` | `https://barastep.com` | Host used to mint share links + the universal-link domain. Set explicitly in BOTH environments (the code default is still steptracker for safety — do not rely on it). **Set only after barastep.com serves the app**, or minted links will point at a domain that doesn't resolve. |
| `OG_IMAGE_URL` | `https://staging.barastep.com/share-card.png` | `https://barastep.com/share-card.png` | Optional link-preview image. **Only set it once `public/share-card.png` (1200×630) actually exists** — otherwise the page advertises an `og:image` that 404s. Leave empty for a clean text-only card. |
| `IOS_APP_ID` | `TEAMID.com.rohanchari.steptracker` | same | Apple Team ID + bundle id baked into the AASA file. |
| `ANDROID_PACKAGE` / `ANDROID_SHA256_FINGERPRINTS` | from Play Console | same | Android App Links verification (`assetlinks.json`). Until the real signing fingerprints are set, Android links won't auto-open the app. |

**`PUBLIC_BASE_URL` must match the app build's `applinks:` associated-domain.**
A universal link only opens the app if the host in the link equals a domain the
installed binary claims. The build now claims **`barastep.com`** (and keeps
`steptracker-api.org`), so share links must be minted on barastep.com; otherwise
links fall through to the browser landing page (the `bara://` "Open in app" button
still works). The deep-link files' *content* is host-agnostic, so the same app
serves valid `/.well-known/*` on both hosts automatically.

### Before shipping an app version that uses share links — prod must be ready first

These are server-side and reach **all** app versions at once, so deploy them to
prod **before** the app build hits users:

1. The `/r/:token` route + `/.well-known/apple-app-site-association` +
   `/.well-known/assetlinks.json` are deployed and return 200.
2. The env vars above are set (especially `PUBLIC_BASE_URL`, `IOS_APP_ID`,
   `ANDROID_SHA256_FINGERPRINTS`).
3. If using a preview image, `public/share-card.png` exists and
   `GET /share-card.png` returns 200.

> **`pm2 restart` ≠ deploy.** Restart only re-runs the code already checked out
> on the droplet. New code (routes, the landing page, og:image support) must be
> committed, pushed, and `git pull`ed onto the droplet's checkout first, then
> restarted. Verify with `curl https://<host>/r/anytoken` (expect the
> "Race not found — Bara" page, not a bare `Error` 404).

---

## Deploying shop accessories (cosmetics)

An accessory is two halves that deploy on different tracks:

- **The PNG** lives in the *app* repo (`assets/images/accessories/{assetKey}.png`)
  and is baked into the binary. It only reaches users via a TestFlight/App Store
  build. There is no image upload or CDN.
- **The catalog row** lives in each environment's `shop_items` table (source of
  truth in git: `data/cosmetics.json`). Rows are keyed by `sku`.

### Adding a new accessory

1. Drop the PNG into the app repo (`assets/images/accessories/` — picked up by
   the existing pubspec glob; a newly added file needs a full `flutter run`
   restart, not just hot reload).
2. Add the item to `data/cosmetics.json` with **`testOnly: true`** and rough
   `renderMetadata`. There is no admin CREATE endpoint — `cosmetics-apply.js`
   is how new items are born.
3. Seed staging from your laptop:
   ```bash
   DATABASE_URL="$(grep '^STAGING_DATABASE_URL=' .env | cut -d= -f2-)" node scripts/cosmetics-apply.js
   ```
4. Run the app locally against staging (`flutter run --dart-define=BACKEND_BASE_URL=https://staging.steptracker-api.org`).
   Dev builds send `X-Release-Channel: testflight`, so `testOnly` items are
   visible/purchasable. Tune position/rotation/scale in the admin accessory
   tuner and save.
5. Saving in the tuner writes the current environment's DB **and mirrors the
   full item (upsert by sku) to the peer DB** via `PEER_DATABASE_URL`
   (`src/utils/mirrorShopItem.js`). Both droplet `.env`s have it set
   (prod ↔ staging, configured 2026-06-10). So tuning against staging also
   creates/updates the item in prod — safe, because `testOnly: true` hides it
   from App Store clients everywhere (catalog, purchase, equip, and other
   users' avatars).
6. **After tuning, pull the DB back into git** so `cosmetics.json` matches:
   ```bash
   DATABASE_URL="$(grep '^STAGING_DATABASE_URL=' .env | cut -d= -f2-)" node scripts/cosmetics-pull.js
   ```
   Commit the result.
7. Ship the PNG in the next TestFlight build (testers see the item immediately).

### Launching to prod

Once the App Store build containing the PNG is approved and broadly adopted,
flip `testOnly` off in the admin tuner (mirrors to both DBs) and re-run
`cosmetics-pull.js` to record it. Old binaries without the PNG fall back to a
placeholder icon (`errorBuilder`) — they don't crash, but they can buy/equip
something they can't render, so wait out the phased rollout (~a week) before
flipping unless the placeholder UX is acceptable.

### The footgun

`cosmetics-apply.js` **upserts every field of every item, including
`renderMetadata`.** If tuner-saved positioning exists only in the DB and not in
`cosmetics.json`, re-running apply (e.g. to add the next item) silently
overwrites the tuning. Always run `cosmetics-pull.js` (step 6) after a tuning
session, before the next `cosmetics-apply.js`.

Note: `cosmetics-apply.js` is **manual only** — it is no longer run on deploy
(`prisma/seed.js` stopped calling it for exactly this reason), so a normal deploy
won't clobber tuned values. The footgun is now scoped to *you* re-running apply,
not to the deploy pipeline.

---

## Why staging is safe from prod data

Three independent barriers:

1. **Separate database.** Staging's `.env` sets `DATABASE_URL` to `step-tracker-staging`. The running staging process never sees the prod connection string.
2. **APNS sandbox host.** Staging's `.env` sets `APNS_PRODUCTION=false`, so `src/services/apns.js` routes pushes to `api.sandbox.push.apple.com`. Production device tokens are rejected by the sandbox host with `BadDeviceToken`, so staging cannot push to App Store users.
3. **Isolated device_tokens.** Staging only stores tokens from "Bara Staging" builds (Xcode + TestFlight), which produce sandbox tokens. The `sync-prod-to-local` script truncates this table after every prod sync.
