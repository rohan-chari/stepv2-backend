# Event traffic efficiency investigation — September 9, 2026

## Objective and method

Reduce database work per app open, step sync and race refresh during legitimate daily-event activity. This is an investigation, not an implemented optimization or a production capacity certification.

Continues `db-cpu-eastern-event-2026-09-09.md`. Production reads were limited to a small race/membership census with a five-second read-only timeout. No production load generation, database mutation, runtime setting change or deployment. Existing production statistics from the first investigation were reused instead of repeatedly scraping the expensive monitoring view.

Local measurements used a disposable PostgreSQL database named `bara_event_efficiency_test`, cloned from the developer's existing local integration-test database, and a dedicated loopback-only Redis on port 6395. Real HTTP handlers handled every measured request. A real production-entrypoint resolution child processed the resulting work. No scorer or database result was mocked. The fixture had two synthetic users, three active races, 24 completed five-minute samples, and an active LOCAL_ENTITLEMENTS event with attribution version 2. Only one sample changed on the second changed upload.

Counts are observed Prisma SQL events, including emitted COMMIT events and short trailing asynchronous bookkeeping, excluding hidden trigger-internal SQL and any protocol commands Prisma does not emit. They must not be compared directly to host CPU or treated as an exact per-action physical round-trip census. Warm authentication/configuration and cache state differ by scenario. Local wall-clock timings are intentionally not used to predict production latency.

Evidence: [event-action-efficiency-2026-09-09.json](evidence/event-action-efficiency-2026-09-09.json).

## Production relevance: one source update serves several races

The 19:25 UTC census found 155 active races, all with a nonempty timezone. Users with unfinished, non-forfeited accepted memberships were distributed as follows:

| Active memberships | Users |
| --- | ---: |
| 1 | 51 |
| 2 | 528 |
| 3 | 254 |
| 4 | 63 |
| 5 or more | 50 |

895/946, or **94.6%**, have at least two active memberships. This is an active-membership census, not concurrent-user traffic. It makes source-input sharing across race resolutions a particularly relevant optimization target.

## Measured action costs

| Local scenario | Observed SQL events | Outcome |
| --- | ---: | --- |
| Initial sync, 24 samples, 3 races | 28 | Three durable race jobs |
| Identical payload, fresh idempotency key | 15 | No new race job; samples unchanged |
| One changed sample and daily total | 16 | Existing pending race work merged |
| Retry with the same idempotency key | 4 | Stored response replayed |
| First Home shell | 19 | Success |
| Repeated Home shell | 15 | Success |
| Initial compact race list | 13 | Success |
| Initial profile read | 3 | Success |
| Home read after resolution | 14 | Success |
| Race-list read after resolution | 11 | Success |
| Profile read after resolution | 1 | Success |
| Resolution-status poll | 2 | Success |
| Current paged/compact race bootstrap, warm | 14 | Correct compact contract |

Discovery returned only two calls in this small fixture without the full production seeded-discovery catalog. That is not a representative discovery cost and is excluded from optimization priorities.

## Existing protections that work

- Unchanged source values suppress race enqueue and sample writes. `stepInputIntake.js:167–237` compares scoring/storage changes and the durable generation fence before loading active races.
- Pending work coalesces: two changed uploads before worker processing retained generation 1 and three jobs, rather than creating six separate pending jobs.
- The worker used dependency-closure plans: one dirty participant out of two per race, not a full participant replay. All three core jobs, placement jobs and post-tasks drained successfully in the final configured run.
- Cross-race source caching already helps. The final worker observation contained two bounded sample queries for the three races; this does not establish that either remaining read is redundant.
- Post-commit snapshot publication reads persisted totals; it does not run a second full scoring computation (`getRaceProgress.computePersistedSnapshot`).
- App startup/resume Home work already shares an in-flight future (`main_shell.dart:2709`). Do not re-propose this as an absent safeguard.

## Priority 1: reduce repeated Home refresh work after sync

`main_shell.dart:2722` persists steps and then loads Home and the race list, plus profile where required. `main_shell.dart:2257` subsequently polls at delays of 750 ms, 1.5 s, 3 s and 5 s, stopping on terminal state. On success it launches **another Home read, another race-list read, and another profile read**.

In the local fixture, that catch-up trio generated **26 additional SQL events**, plus two for the successful status poll. It does not follow that all 28 can be removed: race totals, coin changes, result modals and event summaries still need to become visible. But the app should not reload unchanged equipment/friend/profile/discovery-related state merely because race totals became current.

Proposed direction: reuse in-flight and already-current responses; make catch-up depend on which data revisions actually changed; narrow the server-side work needed to provide fresh race state. Keep a full compatibility response for frozen clients. Validate the exact rendered race totals, earned rewards, result modals and independently arriving summary receipts. A future API addition must be additive and backend-first. No feature flag is required merely to optimize this path.

Expected benefit: eliminate a measured portion of the repeated 26-call catch-up workload. **No numerical saving is claimed until the narrow refresh contract is implemented and measured.** Backend-side request-local reuse benefits old clients as well; client orchestration changes reach users only with an app update.

