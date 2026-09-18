# Global-event reliability phase-two runbook

Phase two is deliberately excluded from `prisma migrate deploy`. It is a
roll-forward-only token quarantine and concurrent-index operation performed
only after the expand migration and generation-2 backend have been reviewed,
deployed, and continuously ready. Production or staging execution requires
fresh, in-the-moment authorization.

## Preconditions

1. Confirm exactly the four logical owners `http:0`, `http:1`, `resolution:0`,
   and `cron:0` are live at generation 2 with every required capability, with
   no overlapping boot, unexpected identity, duplicate identity, or live
   legacy/null-owner row, for at least 90 seconds. A legacy row blocks phase
   two until its lease expires.
2. Confirm the bounded cleanup has set `quarantine_started_at`, backfilled every
   null token status, retained no more than ten active rows per user, and left
   zero active `(platform,token)` or `(platform,installation_id)` conflicts.
3. Confirm no old sender that ignores token status remains. From the quarantine
   timestamp onward, rollback is code-forward only; never restore a legacy
   writer/reader/sender and never reverse or drop schema during an incident.
4. Take the separately approved operational backup and record census, cleanup,
   conflict, cap, and backlog counts. This repository task performs none of
   these environment actions.

## Apply

Run with `ON_ERROR_STOP` in a standalone `psql` session because PostgreSQL does
not allow `CREATE INDEX CONCURRENTLY` inside a transaction:

```sh
psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --file=scripts/global-event-reliability-phase2.sql
```

The script rechecks readiness, quarantine, null-status, ownership-conflict, and
per-user-cap invariants immediately before creating the two partial unique
indexes. `IF NOT EXISTS` makes a verified retry safe.

## Verify and rollback posture

- Verify both partial indexes are valid and every invariant query still returns
  zero violations.
- Verify registration, logout, target snapshot, delivery retry, and cleanup
  health before proceeding with the app rollout.
- Before quarantine, rollback may stop new production and retain a generation-2
  consumer until new events drain. At or after quarantine, use compatible
  generation-2 code and roll forward. Do not drop the indexes or columns during
  incident response.
