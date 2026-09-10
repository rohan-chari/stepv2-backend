# Event traffic efficiency — implementation validation

Status: **ready for a separately authorized backend-first production release**. Final independent review: **SHIP**, no unresolved blockers. No deployment or store upload has occurred.

Scope and acceptance criteria are defined in [the approved spec](event-traffic-efficiency-requirements.md). The unchanged backend baseline is the SSH-verified production commit `2f021c2698f41071e526308127ddaf2b6050c35e`; the frontend baseline is `4ee76b9678ebda30c0eebd99467a6b6eb7e8a07f`.

The initial local-main pilot used `a2f575a7326355bf187cd6256d1f980343d574bd`. Release audit found that main lacks deployed immediate-join behavior and other fixes. Those exploratory runs are not accepted as release-comparison evidence. The release candidate is based on production, and matched comparisons restart against that exact runtime. No production mutation was needed to establish this.

## Fixed comparison protocol

The same [diagnostic](../scripts/diagnostics/event-action-matched-benchmark.js) runs against each checkout. It refuses nonlocal databases, requires a dedicated `bara_event_matched_*_test` database, and requires the reserved local Redis port 6396. It never loads production credentials. Fixture mutations and cleanup are excluded from measured traffic phases.

Each trace has six authenticated users, 24 initial samples per user, and either one, three or five race memberships. In the shared topology all six users belong to the same races; in the disjoint topology each user has separate races. Race targets are deliberately beyond the fixture's walking totals so these measurements do not change race settlement or reward rules.

Each process warms the real resolution worker through real HTTP intake, drains core, placement and post-task queues, and records a separate two-second idle window. It processes a due six-user event-start cohort through the actual cron entrypoint. User sessions then arrive every 100 ms, independently of prior session completion: full Home open, unchanged fresh-key upload, changed upload, existing 750/1500/3000/5000 ms status-poll schedule, and Home/races/profile reads. A successful poll uses the new Home representation only in the candidate; other terminal poll outcomes use ordinary full-shell navigation. Before the visible-completion timer ends, a separate read-only observer proves every membership job exists and its current generation has committed, including the accepted upload receipt. Real HTTP progress reads then assert and record the expected total for every membership. SUPERSEDED is a valid original polling outcome when newer work includes that upload; it never counts as proof by itself. Candidate runs must exercise at least one eligible narrow refresh, and a separate repeated combined Home/races/profile probe isolates that saving. Any repair work triggered by progress reads is included in the final session drain. Finally the actual event-end entrypoint processes the local cohort and all downstream queues drain.

Run three repetitions of each of the six traces for each version. Retain all runs. Compare accepted and completed actions, errors, per-request latency, session p95/p99, phase SQL events and elapsed query time, and final participant/source/event outcomes. Candidate p95/p99 must not exceed the highest baseline repetition plus the baseline repeat-to-repeat range for that trace. A failed or incomplete trace remains a failure; do not omit it or select the best repetition.

The initial 18 production-baseline runs are retained compressed under `pre-visibility-baseline`; they lacked HTTP visible-total assertions and do not satisfy the final latency gate. The reviewed augmented trace is rerun for both versions. A second exploratory baseline block overlapped Flutter tests and is retained under `contended-baseline`; it is excluded from final timing acceptance for that independently identified reason, before any candidate measurements. Final runs use a quiet window with tests/builds stopped and a per-run process guard. `completionMs` measures backend-ready explicit-navigation visibility, not automatic app refresh after SUPERSEDED; `automaticCatchupHttpMs` reports successful-poll catch-up HTTP completion separately. Observer SELECT counts and durations are separate from application SQL.

These are bounded local comparisons, not a production-capacity proof. Prisma events include control statements; CTE statements may contain several operations. Query elapsed includes waits and does not establish isolated CPU/planning cost. Periodic worker queries remain included in measured traffic phases and are also shown in the separate idle phase. The focused intake tests must separately prove the avoided row version; deterministic overlapping-source tests must separately prove the three-to-one source-read reduction.

## Required evidence

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| Architect approval | Final reviewed spec, no required changes | Approved |
| Home API and frozen-client compatibility | Real HTTP response parity, skipped-service SQL attribution, errors | Passed; see backend/frontend validation evidence |
| Unchanged intake and concurrent writers | Red-to-green HTTP tests, tuple/version proof, changed/boundary repair cases | Passed; see backend/frontend validation evidence |
| Concurrent source sharing | Real worker overlap, generation/range/isolation/cleanup/capacity tests | Passed; see backend/frontend validation evidence |
| Flutter state and compatibility | Real MainShell fallback, freshness, coins, invalidation, ordering and demo tests | Passed; see backend/frontend validation evidence |
| Matched event traffic | 18 baseline and 18 candidate traces, all outcomes and latency comparisons | Complete; spec gates pass; additional diagnostic exceptions retained and independently reviewed after attribution |
| Backend regression checks | Appropriate unit and integration suites on dedicated test databases | 3,383 unit and 170 integration passed on production-derived release |
| Flutter regression checks | Full test suite and clean analyze | 3,247 full-suite tests; 163 focused; analyze clean |
| Independent implementation review | No unresolved required changes | Final SHIP; all review findings resolved |
| Both production app artifacts | README configuration, signed iOS and Android, artifact freshness | Passed: iOS 2.3.13 (12), Android 2.3.13 (203142); signed configuration/freshness manifest in frontend evidence |
| Deployment readiness | Requirement-by-requirement completion audit and concrete backend-first release notes | Passed; final independent SHIP, with disclosed diagnostic exceptions |

