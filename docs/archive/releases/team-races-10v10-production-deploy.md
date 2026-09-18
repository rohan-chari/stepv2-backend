# 10v10 production deployment — September 9, 2026

The user explicitly authorized backend deployment, TestFlight upload and both origin pushes after candidate verification.

- Runtime source: `20e3909f881f53aa722b74ef0ac0b9c0c85c1867`, production `main`; pushed to origin.
- Previous runtime: `442b749cd29f50efc0be3028e129193bc624882e`; rollback tag `pre-team-10v10-20260909` pushed before deployment.
- Deployment tag: `deploy/team-10v10-20260909-20e3909`, pushed after health/topology verification.
- Fast-forwarded production checkout. No migration, dependency install, schema regeneration or environment changes were required. The schema diff is a comment only.
- Existing server package-lock metadata preserved in `/root/backups/team-10v10-20260909/package-lock.json` and retained in the checkout.
- Powerup copy apply reported no changes. Existing live DECOY balance drift was reported and preserved.
- Guarded reload replaced the two HTTP workers at 16:29:12/14 UTC, cron at 16:29:49 and resolution at 16:29:51. The wrapper proved role transitions, final pool ceiling 32 and topology, then saved PM2.
- Final topology: two HTTP, one cron, one resolution, all online. Staging remained stopped throughout.
- Public `/health` returned `status:ok, redis:ok`. Post-reload referral audit/apply/final audit each reported zero missing records; apply inserted zero records.
- Existing cron logs include insufficient-participant scheduled-start validation and billing reconciliation errors; this deployment does not address those paths. No production capacity claim or production integration tests were made.

The source and local real-HTTP compatibility/roster/load evidence are in `team-races-10v10-contract.md` and `evidence/team-races-10v10-*.json`. Frontend runtime source is `54b882c`, iOS 2.3.13 build 9 / Android 203139. TestFlight status is recorded in the frontend `docs/team-races-10v10-release.md` after Apple processing.
