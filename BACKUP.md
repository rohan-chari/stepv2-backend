# BACKUP.md — manual dated PROD database backup

A belt-and-suspenders, on-demand snapshot of the prod database, stored on the
droplet (and locally). This is **in addition to** DigitalOcean managed
Postgres's own automated daily backups + PITR — it's a manual insurance dump you
can take before a risky migration, or on a cadence.

> **Trigger (one prompt):** "make a dated prod backup" / "back up prod" / "take a
> prod DB snapshot." When asked, follow this doc end-to-end.

## Key facts (why it's not just `pg_dump` on the droplet)

- **Prod DB is the managed DigitalOcean Postgres, not on the droplet.** Connection
  string is `PROD_DATABASE_URL` in your **local `.env`** (gitignored — never paste
  the password into a file or chat). The droplet is only the app server (pm2).
- **Version gotcha:** prod runs **Postgres 18.x**. `pg_dump`'s major version must
  be **≥ the server's**. The droplet's bundled `pg_dump` is **16.x** and will
  *refuse* to dump an 18 server. So **dump from your laptop** using a
  pg18+ client, then copy the file onto the droplet. (Don't "fix" this by
  installing a client on the droplet unless you specifically want droplet-side
  dumps — see Future options.)
- **A pg18 client already exists locally** via Homebrew:
  `/opt/homebrew/opt/postgresql@18/bin/{pg_dump,pg_restore,psql}`. Use the full
  path — the default `pg_dump` in `PATH` is pg16 and will fail.
- **Droplet host/SSH:** recover the host + key inline per `CLAUDE.md` →
  "Connecting to the droplet (SSH)". Do **not** hardcode the IP anywhere.

## Procedure

Run from your laptop. `$DATE` is today's date as `YYYY-MM-DD`; `$DROPLET` is
`root@<host>` recovered per the SSH section.

```bash
PGD=/opt/homebrew/opt/postgresql@18/bin/pg_dump
PGURL="$(grep -E '^PROD_DATABASE_URL=' .env | cut -d= -f2-)"   # from local .env, not committed
DATE=$(date -u +%Y-%m-%d)
OUT="step-tracker-prod-${DATE}.dump"

# 0. Sanity: confirm the client connects and note the size
/opt/homebrew/opt/postgresql@18/bin/psql "$PGURL" -tAc "select 'ok', pg_size_pretty(pg_database_size(current_database()));"

# 1. Dump — custom format (-Fc), compressed (-Z6). Restorable via pg_restore.
"$PGD" "$PGURL" -Fc -Z6 -f "$OUT"

# 2. Verify the dump is readable and has all tables' data
/opt/homebrew/opt/postgresql@18/bin/pg_restore -l "$OUT" | grep -c "TABLE DATA"

# 3. Copy onto the droplet and verify checksums match
ssh "$DROPLET" 'mkdir -p /root/backups'
scp "$OUT" "$DROPLET":/root/backups/
shasum -a 256 "$OUT"
ssh "$DROPLET" "sha256sum /root/backups/$OUT"   # must match the line above
```

A dump is ~5 MB (DB is ~64 MB; custom format compresses well). The droplet has
tens of GB free, so retention is a non-issue — keep many.

## Restore (if prod is ever lost)

Use a **pg18+** `pg_restore` against the target DB:

```bash
/opt/homebrew/opt/postgresql@18/bin/pg_restore \
  --clean --if-exists --no-owner \
  -d "<target DATABASE_URL>" step-tracker-prod-YYYY-MM-DD.dump
```

Never restore over prod without explicit confirmation (see `CLAUDE.md` → "Always
ask before deploying to prod" — a restore is a destructive prod write).

## Caveats / honest limits

- The dump contains the **full users table** (PII). A copy lands on your laptop
  and on the droplet. Delete the local copy if you don't want it lingering.
- The droplet copy lives in the **same DO account/region** as the DB, so it
  doesn't protect against an account-level loss. For real DR, also push a copy
  **off-DO** (object storage elsewhere). The local laptop copy partially covers
  this.

## Future options (not done yet)

- **Droplet-side dumps:** install the pg18 client on the droplet (PGDG apt repo)
  so it can `pg_dump` prod itself — removes the laptop from the loop.
- **Nightly cron:** schedule a dated dump + retention prune (e.g. keep 14 days).
- **Off-site copy:** sync `/root/backups` to DO Spaces or another provider.
