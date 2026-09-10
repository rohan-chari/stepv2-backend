# Database CPU implementation: A/B/C

Implementation baseline: `de7e8955708b0256ea67beb14d1fa2855a064a43`. API contract remains specification §12 verbatim: existing request/response fields, status/error codes, scoring, generation fences, notification semantics and legacy client headers are unchanged. No production/staging operations, provider changes or statistics resets were performed.

The [source manifest](evidence/cpu-remediation-backend/source-manifest.json) pins every A/B/C changed production source and the additive migration. The experiments use PostgreSQL18.4, transaction-mode PgBouncer, eight pool backends, existing128-name admission, local synthetic `_test` databases and the existing adapter. The complete before/after observations are in [evidence](evidence/cpu-remediation-backend/). Timings are local elapsed query/service measurements, not per-query production CPU shares or achieved whole-host savings.

## A: display boundary

The original SQL now begins exactly with the existing prepared-read annotation. The predicates, two entitlement traversals, strict scored-at comparison and generation/effect/race-end checks are otherwise unchanged.

A public HTTP upload, actual resolution subprocess and public progress response established a passing30-test baseline across boundary proofs, compaction cadence and post-task storage. The added protocol regression failed before the annotation: the actual boundary query had no name. It also captures the worker's readiness/completion SQL for C. Existing proof tests cover pending entitlement starts, legacy ends, intra-effect boundaries, crossed boundaries, changed generation and delayed publication.

Three matched repetitions per distribution alternated110 unnamed/named executions; the first10 were warmup, the remaining100 produced latency statistics. Every owned session showed105 generic and5 custom executions after reconnecting the owned transaction pool. Result rows matched on every pair.

| Boundary population | Baseline warm median | Prepared warm median | Reduction |
| --- | ---: | ---: | ---: |
| One member, no event rows |0.60ms |0.13ms |78% |
|32 members,128 entitlements |0.71ms |0.17ms |76% |
|256 members,10,240 entitlement history rows |1.92ms |1.27ms |34% |

Every measured preparation p95 improved. [Full measurements](evidence/cpu-remediation-backend/a-preparation-experiment.json).

The separately benchmarked single-entitlement-traversal/LATERAL VALUES rewrite was **rejected**. With dense history its already-prepared median rose from about1.24ms to2.21ms and p95 from1.32–1.38ms to2.33–2.49ms. Empty/ordinary cases did not provide a material win. It therefore fails the specification's10% p95 gate and is not in application code. [Rejected experiment](evidence/cpu-remediation-backend/a-traversal-experiment.json).

## B: root maintenance

Migration `20260910010000_capture_root_readonly_sweep` adds one singleton UUID sweep cursor and replaces functions additively. Scheduled calls read at most128 root IDs per page, advance past retained roots without updating them, and propagate the cursor deadline through the existing outer schedule. A full page continues in one second; wrap pauses for a minute. Pin exclusion, irreversible eviction identity, journal tail/watermarks,30-day provenance and child/root delete bounds remain intact.

The existing SQL signatures remain wrappers. Forced old callers retain oldest-root behavior through an extra bounded age-index prepass. It consumes the transition budget first; the UUID page can transition only the remaining slots. Direct calls inspect at most2×limit IDs but transition at mostlimit roots; scheduled callers do not pay for the prepass. A protected `compact(1)` test exposed this compatibility requirement. A new opposite-age/UUID regression then exposed a priority tie in the first prepass design; it failed before the shared transition budget correction. Architect review approved the final refinement. The outer-schedule→advisory→sweep→root/head lock order is unchanged; direct calls never take the outer schedule row.

The guarded migration was applied only to disposable databases. It uses a5-second migration lock timeout, creates state before replacing functions, and requires no root backfill. Previous binaries can keep calling either existing compact entrypoint. Application rollback can leave the additive state and functions installed.

The initial current-root matrix below predates the final pin/head access correction. It is retained as intermediate evidence; the final superseded-head matrix below is the acceptance measurement. These are medians of three complete scheduled sweeps over a static population,95% pinned, with the remainder current. Artificially advanced deadlines are fixture setup outside measured function work; actual function output/deadline logic executes. Every candidate sweep preserved all root identities and timestamps and produced zero retained-root updates.

| Roots | Function calls/sweep | Execution before→after | Shared buffers before→after | WAL bytes before→after |
| --- | ---: | ---: | ---: | ---: |
|6,763 |54 |142.83→17.65ms |419,902→51,321 |4,942,021→16,058 |
|67,630 |530 |2,451.12→180.26ms |20,719,209→620,221 |48,100,835→150,893 |

