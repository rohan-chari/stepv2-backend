# Database work reduction implementation

User approved implementation on 2026-09-13. Source baseline: `6c5fd10cc2bd27d109a2b2a5bc67cae36032553f`; isolated branch `feature/db-work-reduction`. Existing unrelated working changes were not copied or edited. The final selected units are the pending-parent index, cache measurement plus initial-proof reuse, shared enrollment discovery/continuations, and combined deadline discovery/wake coalescing. Production deployment is not authorized.

## Locked contract and compatibility

No public endpoint, parameter, response field, status/error, client capability, Redis wake payload, credited step, eligibility, event timing, balance or reward policy changes. Existing native background ingestion remains HTTP202 with `CANONICAL_SOURCE_QUEUE_V1`. PostgreSQL remains authoritative; existing transaction-time generation fences, writer locks, durable obligations and authoritative deadline drains remain intact. Frozen iOS/Android binaries use the same APIs without a release.

The sole migration is `20260914010000_global_event_pending_parent_index`, an additive standalone `CREATE INDEX CONCURRENTLY` compatible with old writers. No data backfill, schema field or Redis format changes. Existing raw cache v1 limits and ten-minute expiry remain unchanged. No release flag, topology/pool change, staging startup or production action occurred.

## Selected index and experimental controls

Tests first: the absent-index structural assertion failed before the migration existed. Fresh PostgreSQL18 replay, exact definition, readiness/validity and idempotent Prisma deploy retry passed. A canceled concurrent build left an invalid/not-ready artifact; exact removal/rebuild restored validity. See [migration/write rehearsal](evidence/db-work-reduction/parent-index-operations.md).

The index is retained after the final benchmark review. Every relevant table, including `global_step_events`, is explicitly ANALYZEd in the final fixture. Earlier explorations omitted parent-table statistics; their cheap69-buffer plans and tentative index-omission conclusions are superseded. Pagination by itself is **not** credited with the index's scan reduction.

Frozen final raw evidence: [four pinned fixtures](evidence/db-work-reduction/parent-paginated-index-pinned-v1.json) and [derived summary](evidence/db-work-reduction/parent-paginated-index-summary.json). Ten pairs per fixture:

| Fixture | Median root accesses, without→with index | Median executor ms, without→with |
|---|---:|---:|
|27,000 rows, mostly drained|16,127→55|19.517→0.027|
|27,000 rows, pending heavy|4,520→4,520|6.441→6.430|
|252,000 rows, mostly drained|155,214→55|260.887→0.030|
|252,000 rows, pending heavy|9,508→9,508|17.032→16.269|

The last fixture varied by plan/visibility state: without-index root accesses ranged7,453–46,227; with-index7,453–13,527. One paired sample regressed7,527→9,571; do not describe this as a consistent27%regression or claim universal improvement. Its executor p95 was120.861→32.928ms, but concurrent unrelated test work affects elapsed time. These are warm plans and index construction warms candidate pages; no OS cold-cache or CPU claim is made. The representative selected-query lifecycle test retains the80%root-work gate and exact row set/order.

Controlled30-pair boundary writes, with competing tests paused: start p95+2.739%, end p95−2.458%, both within the declared5%latency threshold. Start WAL increased about7.13%; end WAL was effectively unchanged. The measured mostly-drained read saving outweighs that explicit write cost for the observed workload. Monitor pending-backlog composition after release. No forced planner settings or additional index variant were introduced.

## Cache measurement and proof reuse

Tests first: new real HTTP/worker accounting failed because attributed counters were absent; the proof-read test then failed2 versus1. Final cold and warm worker paths perform one authoritative post-source proof SELECT instead of separate pre/post SELECTs. The existing initial version read supplies immutable proof facts only for the current attempt and exact users. The common fingerprint path carries those facts through one-shot WeakMap provenance outside its digest/serialized artifacts; copied, persisted, missing-field, wrong-attempt and reused capabilities fall back to the original read. Final generation fencing is unchanged.

The real cache suite has21 passing tests: public sync, persisted and old-client HTTP scores, corrections/replacements, old-writer gaps, corrupted/oversized/expired entries, Redis command outage, cutoff rounding, coverage expansion, cold-fill and final-fence races, actual retention, settlement and a separate real worker process. A separate Redis-unset worker integration preserves both legacy/current HTTP totals and attributes the bypass. Seven internal provenance/accounting tests cover properties unavailable to an HTTP caller, including consumed/wrong-attempt proof, missing/malformed/incomplete proof, bounded lookup statuses, legacy timeline cap, paging, and source/memory failure accounting.

Process and raw terminal counters reconcile independently of lookup/post/publication stages. Fixed reason labels include `absent_unknown`, rather than an invented expiry cause. Additional fixed `memory_guard`/`source_failure` terminals account for aborted loads while preserving exceptions. Logs retain legacy cumulative fields and add UTC time, process-start identity, interval deltas, actual source-row attribution and IO operation/payload-byte/row/time counters. Bytes exclude TLS/RESP framing. Advisory overlap metadata retains at most2,000 actual intervals for ten minutes; it stores no samples, never invents interval unions, and never authorizes scoring/cache reuse.

B1 prefix admission and C coverage redesign remain unselected: their required attributed production/midnight evidence does not exist yet. Instrumentation is not described as fixing every cache miss. B2 controlled replay passed: 30 alternating baseline/candidate warm Redis pairs through public HTTP ingestion and separate real worker processes measured whole-tick p95 128.868→128.057 ms (−0.63%) and median 124.123→124.831 ms (+0.57%). Every pair performed 45→44 worker SQL statements and two→one proof SELECTs; persisted and HTTP scores matched throughout. The timer excludes process startup and honors the durable intake readiness floor before starting. This is one-user/one-race warm-worker evidence, not a capacity or CPU claim. See [raw worker pairs](evidence/db-work-reduction/historical-proof-worker.json).

