# Integration Suite Cleanup Audit

Branch: `performance/scalability`

## Recommendation

The current `test/integration` directory contains **401 JS test/support files**. The default suite should be reduced to a small set of real-DB gameplay correctness tests. This audit does **not** delete anything yet.

### Classification totals

| Action | Files |
|---|---:|
| KEEP | 3 |
| MERGE | 133 |
| MOVE | 250 |
| DELETE | 15 |

Definitions:

- **KEEP**: already lean and focused enough to remain a default integration test.
- **MERGE**: contains an enduring integration invariant, but should be consolidated into a canonical domain file and the original removed.
- **MOVE**: still useful, but belongs in unit/service/HTTP/contract/performance/reliability/maintenance suites.
- **DELETE**: historical rollout/batch/implementation-specific coverage with no reason to remain after extracting any enduring invariant.

## Proposed lean default integration suite

The end state should be roughly **18–25 files**, centered on:

```text
test/integration/
  scoring/
    step-samples.test.js
    global-events.test.js
    historical-corrections.test.js
    team-scoring.test.js

  powerups/
    offensive.test.js
    defensive.test.js
    transfer-and-copy.test.js
    buffs-stacking-and-conflicts.test.js
    boxes-and-inventory.test.js
    effect-expiry.test.js

  queue/
    step-sync-pipeline.test.js
    race-dirty-and-resolution.test.js
    race-single-writer.test.js
    retry-recovery.test.js

  races/
    lifecycle.test.js
    team-lifecycle.test.js
    settlement.test.js

  economy/
    buyins-and-payouts.test.js
    funded-prizes.test.js
```

A few small focused existing files may remain as-is if they stay clearer than merging them.

## Full file-by-file audit