These initial results exclude superseded revision heads. They are per-sweep figures, **not hourly reductions**. A6,763-root candidate sweep recurs about every112seconds versus roughly600seconds for the old age-based pass in this simplified static model. Charging32 candidate sweeps versus6 baseline sweeps per hour still lowers the measured static maintenance execution/buffers/WAL, but is a model, not observed production work. Real journal activity and root eligibility mix alter both call counts and cost. The10× fixture remains bounded and takes about9.8minutes per full scheduled sweep, so a newly eligible just-visited root can wait nearly that long for the next wrap; retention lag grows with population.

The initial current-only real HTTP contention fixture performed128 accepted uploads across four sequential user lanes per repetition. Every lane's public `/steps` response retained its final32-step result. Each maintenance call committed independently, and the measured exclusive-lock window includes function execution through COMMIT after lock acquisition. The candidate was conservatively charged six complete sweeps per baseline sweep at6,763 roots and two at67,630 roots. All three repetitions per population stayed within the10% intake-p95 gate.

| Roots | Median intake p95 before→after | Median exclusive-lock p95 before→after | Charged calls before→after |
| --- | ---: | ---: | ---: |
|6,763 |14.36→13.76ms |8.06→1.38ms |54→324 |
|67,630 |16.75→14.08ms |2.72→0.82ms |530→1,060 |

Total charged lock time at6,763 roots was essentially flat (164→165ms); the benefit there is shorter individual exclusions despite six times the service calls. No CPU percentage is inferred from these windows. PostgreSQL `pg_stat_kcache` is unavailable locally; executor/function time, buffers, WAL, writes and HTTP latency are reported rather than invented CPU counters.

The more realistic supplemental matrix keeps95% of roots pinned **and gives each pinned root a superseding, already-compacted revision head**. It exposed two rejected implementations: eager head joins traversed heads even when a pin already excluded eviction; the scheduled wrapper's volatile timestamp predicate scanned all recent heads. Capturing the timestamp removed the latter scan under custom plans but generic PL/pgSQL plans could still choose a full scan. A deterministic test-local generic-plan probe reproduced81,156 head fetches across12 calls. The final implementation checks pins before the scalar head lookup, then compares two indexed minimum timestamps against a captured post-compaction time. The generic-plan regression now permits at most24 earliest-head fetches across12 calls. No production plan-cache settings changed.

| Superseded-head iteration |6,763 roots ms/sweep |67,630 roots ms/sweep |Disposition |
| --- | ---: | ---: | --- |
| Unchanged baseline |171.90 |4,881.83 |Reference |
| Cursor with eager head join |80.37 |6,035.76 |Rejected after cadence charging |
| Pin-first only |75.14 |5,898.71 |Rejected |
| Captured cutoff/range predicate |16.85 |1,478.00 |Rejected generic-plan instability |
| Final indexed minima |16.59 |221.69 |Accepted measured execution/WAL/intake gates |

Final three-repetition medians: buffers651,532→51,190 and39,110,984→895,874; WAL4,218,126→15,442 and41,431,535→150,645 bytes. Charging six candidate sweeps per baseline sweep at6,763 roots, and two at67,630, still reduces execution, buffer accesses and WAL. Candidate total execution under that conservative charge is99.54ms versus171.90ms, and443.39ms versus4,881.83ms. This is a static scheduling model, not production CPU attribution. The final10× execution repetitions are206.18/221.69/249.79ms; fixture rollback leaves physical dead tuples and cache/plan history between repetitions, so no claim of identical physical state is made. The earlier8× runtime jump also increased buffers and was specifically reproduced as generic-plan scan work; it was not dismissed as timing noise.

The final superseded-head contention rerun isolates B by using the same current HTTP implementation with baseline versus final database maintenance functions. It again accepted128 HTTP uploads per repetition, charged6×/2× service calls and preserved every public total. Worst per-repetition intake-p95 ratio was1.068, below1.10. Median intake p95 was14.53→14.44ms and15.21→14.41ms; exclusive-lock p95 was8.69→2.23ms and3.21→1.40ms. **Total charged exclusive-lock wall time increased**:193→342ms and1,114→1,170ms. More, shorter committed service calls introduce additional round-trip/transaction occupancy despite lower measured executor work. The implementation does not claim a total lock-time reduction or convert these windows into CPU percentages. All rejected/intermediate/final measurements are retained as `b-superseded-*.json`; the final acceptance files end in `minima.json`.

Tests cover zero retained writes, fair traversal beyond2,600 retained roots, unpin/expiry, roots inserted behind the cursor, rollback, direct-call priority, simultaneous direct/scheduled/HTTP intake with shared pins, and root-only continuation through the actual summary wake coordinator. The protected foundation suite passed21/21 on the unchanged direct-PG baseline and the refined suite plus regressions passed28/28. Its lock-observation test uses `Client.processID`, which is a virtual PID through PgBouncer, so that specific test must run directly against PG; the assertions were preserved. Real worker/cadence and protocol tests use the transaction pool.

