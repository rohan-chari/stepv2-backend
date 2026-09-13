# Admin analytics snapshots and purchase usernames — implementation evidence

No production database, production Redis, staging service, deployment, or app-store operation was used. All fixtures are synthetic. The feature's API contract remains the approved frontend requirements contract.

## Behavior and compatibility

- `/admin/stats` retains legacy and dashboard sections, validation and authorization. Completed results add optional `stats.snapshot`; disabled dashboard envelopes retain their exact original shape. The calculation timestamp stays fixed across cache reads, and a lazy section reusing an older relational artifact conservatively uses that artifact's calculation timestamp.
- A Redis lease serializes analytics globally across Node workers and section keys. Freshness is 15 minutes; bounded stale reads require the same authoritative configuration and ET date. Cold waits stop at 20 seconds with the specified 503 and `Retry-After: 15`. Builds stop at 45 seconds; renewal is token checked, and publication/release cannot steal another owner's lease. Failures back off for 60 seconds for that configuration.
- Configuration identity uses an authoritative, bounded read-only transaction. This works with transaction-pooled PgBouncer: all timeout settings use `SET LOCAL` inside transactions. Individual and atomic settings changes invalidate local/peer snapshots; epoch and coverage changes also change the authoritative cache identity. Redis failure cannot initiate uncached analytics.
- The owner borrows one existing pool connection. Extraction uses serial keyset pages, a read-only repeatable-read transaction, 2,000-row pages, 200,000 rows and 32 MiB ceilings, five-second statements and a 15-second extraction deadline. The DB-free CPU worker runs after extraction commit with a 256 MiB old-generation limit. Cancellation aborts queued section queries before rollback/releasing the connection; already-running SQL may drain under its five-second timeout.
- Shared Redis artifacts contain aggregates for all three windows, not raw user maps. Coverage, foreground distinct counts, signup retention and historical first-race retention use exact sets/maps. Detailed sections remain lazy. The DAU query now computes distinct union users independently of daily action aggregates. Engagement groups event/ledger/claim data once instead of rescanning for every date.
- `/admin/purchases` returns bounded, signed-cursor pages, default 20 / maximum 50 and a fixed trailing 30-day anchor. Each source fetches at most limit+1 records, with no count/OFFSET or per-user query. Billing, shop, powerup, paid upgrade and coin reroll records use current public usernames and recorded provenance. No cash prices, historical ownership reconstruction, subscription-state duplicate sales, or credit-reroll coin charges are invented. Trial/unpaid/refunded/deleted identities remain explicit.

## Measured local benchmark

Reproduce with `scripts/perf/admin-analytics-snapshots.cjs`, setting `DATABASE_URL` to a loopback `*_test` database, `ADMIN_EMAILS=admin@test.com`, and a test-only `SESSION_TOKEN_SECRET`. The harness rejects nonlocal/non-test DBs, starts its own ephemeral Redis, verifies fixture cardinalities and writes `docs/evidence/admin-analytics-snapshots/benchmark.json`.

The fixture includes 1,530 users, 2,033 races, 35,605 participants, 10,747 activity-day records, 962,021 activation events and 468,560 powerup events. Each purchase source has 20,000 synthetic rows. These approximate researched production cardinalities; distributions are synthetic and are not a production CPU measurement.

Latest single-run comparison across all ten 30-day dashboard sections:

| Path | Measured SELECT time | Analytics SELECTs | Returned data |
| --- | ---: | ---: | ---: |
| Original SQL at HEAD | 7,646 ms | 34 | 355 rows / 61 KB |
| Corrected SQL with exact-query reuse in memory | 3,861 ms | 22 | 343 rows / 53 KB |
| Hybrid snapshots | 3,867 ms | 46 including extraction pages | About 50,126 rows / 7.87 MB including config reads |

Hybrid total database command time was 3,882 ms across 170 SQL commands, including configuration reads and transaction/timeout commands. This explicitly distinguishes command count from analytics SELECT count: bounded paged extraction increases round trips and bytes versus aggregate SQL. The optimized shared-SQL candidate is approximately equal to hybrid SELECT time on this dataset; this evidence does **not** show that moving every calculation to memory is universally cheaper. Both candidates materially reduce the original rebuild's database work, especially the removed date-by-date scans. No claims about measured production CPU are made.

The full sequence of ten cold/lazy HTTP section reads took 5,086 ms, including coordination polling and configuration/authentication overhead. The first summary took 699 ms. A warmed summary took 3.00 ms and executed **zero analytics SQL queries**. Fresh cache hits still perform small authoritative configuration/authentication reads.

