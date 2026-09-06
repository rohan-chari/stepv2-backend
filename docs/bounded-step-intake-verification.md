# Bounded step intake

## Scope and contract

Normal intake through `/steps`, `/steps/samples`, and `/steps/sync-v2` must not
hydrate a user's retained sample history merely to decide whether scoring changed.
Reconciliation compares the scoring fields of the affected replacement rows;
metadata-only changes remain scoring no-ops. Indexed first/last `period_end`
lookups preserve future-boundary discovery and capture coverage, including when
the latest endpoint moves backward. No scoring rules or HTTP contracts change.

The existing per-user transaction fence still atomically covers daily/sample
writes, scoring generation, and durable race-queue ownership. Boundary expiry and
missing queue ownership still force the necessary work. Out-of-band version
bumps, including retention and App Review SQL writers, invalidate the fast path.

The new 64-character `v2:` fingerprint is an explicit **revision identifier**,
not a hash of sample contents. Legacy hashes transition conservatively once.
Old and new server workers can coexist: an old worker's content hash invalidates
the new fast path, causing conservative extra work, not dropped work. Existing
Hitchhike capture fingerprints remain immutable opaque provenance. No migration,
new queue, release flag, app update, or production capacity change is required.

For H retained samples and K affected samples, the new boundary lookups use the
existing `(user_id, period_end)` index rather than returning O(H) history rows.
This does not make all intake constant-time: overlap reconciliation still scales
with incoming/overlapping windows, and race discovery/enqueue with active races.
Other race-scoring history reads are outside this change.

## Evidence

- TDD: changed, identical, metadata-only, and daily-only HTTP tests fail on the
  deployed `ed4e78b` baseline because each loads 513 retained sample rows.
- The new integration suite has 17 cases, using real HTTP and dedicated local
  PostgreSQL. It additionally covers legacy transition, queue repair, concurrent
  corrections, interval changes with equal step totals, coarse rejection,
  decreasing coverage, retention, empty history, and actual future boundaries.
- Its plan assertion runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the exact
  bounds SQL observed during HTTP intake. A multi-user fixture and fresh table
  statistics produce two limited index scans with no sort; no index is forced.
- The operational SQL scripts have no HTTP entrypoint. Their exact revision
  fences are executed against PostgreSQL before simulated raw source changes,
  followed by real HTTP intake to verify invalidation and durable queue repair.
  This does not claim to validate every unrelated demo-seed statement.
- Legacy endpoint, five-minute reconciliation, sync-v2, large-race queue,
  durable capture/reuse, and Hitchhike settlement regression suites are included
  in the release verification. Tests use serial execution on the shared test DB.

Run only after verifying `DATABASE_URL` points to the dedicated test database:

```sh
NODE_ENV=test node --test --test-concurrency=1 --test-force-exit \
  test/integration/step-intake-bounded-history.test.js \
  test/integration/step-intake-legacy-contract.test.js \
  test/integration/step-sample-retention-cron.test.js \
  test/integration/stepSyncV2.test.js \
  test/integration/five-minute-step-samples.test.js \
  test/integration/step-sync-large-race-batch.test.js \
  test/integration/durable-global-event-capture.test.js \
  test/integration/hitchhike-settlement-parity.test.js \
  test/integration/durable-capture-facts-foundation.test.js \
  test/integration/global-event-capture-fact-reuse.test.js \
  test/integration/durable-capture-interval-reuse.test.js \
  test/integration/durable-directed-capture.test.js \
  test/integration/durable-capture-root-budget.test.js \
  test/integration/durable-stage-capture.test.js
```

## Existing verification debt

The dirty-worktree full unit run passed 3,332/3,343 tests. Five failures also
reproduce on clean `ed4e78b`: balance-config inventory, notification scheduler
structure, two local-entitlement mock contracts, and race-list opportunity
batching. Six additional failures concern unrelated uncommitted capacity work:
race-write inventory and five runtime-control-manifest checks. None is hidden,
skipped, or weakened for this release; this is not a claim of a green full suite.

Production deployment requires fresh explicit approval. After deployment,
compare clean query-statistics intervals: the intake `WITH decision_clock`
history query should disappear from normal intake, replaced by bounded index
lookups. Confirm accepted syncs, no new errors, queue progress, and completed
global-event captures. Local integration tests do not predict production CPU
percentage or certify production throughput.