## Enrollment

Tests first: five-parent discovery failed with five physical cohort statements. It now uses one, and fully enrolled repeats open zero enrollment writer transactions. Existing logical page/cursor assertions are preserved by mechanically projecting batch parameters in the test harness; separate physical SQL observations prove batching. Ten alternating warm five-parent plans measured aggregate median buffers4,245→2,034 and executor17.948→8.077ms before the final all-table ANALYZE harness correction; the physical5→1cohort count and zero empty writer transactions are deterministic, while final timing/plan attribution must use the recorded fixture context.

The stable controller retains at most16 parent states across head/tail lanes. Cursors advance only after successful writes, including full pages creating zero entitlements. Matching resident pages share discovery/writes. Parent disappearance exhausts on retry. Stop/budget checks occur after discovery and before each authoritative transaction. Three independently retained pending deadlines share one production timer; due boundaries precede maintenance/enrollment. The pre-existing exported complete-minute callback injection retains its synchronous start contract through a narrow adapter containing no SQL algorithms.

A17-parent/10,001-user replay completed90,009 durable entitlements and matching obligations in15 slices. Eight early parents had elapsed candidates; a lower-ID newcomer in the last parent was reached10.852seconds into the unfinished sweep, meeting the local60-second head-service gate. The replay took82.991seconds overall. Added real regressions prove no second writer after budget/shutdown and successful continuation after a resident parent is removed. Final combined rerun results are appended below.

## Deadline, combined verification and limitations

Root-owned deadline implementation and public activation/sync/worker/publication experiments: [deadline validation](evidence/db-work-reduction/deadline/validation.md). Idle ten-pair replay records three discovery/empty-claim commands becoming one; this is not a66.7%total-DB or CPU claim. The controlled ten-pair mixed activation/sync replay passed every functional/publication assertion, with median run p95 deadline dispatch 103.5→101.5 ms (−1.93%) and p50 76.5→76 ms. An earlier replay amid competing database tests regressed p95 by6.5%; that result is retained, and was not reproduced with those tests paused. The 1,000-user/ten-race baseline and candidate replays each passed2,000 old/current HTTP assertions, ten latest-generation publication receipts, and empty relevant queues. Their single-pair p95 274→234 ms is functional evidence, not a statistical improvement claim. Both versions preserve score100, three slots and no remaining effects.

Full backend units with correct local test configuration:3,402 passed and two failures reproduced unchanged on baseline6c5fd10(missing gitignored capacity-profile fixture; Hitchhike structural-site count). Broad local-global/reliability integrations:65 passed and three baseline-reproduced failures(closure-plan expectation, retired Home-cache expectation, display-artifact expectation). Original assertions remain untouched. An earlier unit run omitted the fixture session secret; its extra failures are superseded by the correctly configured run.

Frontend companion audit:137 focused tests passed; `flutter analyze`clean; no UI/native changes. Report: `docs/db-work-reduction-frontend-verification.md` in the frontend checkout. Combined review completion and final test counts are recorded below. Deployment and comparable two-hour/midnight production observation require separate authorization; no guaranteed CPU reduction or70%idle result is claimed.


## Final local regression rerun

After the final writer admission/proof-consumption/error-accounting changes:50/50 enrollment, Redis-unset and legacy scheduler/writer checks pass;21/21 real cache checks pass;9/9 parent-index and internal proof/accounting checks pass. The final17-parent fairness replay completed90,009entitlements/obligations in11slices and54.996seconds; the newcomer was served5.135seconds after insertion. Both recorded large replays satisfy the local60-second freshness gate. Controlled deadline loaded-performance and B2 full-worker replay subsequently passed as detailed above.


Shutdown follow-up: a pure injected regression reproduced legacy boundary/read work being admitted after stop during local maintenance. The minute wrapper now checks stop between those phases and before each legacy race enqueue; all three focused timer/ownership cases pass. No database calls were made by that pure test. Final broad unit verification follows the controlled benchmark hold.


Final verification on the reviewed candidate: `npm run test:unit` ran 3,410 tests, with 3,408 passing and the same two baseline-reproduced failures (missing gitignored `.env.capacity-prod-flags` fixture; pre-existing Hitchhike structural count expecting six sites while finding three). The final focused integration runner passed 39/39 scheduler stop/legacy writer/parent-index checks. No assertions were skipped, weakened or removed. The selected-query repeat compared frozen actual baseline SQL with final SQL and preserved the exact five-parent result/order; populated index size was 32,768 bytes at 2,003 pending rows among 27,000 entitlements. See [final regression evidence](evidence/db-work-reduction/parent-maintenance-final-regression.json). This populated measurement is distinct from the 8,192-byte drained-empty index in the write rehearsal.

The required combined code review approved the implementation and final guards. All authorized local implementation and measured acceptance checks are complete; the full suite retains the explicitly documented pre-existing failures. Remaining gates are separately authorized release/migration and comparable two-hour/midnight production observation, which also determine whether B1 or C is justified. No production CPU reduction is established. After all tests, the dedicated PostgreSQL18 cluster and both backend-owned temporary Redis instances were stopped only after verifying no other client sessions. Original workspace services and uncommitted work were untouched.