## C: planning families

Selected shapes keep their SQL/transaction semantics and gain the existing read or queue annotation. Viewer state additionally replaces its variable `IN` placeholders with one typed text-array bind and reuses a single viewer bind; returned rows remain mapped by ID, with unchanged rematch/subscription/creator permissions. No cache, wider name budget, force-generic setting or replay-on-error behavior was added.

Each family was tested across empty/sparse/dense or small/large result distributions with three repetitions and alternating baseline/candidate executions. All returned rows matched (clock-based lease expiry fields were excluded only in the benchmark equality comparison; the existing lease correctness tests remain protected). Changes were selected only after the benchmark gates passed, and their public/worker protocol regressions failed before source edits.

| Family | Median of per-cell warm latency reductions | Worst candidate/baseline p95 ratio | Disposition |
| --- | ---: | ---: | --- |
| Post-task completion |61% |0.429 |Prepared queue SQL |
| Post-task readiness |28% |0.789 |Prepared read, same freshness checks |
| Summary deadline |76% |0.253 |Prepared zero-parameter queue shape |
| Public race discovery |55% |0.863 |Prepared finite variants; capacity before LIMIT |
| Tournament discovery |68% |0.799 |Prepared read; same eligibility/order |
| Viewer overlay |10% |0.933 |Single typed-array prepared shape |
| Full-trigger promotion |69% |0.921 |Prepared queue SQL; same locks/coalescing |
| Snapshot repair claim |46% |1.047 |Prepared queue SQL; same30-second lease CAS |
| Seeded preparation eligibility |82% |0.187 |Prepared read; same operation ordering |

Discovery results use the final supported16-slot tournament fixture with8 accepted participants; the earlier unsupported32-slot fixture is retained separately and is not the acceptance result. These are equal-weight synthetic-cell summaries, not production workload-weighted savings. Dense full-trigger and snapshot-repair fixtures benchmark the complete mutations in rolled-back disposable savepoints, not just candidate SELECTs. Viewer overlays still chose custom plans for one-ID empty/sparse cases; large lists chose generic plans. Thus naming is not presented as eliminating every plan.

The already-prepared active-event read was independently tested: its current adapter preparation lowered median warm elapsed time about74% relative to an otherwise identical unnamed query across nine cells. The largest requested batch had256 IDs but only one actual eligible user; it is a request-batch scaling check, not a fully populated256-user event workload. It already has this behavior, so **no change** was made. Relevant ANALYZE/schema changes, initial custom plans and parameter-sensitive custom-plan choice can legitimately account for planning. These local experiments do not establish which caused every production planning event, and the existing indexed lateral/membership gates remain.

The generated ORM race-membership shape was investigated and **left unchanged**. It has no explicit stable raw-SQL admission point; globally preparing generated Prisma statements would exceed this specification's controlled admission boundary. Replacing the ORM path would need exact authorization/projection/transaction-snapshot equivalence and a demonstrated winning public-path experiment. Neither the hour's elapsed total nor combining reads is evidence of that win. Existing membership/fingerprint freshness checks remain; no claim is made that this family's planning was eliminated.

## Verification and reproduction

The expanded public discovery regression passes with Redis disabled and enabled. It covers old/current headers, growing response lists, accepted versus invited rematch rights, unrelated-viewer403/list exclusion, and distinct subscription/creator permissions on the same recurring race. The actual boundary statement also survives reuse by the same client after PgBouncer replaces its backend, ANALYZE invalidation, and a rolled-back transaction error with unchanged rows. [Protocol turnover result](evidence/cpu-remediation-backend/a-session-turnover.json).

[Test-result metadata](evidence/cpu-remediation-backend/test-results.json) and retained failing/passing logs establish the tests-first sequence. The orchestrator's final combined correctness/review and full cohort comparison are separate gates; this report does not replace them.

Benchmark entrypoints are under `scripts/diagnostics/`: `cpu-prepared-boundary-benchmark.js`, `cpu-prepared-queue-benchmark.js`, `cpu-prepared-discovery-benchmark.js`, `cpu-prepared-lanes-benchmark.js`, and `capture-root-sweep-benchmark.js`. They reject non-local/non-`_test` URLs, create only synthetic fixtures, keep mutation measurements in disposable transactions and never reset shared statistics. Inputs captured from synthetic HTTP/worker executions are retained beside results so the baseline SQL survives later source edits. Reconnect commands apply only to the explicitly named disposable PgBouncer database. Use an isolated, migrated test DB with no simultaneous test cleanup.

The dedicated `capture-maintenance-contention.test.js` supports explicit baseline/candidate modes solely for test execution; this is not an application flag. The unchanged baseline DB must have the original compact functions, and candidate must have the final migration. Historical baseline SQL is retained by the baseline commit. Do not run either mode against production or staging.
