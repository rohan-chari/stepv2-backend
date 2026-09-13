# Deadline discovery validation

Baseline `6c5fd10cc2bd27d109a2b2a5bc67cae36032553f`; isolated local PostgreSQL 18 test databases and Redis database 15. No production or staging access. Results are local functional/query evidence, not production CPU savings.

- Tests first: three new discovery assertions failed before implementation; the existing expiry behavior case passed.
- Five scheduler ownership/control tests pass: serialized passes/recovery, bounded wake coalescing, retry, cancellation and awaited shutdown.
- Eight real database/HTTP/subprocess integrations pass with Redis, and all eight pass with Redis unset. Coverage includes the default one-second timer, refresh-only and repair-only work, current and older HTTP contracts, revision changes after dispatch, and saturation beyond 1,000 deferred races.
- The Redis burst test holds a real database lock, observes exactly one blocked discovery while all 1,001 wake messages arrive, then runs real resolution/post-task workers to published expiry. It checks subsequent idle stability and no SQL after shutdown. No private dispatch helper substitutes for the durable worker path.
- Ten alternating idle benchmark pairs each measure 60 passes. Baseline executes 180 database commands; candidate executes 60. Median of run medians: 0.3688125 ms to 0.268396 ms. Median of run p95s: 0.549021 ms to 0.4231875 ms. Raw runs are beside this document; these warm, idle measurements do not establish loaded throughput.

Seven failures in older adjacent integration suites also reproduce on the pristine baseline using a separate local test database: three missing snapshot-publication tasks (completed, cancelled, pending historical), delayed older snapshot write not starting, compression-socks expiry score assertion, and two existing bounded expiry-load drain timeouts (48 effects/12 races and 100 effects/one race). These remain unresolved baseline failures, so the broad suite is not green. The load test's discovery-query matcher was mechanically updated for the combined SQL; its index-plan assertion passes and its two drain failures remain unchanged.

Local execution logs: `/tmp/bara-deadline-red.log`, `/tmp/bara-deadline-final-control.log`, `/tmp/bara-deadline-final-redis.log`, `/tmp/bara-deadline-unset-green.log`, `/tmp/bara-deadline-baseline-regressions.log`, `/tmp/bara-deadline-load-rerun.log`. Logs are ephemeral; this record and benchmark JSON are the retained evidence.

## Loaded replay method

The exploratory `loaded-*` files are **not acceptance evidence**. Review identified that their workers stopped after expiry before proving publication had drained, and that sync/dispatch/worker phases were sequential. That run was stopped. Its raw results remain to avoid presenting abandoned measurements as validated results.

The replacement `mixed-*` replay overlaps real HTTP sync with the default scheduled deadline, resolution and publication workers, including startup recovery explicitly. Four concurrent HTTP requests provide bounded input pressure. A local-only audit trigger records dispatch timestamps before normal deadline cleanup; it adds identical measurement writes in both variants and is removed at completion. Application SQL counters exclude observer/setup commands and do not count nested trigger statements.

Before workers stop or verification HTTP reads begin, all ten races must have current-generation successful snapshot task/receipt evidence, successful committed resolution jobs, zero queued/running post-tasks, zero refresh intents and zero nonterminal repair intents. Every participant then receives both old/current HTTP responses asserting 100 steps, three slots and no active effects. Review approved this revised measurement method; acceptance depends on the completed paired results below.

### First ten mixed pairs

All 20 runs passed functional and publication assertions. Median of per-run dispatch p95 was 100 ms baseline versus 106.5 ms candidate (+6.5%); median of per-run p50 was 76 versus 83.5 ms. Six of ten paired p95 comparisons increased more than 5%. This exceeds the nominal latency limit and is **not recorded as acceptance**. Other implementation tests were using the shared database cluster, so a further fixed ten-pair run with those tests paused checks repeatability. Both datasets are retained.

### 1,000-user replay

Both variants passed with 1,000 distinct users, ten races, 1,000 public activations and concurrent sync plus scheduled worker processing. Each verified 2,000 old/current HTTP responses after all ten current-generation publications succeeded. Remaining resolution jobs, queued/running post-tasks, refresh and nonterminal repair counts were all zero before HTTP verification.

The single baseline/candidate pair measured dispatch p95 274/234 ms and sync-burst elapsed 6,043/6,628 ms. Observed application commands were 132,177/130,215 including verification reads. These are one-pair observations, not a statistical throughput or latency claim, and do not erase the smaller-fixture regression above. Raw `mixed-1000-*.json` files preserve phase counts and measurement limitations. Counts cover the scheduled resolution/publication paths exercised here, not every independent application consumer or nested PostgreSQL trigger command.

### Controlled ten-pair repeat

All other implementation database tests were paused; no other client sessions were active before the run. Unrelated idle host processes were left untouched, so this is a controlled database-work replay, not an exclusively reserved host.

All 20 runs again passed every functional, publication and queue-drain assertion. Median of per-run dispatch p95 was **103.5 ms baseline versus 101.5 ms candidate** (−1.93%); median of per-run p50 was 76.5 versus 76 ms. Only two paired p95 comparisons exceeded +5%, with individual results varying in both directions. The first run's +6.5% increase did not reproduce with competing database tests paused. This meets the requirement of no repeatable p95 regression above 5% for this fixture; it does not establish a production latency improvement.

Raw repeat results are in `controlled/mixed-paired-summary.json` and its individual files. No scheduling policy or implementation was altered to obtain the second result. Both runs remain part of the record. Median total application commands, including HTTP verification, were 13,529 versus 13,400.5; that small whole-replay difference is separate from the deterministic 3→1 idle-discovery reduction.

Final review found no production or benchmark blockers after the stronger lifecycle, burst, telemetry, publication and concurrent-work checks were added. No production deployment or measurement occurred.