## Priority 2: cheaper accepted no-op syncs

Even an unchanged fresh-key sync must maintain durable admission/idempotency, event capture and proof of a successful upload. Those responsibilities are real. Three smaller candidates remain:

1. **Unconditional scoring-state write.** `scoringInputVersion.js:197` updates the version row and updated_at even when generation, watermark, boundary and queue ownership are unchanged. The prior row is already locked by intake. Avoid the write only if every semantically relevant value remains unchanged; preserve a newly crossed time boundary, generation repair and required durability. Candidate saving: one statement and one row version per qualifying no-op, subject to auditing updated_at consumers and database triggers.
2. **Repeated negative summary lookup.** `globalEventSummaryCapture.js:670` loads active summary work; `:903` uses `captureDependencies?.activeWork || findFirst(...)`, so known absence takes the fallback query. The probe observed both reads. Distinguish “not loaded” from “loaded and absent.” A concurrent event-end insertion could appear between the reads, so a change must prove capture/recovery correctness and preserve freshness promises; do not silently discard that case. Candidate saving: one query per applicable sync, not only no-op uploads.
3. **No-change daily-row fallback read.** `stepInputIntake.js:72` performs conditional upsert; unchanged values then cause a separate SELECT. Consider returning the existing row from the same statement under the already-held user scoring lock. Verify all legacy writers obey the serialization rule and preserve missing-row/concurrent-insert behavior. Candidate saving: one query per unchanged daily value.

Together these are an **upper-bound candidate reduction of 15 to 12 observed events for the illustrated no-op path**, not a measured before/after result or a 20% CPU promise. Preserve `last_step_sync_at`, immutable idempotency response, summary coverage and old endpoint behavior.

The earlier production interval had 120 scoring-state updates but 68 active-race fanout reads. This supports examining the non-fanout path, but different call sites and interval boundaries mean it is not an exact production no-op request count.

## Priority 3: share source reads and reduce resolution bookkeeping

The final three-race worker observation contained **293 SQL events**, including startup, periodic readiness checks and shutdown-window work. This number is not a clean incremental cost of three jobs and must not be divided into a claimed exact SQL-per-race cost.

Useful identified components were:

- Six event-fingerprint reads: two per committed race, with the other three fingerprint components also read twice per race. The second read validates source/graph stability under the commit fence. It cannot simply be deleted.
- Two sample reads serving the three race computations. The cache is bounded by user count, row count, TTL, source generation and coverage ranges (`raceScoringPrefetch.js:20`). It stores completed entries, rather than an explicit shared in-flight source-load promise. Investigate compatible concurrent-load coalescing, with generation and coverage in the identity; its savings remain unmeasured.
- Snapshot publication re-reads effect/event eligibility for the race after committing totals (`getRaceProgress.js:926`). Reusing a committed input context could reduce duplicate reads only with a current-generation/boundary check; delayed post-tasks must not publish stale effects or event eligibility.
- Post-task lifecycle, placement and operational counters add work beyond scoring. The observation included 12 explicit operational-counter upserts, 32 statements mentioning post-tasks, and 19 mentioning placement jobs. These are overlapping query-family counts, not independent row-write totals.

The earlier production window attributed the largest recorded query-execution CPU share to resolution, while HTTP led planning elapsed time. Therefore both source sharing and request efficiency matter. Start with a clean warm-worker incremental census before claiming a percentage reduction. Reuse immutable source timelines across races, but continue computing race-specific windows, effects and standings separately.

## Race-open lead checked and downgraded

An early fixture omitted race.timezone and therefore took the compatibility full-roster path, producing 23 warm paged-bootstrap SQL events. That was not representative: production currently has zero active races missing timezone. The same fixture with a timezone produced **14** warm current compact-bootstrap events. The unpaged compatibility request is also more expensive, but must remain correct for frozen clients. Existing request-scoped bootstrap context and paging already remove work on the normal path.

## Validation needed before implementation is called effective

Use real HTTP plus real workers on dedicated local/test storage for: changed samples, identical fresh-key syncs, same-key retries, concurrent users in the same race, one user in several races, event start/end crossings, delayed snapshot tasks, and Redis loss/recovery. Include older-client requests. Measure SQL/row-write counts, downstream jobs and useful committed results separately; then verify under a matched multi-user event workload and direct managed CPU after an authorized deployment.

The diagnostic harness initially used Redis-disabled operation; snapshot publication could not succeed and generated repair work. Those worker counts were discarded. A second harness issue used the wrong Prisma enum case in a completion check; it was corrected. The final run used isolated Redis and asserted that core, placement and post-task work drained. These are diagnostic corrections, not production defects or changes to protected tests.

No application code or production configuration was changed. No full regression suite or Flutter analysis was run because this task produced an investigation and evidence only. Diagnostic SQL counts are not a claim that the event capacity target has been reached.

Temporary local database and dedicated Redis were removed after the final measurements. Existing integration database and shared Redis were not used for fixture writes.