| # | Current file | Action | Proposed destination | Reason |
|---:|---|---|---|---|
| 1 | `accessory-compatibility.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 2 | `accessory-preview.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 3 | `accessory-tuner-perfoot.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 4 | `account-deletion-database-conflicts.test.js` | **MOVE** | `test/maintenance/account-integrity.test.js` | Useful DB integrity coverage, but outside the lean gameplay integration suite. |
| 5 | `activation-onboarding-v2.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 6 | `active-giveaway-home-banner.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 7 | `active-impact-home-summary-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 8 | `ad-coin-reward.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 9 | `admin-analytics-snapshots-purchases.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 10 | `admin-dau-compact-query.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 11 | `admin-dau-engagement.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 12 | `admin-dau-frozen-fixture.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 13 | `admin-metrics-cleanup.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 14 | `admin-metrics-dashboard-blocks.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 15 | `admin-metrics-dashboard-contract.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 16 | `admin-metrics-referral-hmac-rotation.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 17 | `admin-metrics-telemetry.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 18 | `admin-page-abort-transaction.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 19 | `admin-page-memory.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 20 | `admin-shop-item-create.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 21 | `admin-snapshot-section-isolation.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 22 | `admin-system-health.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 23 | `admin.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 24 | `adminRedisFixture.cjs` | **MOVE** | `test/support/adminRedisFixture.cjs` | Harness code, not a test. |
| 25 | `adminSnapshotHttpProcess.cjs` | **MOVE** | `test/support/adminSnapshotHttpProcess.cjs` | Harness code, not a test. |
| 26 | `api-contract-payload-cleanup-contracts.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 27 | `api-contract-query-plans.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 28 | `api-contract-resolution-query-count.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 29 | `appVersion.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 30 | `backend-catalog-authority.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 31 | `backpack-retirement.test.js` | **MOVE** | `test/maintenance/retirements/` | Repair/retirement script correctness should not run in default integration. |
| 32 | `balance-config-admin.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 33 | `balance-config-player.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 34 | `banner-ads-admin-toggle-contract.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 35 | `bara-feature-batch-backend.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Extract transaction rollback and Decoy redirect invariant; delete historical batch wrapper. |
| 36 | `bara-gold-characters.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 37 | `bara-gold-compatibility.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 38 | `batch-0808-admin-version-stats.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 39 | `batch-0808-box-reroll.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 40 | `batch-0808-completed-participants.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 41 | `batch-0808-discard-balance-config.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 42 | `batch-0808-discard-coins.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 43 | `batch-0808-private-race-autostart.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 44 | `billing-terms.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 45 | `box-progress-effect-immunity.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 46 | `box-progress-race-timezone.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 47 | `box-raw-steps-position.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 48 | `box-raw-steps-worker-redis.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 49 | `buff-stacking-event-scoring.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 50 | `bugbatch-b1-mystery-box-feed.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 51 | `bugbatch-b2-mirror-self-push.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 52 | `bugbatch-b3-redeem-preflight.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 53 | `bugbatch-b4-rainstorm-percaster.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 54 | `buy-in-hold-concurrency.test.js` | **KEEP** | `buy-in-hold-concurrency.test.js` | Small, focused real-DB concurrency invariant for money-like state. |
| 55 | `cache-efficiency-burst.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 56 | `cache-efficiency-domain-writers.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 57 | `cache-efficiency-personal-readers.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 58 | `cache-efficiency-review-maintenance.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 59 | `capacity-db-pool-measurement-reset.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 60 | `capacity-phase-metrics-v1.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 61 | `centralized-notification-delivery.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 62 | `character-wardrobe-cache.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 63 | `character-wardrobe-operations.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 64 | `character-wardrobe-query-evidence.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 65 | `character-wardrobe-safety.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 66 | `character-wardrobe-writers.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 67 | `character-wardrobes.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 68 | `characterVisibility.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 69 | `completed-race-summary-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 70 | `cron-work-bounds.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 71 | `daily-reward-box-powerups.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 72 | `daily-reward-box-shop-parity.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 73 | `daily-reward-box.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 74 | `db-cpu-operational-counters.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 75 | `db-cpu-prepared-discovery.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 76 | `db-cpu-prepared-lanes.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 77 | `db-cpu-work-accounting.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 78 | `decoy-redirection-concurrency.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 79 | `decoy-shop-cooldown.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 80 | `decoy-shop-migration.test.js` | **MOVE** | `test/maintenance/migrations/` | One-time catalog migration compatibility. |
| 81 | `delete-account-tournaments.test.js` | **MOVE** | `test/http-and-service/tournaments/` | Bracket/discovery/API behavior can be service/HTTP tested. |
| 82 | `demo-race-tutorial.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 83 | `discard-cap-visibility.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 84 | `discovery-featured-bracket-joinable.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 85 | `display-refresh-reproduction.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 86 | `domain-event-receipt-audit.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 87 | `domain-event-receipt-discovery-admission.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 88 | `domain-event-receipt-entitlement-recovery.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 89 | `domain-event-receipt-http.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 90 | `domain-event-receipt-production-cli.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 91 | `domain-event-receipt-query-budget.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 92 | `domain-event-receipt-reliability.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 93 | `domain-event-receipt-single-deployment.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 94 | `duplicate-leech-repair.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 95 | `durable-queue-receipts.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 96 | `durable-queue-wake-classification.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 97 | `effect-fingerprint-reuse.test.js` | **MERGE** | `test/integration/powerups/effect-expiry.test.js` | Keep effect timing/consequence correctness. |
| 98 | `event-action-efficiency.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 99 | `event-end-drain-timezone.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 100 | `event-fingerprint-cache.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 101 | `event-recap-late-samples.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 102 | `event-recap-retained-schema-account-deletion.test.js` | **MOVE** | `test/maintenance/account-integrity.test.js` | Retained-schema deletion integrity, not gameplay integration. |
| 103 | `event-recap-settlement-compat.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 104 | `event-recap-start-cohort.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 105 | `event-surge-notification-admission.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 106 | `event-timezone-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 107 | `extra-spin-funnel.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 108 | `feature-batch-2026-07-24-discovery.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 109 | `feature-batch-2026-07-24-multiplier.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 110 | `feature-batch-2026-07-24-powerups.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 111 | `feature-batch-2026-07-24-shop.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 112 | `feature-batch-2026-07-25-ad-unlock.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 113 | `feature-batch-2026-07-25-spectate-chat.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 114 | `feature-batch-2026-07-25-tournament-pushes.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 115 | `feature-batch-2026-07-25-uprising.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 116 | `feature-batch-2026-07-26.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 117 | `feature-batch-2026-07-27.test.js` | **MERGE** | `test/integration/economy/funded-prizes.test.js` | Extract payout-size/coin-unit invariants; delete historical batch wrapper. |
| 118 | `feature-batch-2026-08-09.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 119 | `feature-batch-2026-08-17-contracts.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 120 | `feature-batch-2026-08-25.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Extract Pinecone floor/actual-penalty scoring invariant; move/delete unrelated batch assertions. |
| 121 | `feature-batch-2026-08-28.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 122 | `feature-batch-2026-08-28b.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 123 | `feature-batch-2026-09-06-backend.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 124 | `feature-batch-backend-contract.test.js` | **DELETE** | — | Historical feature-batch acceptance coverage. Any still-relevant contract belongs in unit/HTTP tests, not permanent integration. |
| 125 | `feature-control-cleanup-contract.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 126 | `feature-control-remediation.test.js` | **MOVE** | `test/contracts/` | Admin/config/API contract behavior does not require the default gameplay integration DB suite. |
| 127 | `featured-auto-join.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 128 | `featured-tournament-http.test.js` | **MOVE** | `test/http-and-service/tournaments/` | Bracket/discovery/API behavior can be service/HTTP tested. |
| 129 | `feed-stealth.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 130 | `feedback-a0-advisory-lock.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 131 | `feedback-email-attempt-expiry.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 132 | `feedback-email-contract.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 133 | `feedback-email-delivery.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 134 | `feedback_suggestions.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 135 | `five-minute-step-samples.test.js` | **MERGE** | `test/integration/scoring/step-samples.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 136 | `fixed-powerup-interval.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 137 | `fixed-team-payout-deployment-a.test.js` | **MOVE** | `test/maintenance/migrations/` | Deployment/migration compatibility, not default integration. |
| 138 | `fixed-team-payout-redis.test.js` | **MERGE** | `test/integration/races/settlement.test.js` | Keep settlement invariant; consolidate. |
| 139 | `fixed-team-winner-payouts.test.js` | **MERGE** | `test/integration/economy/buyins-and-payouts.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 140 | `friends.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 141 | `funded-exposure-admission.test.js` | **MERGE** | `test/integration/economy/funded-prizes.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 142 | `funded-prize-pools-tournaments.test.js` | **MERGE** | `test/integration/economy/funded-prizes.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 143 | `funded-prize-pools.test.js` | **MERGE** | `test/integration/economy/funded-prizes.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 144 | `future-dated-sample-wedge.test.js` | **MERGE** | `test/integration/scoring/historical-corrections.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 145 | `global-event-end-burst.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 146 | `global-event-enrollment-candidate-parity.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 147 | `global-event-enrollment-query.test.js` | **MOVE** | `test/performance/` | Scoring performance/cache evidence belongs outside default integration. |
| 148 | `global-event-indexed-recovery.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 149 | `global-event-parent-maintenance.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 150 | `global-event-reliability.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 151 | `global-setup.js` | **MOVE** | `test/support/integration/global-setup.js` | Harness code, not a test. |
| 152 | `global-step-event-races.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 153 | `high_multiplier_push_cap.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 154 | `historical-admission-concurrency.test.js` | **MERGE** | `test/integration/scoring/historical-corrections.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 155 | `historical-discovery-overflow.test.js` | **MERGE** | `test/integration/scoring/historical-corrections.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 156 | `historical-effect-reconciliation-performance.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 157 | `historical-effect-reconciliation.test.js` | **MERGE** | `test/integration/scoring/historical-corrections.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 158 | `historical-raw-redis-unset.test.js` | **MOVE** | `test/performance/` | Scoring performance/cache evidence belongs outside default integration. |
| 159 | `historical-raw-sample-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 160 | `historical-scoring-window-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 161 | `hitchhike-settlement-parity.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 162 | `home-capacity-provider.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 163 | `home-invite-preflight.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 164 | `home-open-capacity-session.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 165 | `home-quick-race-friend-share-cta.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 166 | `home-race-card-modern-standings-bypass.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 167 | `home-screen.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 168 | `home-step-sync-cooldown.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 169 | `home-step-sync-deadlock.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 170 | `home-suggested-races.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 171 | `home-sync-refresh-contract.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 172 | `inbox-read-all.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 173 | `inbox-unread-contract.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 174 | `interstitial-ads.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 175 | `invite-code-onboarding.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 176 | `leaderboard.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 177 | `leaderboardFriendsScope.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 178 | `leech-expiry-boundary.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 179 | `local-global-step-event-entitlements.test.js` | **MERGE** | `test/integration/scoring/global-events.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 180 | `local-global-step-event-schema.test.js` | **MOVE** | `test/contracts/database-schema/` | Schema-default check belongs in migration/schema contracts. |
| 181 | `manual-coin-grant.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 182 | `marketing-site.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 183 | `new-powerups.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 184 | `next-race-cta.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 185 | `night-start-race-buff-scoring.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 186 | `notification-domain-isolation.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 187 | `notification-snapshot-retirement.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 188 | `onboarding-revamp.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 189 | `onboarding.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 190 | `open-bucket-effect-scoring.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 191 | `operational-email-alerts.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 192 | `payout-drop-push-window.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 193 | `payout-rounding-v1.test.js` | **KEEP** | `payout-rounding-v1.test.js` | Small, focused payout arithmetic/persistence invariant. |
| 194 | `performance-query-scaling.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 195 | `performance-targeted-reset.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 196 | `pinned-races-section.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 197 | `placement-performance-cron.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 198 | `placement-recompute-efficiency.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 199 | `pocket-watch-store-move.test.js` | **MOVE** | `test/http-and-service/powerup-catalog/` | Store/catalog publication behavior; not scoring integration. |
| 200 | `pocketwatch-ghost-pepper-probe.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 201 | `pool-telemetry-redis.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 202 | `position-aware-drops.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 203 | `postgresql-coordinated-optimization-public-pipeline.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 204 | `power-outage-2000.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 205 | `powerup-activation-clarity-invariants.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 206 | `powerup-attack-push-durations.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 207 | `powerup-character-batch-2026-07-25.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Extract enduring domain invariant, then remove date/batch-owned file. |
| 208 | `powerup-cooldown-scope.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 209 | `powerup-lock-cost.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 210 | `powerup-lock-fence-compat.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 211 | `powerup-participant-locks.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 212 | `powerup-performance-deterministic-http.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 213 | `powerup-reroll-batch.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 214 | `powerup-shared-guard-cost.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 215 | `powerup-shared-race-guards.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 216 | `powerup-shop-admin.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 217 | `powerup-usage-state-atomicity.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 218 | `powerups-batch-leech-xray.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 219 | `powerups-bounty-not-cleansable.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 220 | `powerups-campfire-runners-high.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 221 | `powerups-cleanse-legcramp.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 222 | `powerups-compression-socks.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 223 | `powerups-cramp-wrongturn-conflict.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 224 | `powerups-detour-sign.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 225 | `powerups-dual-shield.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 226 | `powerups-fanny-pack.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 227 | `powerups-ghost-pepper-no-stack.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 228 | `powerups-hitchhike-quick-rinse.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 229 | `powerups-leg-cramp-late-admission.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 230 | `powerups-leg-cramp.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 231 | `powerups-protein-shake.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 232 | `powerups-rainstorm-late-admission.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 233 | `powerups-rally-flag-not-cleansable.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 234 | `powerups-red-card.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 235 | `powerups-reflected-attack-socks.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 236 | `powerups-runners-high.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 237 | `powerups-second-wind.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 238 | `powerups-shop-defenses.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 239 | `powerups-shortcut-mirror.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 240 | `powerups-shortcut.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 241 | `powerups-signal-jammer.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 242 | `powerups-stealth-mode.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 243 | `powerups-stealth-push-anonymity.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 244 | `powerups-stealth-redcard.test.js` | **MERGE** | `test/integration/powerups/defensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 245 | `powerups-trail-mine.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 246 | `powerups-trail-mix.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 247 | `powerups-upgrades.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 248 | `powerups-wrong-turn.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 249 | `powerups.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 250 | `powerups5-wave.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 251 | `premium-powerups.test.js` | **MERGE** | `test/integration/powerups/buffs-stacking-and-conflicts.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 252 | `prepared-read-worker.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 253 | `prepared-worker-queries.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 254 | `profile-photo.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 255 | `public-join-box-window.test.js` | **MERGE** | `test/integration/powerups/boxes-and-inventory.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 256 | `public-profile.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 257 | `query-efficiency-active-event-indexed.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 258 | `query-efficiency-active-event.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 259 | `query-efficiency-empty-claims.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 260 | `query-efficiency-empty-samples.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 261 | `query-efficiency-enrollment.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 262 | `query-efficiency-event-history.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 263 | `query-efficiency-fingerprint-rows.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 264 | `query-efficiency-notification-experiment.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 265 | `query-efficiency-notification-parent.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 266 | `query-efficiency-post-task.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 267 | `query-efficiency-resolution.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 268 | `query-efficiency-scoring-lock.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 269 | `query-efficiency-standings.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 270 | `query-efficiency-suggestions.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 271 | `quicksand-gold-shop-publication.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 272 | `quicksand-powerup.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 273 | `race-authorization-projection-prototype.test.js` | **MOVE** | `test/http-and-service/auth/` | Auth/account lifecycle is important but does not need the default gameplay integration suite. |
| 274 | `race-bootstrap-performance.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 275 | `race-bootstrap-persisted-standings.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 276 | `race-bootstrap-refresh-coalescing.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 277 | `race-buyins.test.js` | **MERGE** | `test/integration/economy/buyins-and-payouts.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 278 | `race-deadline-scheduler-work.test.js` | **MERGE** | `test/integration/queue/retry-recovery.test.js` | Critical retry/reclaim/failure convergence invariant. |
| 279 | `race-dependency-closure-planner.test.js` | **MOVE** | `test/services/race-resolution/` | Planner algorithm should be service-level; integration only needs final scoring parity. |
| 280 | `race-details-participants-paging.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 281 | `race-display-boundary-proof.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 282 | `race-effect-deadlines.test.js` | **MERGE** | `test/integration/powerups/effect-expiry.test.js` | Keep effect timing/consequence correctness. |
| 283 | `race-effect-expiry-cache.test.js` | **MOVE** | `test/reliability/effects/` | Effect infrastructure/publication/performance is not default gameplay integration. |
| 284 | `race-effect-expiry-indexes.test.js` | **MOVE** | `test/contracts/database-schema/` | Index existence is a schema/migration contract. |
| 285 | `race-effect-expiry-load.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 286 | `race-effect-expiry-publication.test.js` | **MOVE** | `test/reliability/effects/` | Effect infrastructure/publication/performance is not default gameplay integration. |
| 287 | `race-ending-soon-skips-seeded.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 288 | `race-experience-identity-api.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 289 | `race-experience-identity-schema.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 290 | `race-experience-invites-autofriend.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 291 | `race-finish-reward.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 292 | `race-invite-expiry.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 293 | `race-leave-capability.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 294 | `race-list-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 295 | `race-list-viewer-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 296 | `race-open-cache-transitions.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 297 | `race-open-display-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 298 | `race-open-viewer-cache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 299 | `race-payout-double.test.js` | **MERGE** | `test/integration/economy/buyins-and-payouts.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 300 | `race-placement-timezone.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 301 | `race-placement-transition-worker.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 302 | `race-powerup-placement-performance.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 303 | `race-preview-before-join.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 304 | `race-queue-v2-closure-parity.test.js` | **MERGE** | `test/integration/queue/race-dirty-and-resolution.test.js` | Keep end-to-end resolution correctness, remove old transport-specific structure. |
| 305 | `race-queue-v2-closure-scaling.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 306 | `race-queue-v2-closure-shadow.test.js` | **DELETE** | — | Old rollout/implementation-specific evidence; no enduring behavior to keep in default suite. |
| 307 | `race-queue-v2-enqueue-lock-order.test.js` | **MERGE** | `test/integration/queue/race-single-writer.test.js` | Critical real-DB concurrency/fencing invariant. |
| 308 | `race-queue-v2-enqueue-scope-guard.test.js` | **MERGE** | `test/integration/queue/race-dirty-and-resolution.test.js` | Keep end-to-end resolution correctness, remove old transport-specific structure. |
| 309 | `race-queue-v2-settlement-parity.test.js` | **MERGE** | `test/integration/races/settlement.test.js` | Keep settlement parity, remove old queue naming. |
| 310 | `race-queue-v2-single-writer.test.js` | **MERGE** | `test/integration/queue/race-single-writer.test.js` | Critical real-DB concurrency/fencing invariant. |
| 311 | `race-resolution-boundary-provenance.test.js` | **MERGE** | `test/integration/queue/retry-recovery.test.js` | Critical retry/reclaim/failure convergence invariant. |
| 312 | `race-resolution-configured-concurrency.test.js` | **MOVE** | `test/performance/` | Concurrency sizing/planning/memory evidence belongs in performance. |
| 313 | `race-resolution-five-concurrency.test.js` | **MOVE** | `test/performance/` | Concurrency sizing/planning/memory evidence belongs in performance. |
| 314 | `race-resolution-memory-profile.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 315 | `race-resolution-memory-reuse.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 316 | `race-resolution-pending-scope.test.js` | **MERGE** | `test/integration/queue/retry-recovery.test.js` | Critical retry/reclaim/failure convergence invariant. |
| 317 | `race-resolution-planning-input-reuse.test.js` | **MOVE** | `test/performance/` | Concurrency sizing/planning/memory evidence belongs in performance. |
| 318 | `race-resolution-post-task-storage.test.js` | **MOVE** | `test/reliability/events/` | Post-task durability belongs in reliability, not core scoring integration. |
| 319 | `race-resolution-spawned-worker-scale.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 320 | `race-resolution-unused-history.test.js` | **DELETE** | — | Old rollout/implementation-specific evidence; no enduring behavior to keep in default suite. |
| 321 | `race-source-singleflight.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 322 | `race-timeline-options.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 323 | `raceListSync.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 324 | `raceResolutionLock.test.js` | **MERGE** | `test/integration/queue/race-single-writer.test.js` | Critical real-DB concurrency/fencing invariant. |
| 325 | `races-my-active-effects.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 326 | `races-tab-open-capacity-session.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 327 | `races.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 328 | `ranked.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 329 | `read-only-race-progress.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 330 | `recap-cutover-operator-database.test.js` | **MOVE** | `test/maintenance/cutovers/` | Operator/cutover verification should be isolated from product integration. |
| 331 | `receipt-cleanup-backup-receiver.test.js` | **MOVE** | `test/reliability/events/` | Outbox/receipt/recovery infrastructure belongs in a dedicated reliability suite. |
| 332 | `red-card-cap.test.js` | **MERGE** | `test/integration/powerups/offensive.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 333 | `redis-cache-c1-catalogs.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 334 | `redis-cache-c2-chat.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 335 | `redis-cache-c3-standings.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 336 | `redis-cache-c4-user-bits.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 337 | `redis-cache-c5-authme.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 338 | `redis-cache-efficiency-readers.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 339 | `redis-cache-efficiency-writers.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 340 | `redis-social-http-fallbacks.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 341 | `redis-social-reads.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 342 | `redisCache.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 343 | `redisCacheWatch.test.js` | **MOVE** | `test/reliability/cache/` | Cache/Redis resilience is useful but not core gameplay correctness. |
| 344 | `redisTestServer.js` | **MOVE** | `test/support/redisTestServer.js` | Harness code, not a test. |
| 345 | `referral-contest-global-experience.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 346 | `referral-contest-joined-dashboard.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 347 | `referral-giveaway-hardening.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 348 | `referral-giveaway-workflow.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 349 | `referral-hitchhike-activity-fixes.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 350 | `referral_attribution_fallback.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 351 | `referral_reward_flow.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 352 | `remote-assets.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 353 | `rename-chip-state.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 354 | `resolved-impact-events-v2.test.js` | **MERGE** | `test/integration/powerups/effect-expiry.test.js` | Keep effect timing/consequence correctness. |
| 355 | `rewarded-gold.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 356 | `scheduled-race-late-start.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 357 | `seeded-account-deletion.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 358 | `seeded-automatic-eligibility.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 359 | `seeded-bucket-election-ordering.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 360 | `seeded-challenge-payouts-inactivity.test.js` | **MERGE** | `test/integration/races/settlement.test.js` | Keep settlement invariant; consolidate. |
| 361 | `seeded-current-join.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 362 | `seeded-early-preparation.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 363 | `seeded-join-scoring.test.js` | **MERGE** | `test/integration/scoring/step-samples.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 364 | `seeded-join-version-skew.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 365 | `seeded-race-buckets.test.js` | **MERGE** | `test/integration/races/lifecycle.test.js` | Keep transactionally important start/join/leave/finish behavior only. |
| 366 | `seeded-race-prereg.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 367 | `seeded-race-window-modes.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 368 | `seeded-signup-recovery.test.js` | **MOVE** | `test/http-and-service/races/` | Seeded scheduling/discovery/compat behavior is not core default integration. |
| 369 | `setup.js` | **MOVE** | `test/support/integration/setup.js` | Harness code, not a test. |
| 370 | `share.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 371 | `shop.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |
| 372 | `simple-event-recap.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 373 | `snapshot-success-indexes.test.js` | **MOVE** | `test/contracts/database-schema/` | Index existence is a schema/migration contract. |
| 374 | `social-rewards.test.js` | **MOVE** | `test/http-and-service/economy/` | Feature reward/HTTP behavior can be service/contract tested; not core settlement integration. |
| 375 | `step-admission-pool.test.js` | **MOVE** | `test/unit-or-service-review/` | No clear need for real DB gameplay integration; relocate after focused review. |
| 376 | `step-intake-bounded-history.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 377 | `step-intake-legacy-contract.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 378 | `step-milestone-reminder.test.js` | **MOVE** | `test/reliability/notifications/` | Notification delivery/retry/copy belongs in a dedicated reliability suite. |
| 379 | `step-pool-telemetry.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 380 | `step-sample-bucket-flag.test.js` | **MERGE** | `test/integration/scoring/step-samples.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 381 | `step-sample-leech-granularity.test.js` | **MERGE** | `test/integration/powerups/transfer-and-copy.test.js` | Keep durable gameplay outcome; consolidate narrow per-powerup files. |
| 382 | `step-sample-retention-cron.test.js` | **MERGE** | `test/integration/scoring/step-samples.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 383 | `step-samples-source-validation.test.js` | **MERGE** | `test/integration/scoring/step-samples.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 384 | `step-sync-large-race-batch.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 385 | `step-sync-performance-service.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 386 | `stepSyncV2.test.js` | **MERGE** | `test/integration/queue/step-sync-pipeline.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 387 | `summary-notification-cpu.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 388 | `team-only-drop-pool.test.js` | **MERGE** | `test/integration/economy/buyins-and-payouts.test.js` | Money-like state, holds, payout and exactly-once settlement deserve real DB coverage. |
| 389 | `team-pool-multiplier.test.js` | **MERGE** | `test/integration/scoring/team-scoring.test.js` | Keep canonical source/scoring behavior against real DB state. |
| 390 | `team-race-read-performance.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 391 | `team-races-10v10-discovery.test.js` | **MOVE** | `test/http-and-service/races/` | Not a core transactional team-race invariant. |
| 392 | `team-races-10v10-load.test.js` | **MOVE** | `test/performance/` | Performance/query-budget evidence should run separately from correctness integration. |
| 393 | `team-races-10v10-resize-race.test.js` | **MOVE** | `test/http-and-service/races/` | Not a core transactional team-race invariant. |
| 394 | `team-races-10v10-settlement.test.js` | **KEEP** | `team-races-10v10-settlement.test.js` | Small, focused team-settlement integration invariant. |
| 395 | `team-races-10v10.test.js` | **MERGE** | `test/integration/races/team-lifecycle.test.js` | Keep create/join/team scoring lifecycle; consolidate. |
| 396 | `team-races.test.js` | **MERGE** | `test/integration/races/team-lifecycle.test.js` | Keep create/join/team scoring lifecycle; consolidate. |
| 397 | `tournament-current-match.test.js` | **MOVE** | `test/http-and-service/tournaments/` | Bracket/discovery/API behavior can be service/HTTP tested. |
| 398 | `tournament-lifecycle-commands.test.js` | **MERGE** | `test/integration/races/settlement.test.js` | Extract one real tournament settlement/advancement invariant. |
| 399 | `tournaments.test.js` | **MERGE** | `test/integration/races/settlement.test.js` | Keep one real bracket happy-path through advancement/champion/ledger; move route/config detail out. |
| 400 | `trail-mine-visibility.test.js` | **MOVE** | `test/http-and-service/powerups/` | Powerup presentation/catalog/delivery contract, not scoring behavior. |
| 401 | `weekly-race-page-projection.test.js` | **MOVE** | `test/http-and-service/` | Product API/read-model/UI-support behavior does not belong in the lean gameplay integration suite. |

## Cleanup order

1. Create the canonical lean integration files above.
2. For every **MERGE** file, copy only the enduring behavioral assertion into the canonical destination and remove duplicated setup/transport/rollout checks.
3. Move **performance**, **reliability**, **contracts**, **maintenance**, and **HTTP/service** files out of `test/integration`.
4. Delete **DELETE** files only after confirming any unique enduring invariant has already been extracted.
5. Move harness files into `test/support`.
6. Change `npm run test:integration` so it runs only the lean `test/integration` tree.
7. Add separate commands such as `test:performance`, `test:reliability`, and `test:contracts`.
8. After the move, run each suite independently and remove duplicated tests that assert the same durable outcome.

## Important principle

Integration tests should prove behavior that unit/service tests cannot reliably prove: real Postgres state transitions, scoring/effect correctness, transactional money state, idempotency, single-writer fencing, crash/retry convergence, and a very small number of lifecycle settlement paths.

Everything else should be cheaper and more targeted.