Actual production CPU improvement, the user's approximately 70% idle objective, and real event traffic observation can only be assessed after a separately authorized deployment. No production service, capacity, configuration or data is changed by this implementation validation.

## Fixed comparison result and diagnostic exceptions

All 36 runs completed: 216 user sessions, 432 accepted uploads, 648 verified membership totals, no HTTP errors, identical final outcomes. All six traces pass accepted/completed actions and time-to-visible-results p95/p99 within the fixed baseline ceilings. Combined Home/races/profile probe separately measures 22 full-shell statements versus 17 narrow statements in all three pairs.

The fixed comparator nevertheless reports `passed: false`, which is preserved. Additional pooled HTTP and whole-session SQL diagnostic checks failed: shared-one-race request p99 64 ms versus a 63 ms ceiling; shared-five-race request p95 47/45/44 ms versus a 44 ms ceiling; shared-five-race mean SQL 1,832 versus 1,821.67 (+0.57%). These additional diagnostics are not the spec's named visible-results/isolated-Home gates, but need causal assessment before readiness. No thresholds were relaxed and no failing runs were dropped.

Across the three shared-five-race runs, HTTP/cron SQL falls 2,737→2,669, worker SQL rises 2,728→2,827. Poll counts and core claims/commits are unchanged. Worker logs reveal additional source/closure fingerprint retries and artifact revalidation. The full candidate and a diagnostic build retaining production source loading are compared against production in a fixed, rotated three-repetition schedule. This attribution experiment supplements, and never replaces, the original failed diagnostic report.

Separate bounded local `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` probes record planning time, execution time, buffer use and plan rows for actual intake SQL; all probe writes are rolled back. Eliminated Home SELECTs have read-only EXPLAIN evidence. These query-level probes are not workload CPU or production-capacity measurements. Source-version MVCC tuple/timestamp preservation is established by the focused HTTP test and matched intake evidence; SQL operation-presence counts cannot establish physical row versions.

## Final attribution and readiness decision

The supplementary nine-run experiment rotates production, full candidate and a diagnostic candidate with production source loading, three repetitions each. All nine final outcomes match; 54 sessions and 270 membership generations/totals are verified. Mean session SQL: production 1,836.67, candidate 1,821, without sharing 1,818.33. Pooled request p95 runs: production 41/47/42 ms, candidate 33/37/40 ms, without sharing 38/33/50 ms. Candidate maximum fence acquisition is 1.47 ms versus production 1.64 ms; maximum transaction duration is 29.16 ms versus production 32.23 ms. One closure retry occurs in the candidate; no source-input fence rejection occurs in any of these nine runs.

The original pooled-latency increase did not reproduce as a consistent source-sharing effect, and no increased writer stall appeared. Progress-read mean remains slightly higher (candidate 17.36 ms, production 14.91 ms, without sharing 16.54 ms); this small experiment cannot exclude every small latency effect. The independent reviewer judged the evidence consistent with scheduling-dependent variation and returned **SHIP, no blockers**. This does not turn the original additional diagnostic report into a pass.

Final evidence is retained under `docs/evidence/event-traffic-efficiency/`, including all 36 original runs, all nine attribution runs, worker logs, original false comparison, operation/job accounting, EXPLAIN plans, isolated Home/intake measurements and regression logs. `traffic-evidence-manifest.json` records raw content hashes and lengths. Query-level EXPLAIN cost is not production CPU. No claim of approximately 70% managed DB idle is made before production observation.

## Concrete release handoff

- Backend release branch: `event-traffic-efficiency-release`, based on deployed `2f021c2698f41071e526308127ddaf2b6050c35e`; runtime candidate `f264099`. Do not deploy divergent local main. The source-ablation branch is diagnostic only and must never ship.
- Frontend implementation: `5687c8f`; verified signed artifacts iOS 2.3.13 (12) and Android 2.3.13 (203142). Frontend release notes link their hashes, build records and configuration verification. All runtime source hashes still match the reviewed/tested implementation.
- No schema migration, backfill, dependency change, release flag or capacity change. Preserve the existing production package-lock modification during an eventual deployment. Keep exactly two production HTTP workers and staging stopped.
- After separate deployment authorization: deploy the production-derived backend first, check legacy/new Home representations with bounded authenticated reads, then publish the paired app artifacts only as authorized. A backend rollback leaves new apps using their full-shell fallback; frozen apps retain their existing representations throughout.
- Compare direct managed CPU and PostgreSQL statistics during comparable event traffic after deployment. Current local work verifies reduced per-action work and correctness, not a production utilization target.
