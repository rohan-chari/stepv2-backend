# Admin analytics production deployment — 2026-09-13

Authorized by the user's deployment request after implementation review. Runtime commit `9f6add4`; deployment tag `deploy/admin-analytics-snapshots-20260913-9f6add4`; rollback anchor `pre-admin-analytics-snapshots-20260913` points to previous runtime `753dbfb`.

The release was isolated from unrelated working-tree changes. Production fast-forwarded from its prior runtime; intervening changes were documentation only. Dependencies and environment were unchanged; the existing remote package-lock edit and environment hashes were preserved. Prisma Client generation succeeded.

Migration `20260913190000_admin_purchase_history_indexes` succeeded via normal Prisma migrate deploy over the verified direct production database connection. All four indexes are valid and ready. The two historical rolled-back migration attempts are already superseded by successful applications; no migration-resolution mutation was needed.

The guarded production reload passed its final topology and pool checks: two HTTP workers, one resolution worker, one cron worker, aggregate connection ceiling 32. Staging stayed stopped. API and Redis health are healthy; public API health and marketing home/privacy/support return HTTP 200. Powerup copy already matched; existing Decoy balance snapshot drift was reported without changing policy. Referral catch-up audit/apply/audit found and changed zero rows.

Authenticated production smoke checks:

- Cold dashboard summary: HTTP 200, 3,424 ms; snapshot freshness interval 900 seconds.
- Warm summary: HTTP 200, 13 ms, identical calculation timestamp.
- Purchase history, all kinds, limit 5: HTTP 200, 47 ms, five records with username fields. No identities or purchase contents were logged.
- Analytics logs: extraction 49,182 rows / 9,585,776 bytes / 730 ms; DB-free worker 207 ms, completion heap 34,753,744 bytes; snapshot build 3,267 ms followed by cache hits. These are individual production smoke measurements, not sustained load or CPU measurements.

Backend performance improvements are available to existing app binaries. Displaying purchase usernames and the new freshness/refresh UI requires new iOS and Android binaries. No app build, store upload or customer release occurred in this deployment turn. Prior debug builds and local verification remain documented separately.