One shared extraction read 49,915 rows / 7.82 MB in 211 ms. The worker calculated its summaries in 236 ms and reported 28.1 MB heap usage at completion. The harness sampled whole-process RSS every 20 ms: 181 MB before hybrid work, 409 MB observed peak including the worker. This is an observed process-memory sample, **not** a measured worker heap peak or a production capacity guarantee. Extraction and worker usage remain inside the declared protective limits.

`before-indexes.json` and `benchmark.json` retain full purchase EXPLAIN plans. Before the new indexes, the billing/shop/powerup top-21 reads scanned 20,000-row tables and used 525–588 shared blocks plus a sort. Afterward they use index-only scans reading 3–4 blocks for 21 rows. The paid-ledger query goes from 86 blocks plus sorting to three blocks. These plans justify four narrowly scoped timestamp/id indexes; timings vary with local filesystem cache state.

## Tests and checks

Initial failing HTTP tests were written and run before implementation (missing snapshot metadata and purchase endpoint 404). The dedicated database is `admin_snapshots_test`; the repository's default integration database already had an unrelated failed migration and was not repaired or reused.

The new real-HTTP suite has 17 cases, including:

- Concurrent requests across independent Node HTTP processes and shared real Redis, one global extraction, shared lazy artifacts and zero warm analytics queries.
- Fresh/stale timestamps, disabled and atomic telemetry/epoch/coverage generations, real Redis outage, ET-day rollover, 24-hour expiry and cold fail-closed responses.
- Stolen-token publication rejection, real PostgreSQL statement timeout and shared failure backoff, recovery after generation change, and 200,001 activity rows rejected before CPU/section work instead of truncated counts.
- Exact DAU union/denominator/event counts, both spring/fall ET midnight boundaries, authentication/authorization, all billing categories, refunds/trials, current renamed/deleted usernames, free/ad-assisted/unknown/no-op acquisitions, distinct upgrade/reroll ledger records, mixed-source and microsecond cursor ties, pagination validation, and empty historical purchase metadata remaining unknown instead of invented free/paid provenance.

Existing DAU (6), dashboard block (24), dashboard contract (17), and telemetry (27) integration suites also pass. The combined pre-edge-case regression passed 63/63; the final expanded purchase/snapshot suite passed 17/17 after its malformed-provenance regression was first observed failing. Together, the distinct targeted integration cases total **91 passing tests** (17 new + 6 DAU + 24 blocks + 17 contract + 27 telemetry). The root compatibility audit documents unrelated historical failures. `test/queries/adminEngagementScanBound.test.js` is a structural performance guard: identical HTTP values cannot reveal repeated internal table scans, so it checks that large event/ledger/claim sources are each read once. Existing endpoint fixtures remain the behavior/parity proof.

Two existing expectations intentionally changed with the approved contract and were surfaced before editing: the old cold-Redis-failure expectation required uncached PostgreSQL rebuilds; it now verifies retained completed results and cold 503. The obsolete `NO_IAP_PRODUCT` description now expects `HISTORICAL_CASH_AMOUNTS_UNAVAILABLE` plus `purchaseHistoryAvailable: true`. The exact legacy key assertion adds `snapshot` without removing any existing key. Other existing assertions were preserved. Broader historical test failures are reported separately by the root audit rather than weakened.

## Migration and deployment review

Migration `20260913190000_admin_purchase_history_indexes` contains four additive `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statements. No columns, product policy, purchase fulfillment behavior or historical prices change. Index names are:

- `billing_purchases_admin_history_idx`
- `shop_purchase_requests_admin_history_idx`
- `powerup_purchase_requests_admin_history_idx`
- `coin_transactions_admin_history_idx`

The latter three use predicates limiting indexed rows to eligible purchase history. C-collated IDs match cursor tie ordering. Prisma schema comments identify the manually maintained collation/predicate indexes. The migration was applied only to dedicated local test databases; all four indexes were verified valid and ready. **The ordinary `npx prisma migrate deploy` command applied the complete four-statement migration file successfully**, first on `admin_snapshots_benchmark_test` and then through the standard integration runner on `admin_snapshots_test`. No manual statement splitting, `migrate resolve`, or custom deployment path was used. `_prisma_migrations` reports the migration finished with no rollback. This rehearses the repository's normal migration method and verifies that the configured Prisma engine does not wrap this file in a transaction.

A deployment must run these concurrent index statements outside a wrapping transaction, check `pg_index.indisvalid` / `indisready`, then restart the existing two production workers. If a concurrent index build is interrupted, inspect and remove/rebuild only its invalid index before retrying; `IF NOT EXISTS` does not repair invalid indexes. Backend deploy precedes a carrying app release. Production deployment still requires the user's explicit in-the-moment approval.
