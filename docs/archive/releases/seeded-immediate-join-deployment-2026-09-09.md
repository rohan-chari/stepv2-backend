# Immediate challenge Join — production deployment

User authorized deployment on 2026-09-09. Backend runtime commit
`1bcf874f5cd8f2a84e7dbb980aada9c3feca9325` replaced production baseline
`3292872a31fb270773ab729ee00aeedfeb1e5875` on
`release/immediate-join-20260909`. App binaries were not built or uploaded.

## Migration and handoff

All five reviewed additive migrations applied successfully through the direct
managed PostgreSQL connection, with a 3-second lock timeout and 60-second
statement timeout. Final migration census: 255 applied, zero unfinished.
The affected membership table was approximately 9 MB / 22,812 estimated rows.
Existing environment and server package-lock were preserved in the dated
server backup directory. Dependencies and environment values were unchanged;
Prisma Client was regenerated after migration.

The production reload wrapper needed an ordering correction: replace HTTP,
stop and prove the old cron exited, wait its legacy lease, stop and prove the
old resolution process exited, then start new resolution before new cron.
This keeps the old worker away from newly published reservation-backed shells.
The wrapper retains its flock, baseline, HTTP transition, process identity,
final topology and pool checks, and saves PM2 only after success. The chronology
regression failed before the correction; all 25 guard tests passed afterward.
Independent reviewer cleared the implementation.

The reload completed at approximately 21:14:38 UTC. Final topology is two HTTP
workers, one resolution worker and one cron process, aggregate pool ceiling 32.
Staging remained stopped. API availability checks succeeded during the handoff.

## Verification

- Public health: HTTP success, API `ok`, Redis `ok`.
- Authenticated Featured GET: legacy response 200 without currentJoin;
  bucket-capable response 200 with currentJoin on daily and weekly cards.
  No manual Join or synthetic step mutation was used for verification.
- All four current/upcoming automatic scan records completed their scans.
- Stored upcoming schedules verified in SQL with explicit timezone conversion:
  daily **2026-09-09 23:30 ET**, weekly **2026-09-13 23:15 ET**.
  Timestamp-without-time-zone fields were interpreted as UTC, matching Prisma;
  a raw node-postgres Date display uses the host zone and is not authoritative.
- Referral catch-up: audit/apply/final audit all zero missing ownership/activity
  rows; apply inserted/updated zero rows.
- Powerup copy sync: already matched; no changes. Balance drift retained the
  existing three Decoy differences; live economy settings were not overwritten.
- Short observation: six queued resolution jobs, no running/failed jobs at the
  sampled instant, and no transaction older than 30 seconds. No new resolution
  error-log output or seeded-preparation errors during the 25-second delta watch.

Billing unavailable/realm-mismatch and daily-reminder receipt-collision messages
were observed in unchanged paths. One billing-unavailable message occurred during
the short delta watch. These are not a clean bill of health for unrelated systems.
No production midnight load or overall CPU improvement is claimed; the actual
scheduled preparation/rollover occurs later. See the local validation report for
synthetic measurements and their limitations.

The new backend contract is live. The matching Join button behavior still requires
a separately authorized iOS/Android app release. Existing clients retain their
compatible API paths.
