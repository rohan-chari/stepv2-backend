# Event traffic efficiency production deployment

User explicitly authorized production backend deployment followed by TestFlight upload. Backend deployment completed on 2026-09-10 UTC.

- Deployed commit `9e99fcbd6799cd944ddbbe7e0f0589c5016a4a38`, runtime `f264099`, production/main. Rollback anchor `2f021c2698f41071e526308127ddaf2b6050c35e`, tag `pre/event-traffic-efficiency-20260910`. Deployed tag `deploy/event-traffic-efficiency-20260910-9e99fcb` pushed.
- Preflight: 256 migrations applied, none missing or unfinished. No schema, dependency, pool configuration or capacity change; installation/generation/migration execution unnecessary. The historical migration checker expected a laptop-only variable absent on the server; equivalent bounded read-only SQL against the server's configured database completed successfully.
- Managed pool: transaction mode, production size40, staging size3; direct maximum50. Guarded reload verified HTTP2×10 + resolution8 + cron4 =32 maximum application connections. Two HTTP workers and both dedicated workers online; staging stopped. All previous production process PIDs exited.
- Existing server `.env` and modified `package-lock.json` were backed up in the dated owner-only backup directory and verified byte-identical afterward.
- Required powerup-copy synchronization found no changes. The documented three Decoy balance-snapshot differences remain unchanged. Referral ledger audit/apply/final audit all report zero missing rows and zero mutations.
- Public and local API health passed. Public marketing root, privacy and support returned200. Authenticated legacy Home, full shell and `home-sync-refresh-v1` each returned200 with the expected representation. No artificial uploads, races or production integration tests were created.
- At04:00:24UTC, the deployment-window log slices contained no P2028/P2002/P2024/53300/deadlock, unhandled-rejection or watchdog matches. This bounded observation is not a full peak-window performance claim.

Evidence: [deployment records](evidence/event-traffic-efficiency/deployment/). The original local traffic diagnostic exceptions remain preserved in the implementation validation package. Actual managed CPU improvement during comparable events remains a production observation task.

Frontend signed iOS2.3.13(12) upload was attempted only after backend compatibility checks passed. Xcode failed before upload with `IDEDistributionErrorDomain Code=2`, `Failed to Use Accounts`, requesting App Store Connect access for the configured team. Per the frontend runbook, upload stopped pending Apple-account reauthentication. The matching Android203142 artifact is verified and retained locally. No App Review, customer release or Play upload was performed.

## Frontend completion

The user authorized the existing App Store Connect API key after the signed-in Xcode account failed. API-authenticated upload succeeded; Bara2.3.13(12), buildID `f550e94a-c830-43ab-b5b8-6f7e011470a7`, was verified `VALID` / `IN_BETA_TESTING` in the existing internal **bara testers** group at2026-09-10T04:20:45UTC. The earlier account blocker is resolved. Uploaded frontend source `591340c`, tag `testflight/2.3.13-12`; matching Android203142 remains verified locally. Existing AppLovin/Meta dSYM warnings were nonblocking. No App Review, customer release or Play upload occurred. Frontend runbook now prefers the configured API key, with matching AGENTS/CLAUDE instructions. Backend runtime/deployment is unchanged by this documentation update.
