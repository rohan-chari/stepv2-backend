# Residual historical step-read reduction

Status: architecture-reviewed development spec; awaiting user implementation approval. Part of db-work-reduction-requirements.md. Research baseline 17c8983.

## Summary and research

As a racer, corrected historical steps must always produce the same live and settled totals. Reduce unnecessary repeated PostgreSQL history loading while preserving canonical raw intervals and every source-version fence.

Current raceScoringPrefetch.js uses process input cache, then historicalRawSampleCache.js, then bounded StepSample.findRowsForUserRanges. Historical raw Redis reuse is ALREADY deployed. Query: <=25 ranges, <=50,000 rows/page. Capture: 1,849 calls, 1,491,295 rows, 46.81 s executor elapsed. Later 47 telemetry records for one PID gave 664 hits/3169 misses; they lack timestamps and exclude bypasses, so 17.3% is not the overall or original-window hit rate. `proofRaces` also counts paging/merge-limit rejections, not just concurrency.

Exact range starts are already UTC-day aligned (raceScoringPrefetch.js:627–639). Current key includes user, exact start, cutoff and historical revision. Current publication rejects a timeline above 20,000 TOTAL rows before extracting its historical prefix (historicalRawSampleCache.js:151–154). Prefetch already reads user generations, while historical loading separately fetches pre/post proof tuples. These are concrete candidates; a broad key redesign remains conditional on attributed evidence.

## Scope and implementation order

### A. Permanent bounded measurement

Modify historicalRawSampleCache.js, process-input cache admission in raceScoringPrefetch.js and coordinatedOptimizationMetrics.js. Use fixed allowlisted reason labels, aggregate counters and the existing 60-second log, adding schema version, UTC timestamp, PID, process-start identity and interval length. Preserve old aggregate fields additively for existing consumers; clarify legacy proofRaces by adding precise counters rather than silently repurposing it.

Accounting contract: one terminal outcome for each user source-load request at process cache boundary, and one terminal outcome per user that reaches raw cache. Separate stage events for pre-hit acceptance, post-read rejection and publication. Count bypassed loads as well as attempted Redis reads. Enumerations:

- Process: hit, absent, expired, generation mismatch, coverage mismatch, caller budget/source-model mismatch.
- Raw bypass: Redis disabled, caller budget, no historical range.
- Proof: missing, malformed, incomplete/unclassified generation.
- Redis lookup: unavailable, absent_unknown, oversized, batch_byte_budget, malformed_payload, batch_row_budget, accepted.
- Post-read fallback: proof_changed, paged_tail, merged_row_cap.
- Publication: success, unavailable/failure, no_proof, changed_proof, paged_source, total_timeline_cap_legacy, historical_row_cap, encoded_byte_cap, memory_guard.

Pin precedence in code/test documentation so reasons are mutually exclusive at each terminal stage, and reconcile sums. Missing Redis key is absent_unknown, not asserted expired. A bounded Lua read can return status plus payload/size in the same existing request; no additional per-user Redis calls, SCAN or DB diagnostics queries. Measure actual full/recent rows, proof/sample SELECT counts and durations, Redis operations/read/write bytes and publication bytes. Do not emit users, revisions, key hashes, raw steps or individual sample timestamps.

For overlap attribution, maintain optional-to-execution but always-enabled advisory metadata in a process-local map capped at 2,000 entries and ten-minute lifetime, with one actual observed interval per user/revision (never synthesize earliest start/latest cutoff from separate intervals; retain the first observed interval if intervals are incomparable). Store no samples; never use it as scoring proof. Admission to this map is bounded and eviction affects only measurement. Report 'potential coverage reuse' separately from proven cache hits; bound metadata observations across process restarts and avoid high-cardinality output.

A is an independently releasable implementation after normal review/production authorization. Collect one comparable two-hour window including worker counters, DB CPU/user/system/I/O/steal, zram and query deltas. Capture across midnight additionally before selecting a cutoff-specific remedy. Account explicitly for missing final windows, restarts, statistics evictions/resets and nested statements.

### B. Two bounded candidate improvements

B1 — prefix-size admission: for a complete nonpaged timeline, extract only whole rows ending <=cutoff. Stop immediately once historical prefix exceeds 20,000 rows or encoding/memory cap. Admit fitting prefix even when full timeline exceeds 20,000; preserve <=1 MiB payload, <=4 MiB/50,000 decoded rows per batch, total caller timeline cap, 32 MiB guard, sequential publication and canonical paging fallback. Do not raise any bound or admit paged data. Test before editing logic: full timeline >20k, historical prefix <20k, warm load fetches recent tail only; oversized-prefix companion still falls back.

B2 — reuse existing initial version/proof read: extend the existing bounded source-version read/model projection in raceScoringPrefetch.js and its version reader to include historical revision, complete generation and protected cutoff. Pass an immutable tuple to the historical loader only when captured in the SAME current source-read attempt and exact user set. Never use a persisted, process-cache or prior-attempt tuple as fresh initial proof. Retain post-source proof SELECT and final transactional generation fence. Missing fields/old model implementations use the current pre-proof query or canonical path. Standalone loader retains its own initial read. Count total queries: expected saving one pre-proof SELECT per eligible batch, with no wider per-user query or extra lookup. This needs no new schema columns.

Implement B candidates after failing tests and benchmark baseline/candidate on isolated replay. B1 must explain >=10% of attributed full-reload rows and reduce source rows by >=20% in its affected cohort to justify a production policy change; otherwise keep it documented as not worthwhile rather than claim it fixed production. B2 qualifies by deterministic SELECT elimination, provided total DB/Redis/worker cost does not regress. Thresholds are engineering gates, not measured results. No >5% worker p95 regression in repeated representative replay.

### C. Conditional superset coverage prototype

Only proceed if A shows differing valid coverage accounts for >=10% of full-reload rows and a local prototype passes >=20% source-row reduction for that affected cohort. Keep this as a separately reviewed development unit. No automatic production policy activation, flags or unconditional TTL extension.

Prototype format `historical-raw:v2:<user-hash>:<historical-revision>` has at most one payload per user/revision, explicit version/userId/revision/start/cutoff/whole rows, with exact requested-user and revision validation. Keep ten-minute expiry and existing byte/row caps. Old v1 processes keep their own keys; neither parses the other's format. Old keys expire naturally; rollback ignores v2. No key enumeration.

A valid v2 entry may satisfy a requested start >=cached start only if its cutoff is <=current safe decision/proof cutoff and it covers a nonempty historical segment for that request. Filter whole cached rows by end > requestedStart; load the recent tail from cached cutoff. Never advance cached cutoff without loading and validating the newly historical region. Never split a row or infer uncovered range as zero. If requested start precedes cache start, data is paged/oversized/corrupt, proof is missing, or before/after proof differs: canonical full reload.

Concurrent safe publication: before/after version proof governs content. An atomic bounded compare-and-set Lua publication preserves an existing valid entry with at least as broad coverage; replace only if the new interval contains the old interval, or the old value is absent/invalid/expired. Equal coverage preserves the existing value AND remaining TTL; it is not a refresh. Incomparable coverage can retain the existing value (lower hit rate, never incorrect data); do not merge raw payloads in Redis. Validate comparison metadata and bound Lua bytes/work. Reads still validate complete payload and proof; cache selection is never proof of freshness. No TTL extension on reads. Define exact CAS behavior and cross-cutoff tests before merging this optional branch.

## Authority and compatibility

PostgreSQL step_samples plus user_scoring_input_versions remain authoritative. Preserve symmetric added/removed interval classification in stepSample.js and unclassified-old-writer generation handling in scoringInputVersion.js. Whole seam-crossing rows belong to recent SQL loader; no clipping/rounding changes. Daily-row refresh remains unchanged. Source data changing between initial proof and raw read rejects mixed input. C0/final generation checks remain authoritative. Settlement and coin calculation continue existing PostgreSQL-only paths.

No public endpoint, request/response JSON, statuses, capabilities, schema migration, native app release or UI changes. Missing new internal metadata safely chooses existing reads. Both frozen iOS/Android clients get identical results. No new economic policy, flags, Redis durability dependency, additional infrastructure or runtime knob.

## Tests first

Extend test/integration/historical-raw-sample-cache.test.js and fixtures/historical-raw-worker.cjs through actual /steps/sync-v2, separate real worker processes, stored totals, /races/:id/progress with old/current headers and settlement. Keep all existing assertions.

Retain correction/deletion/move/replacement, cross-cutoff three-step rounding, old-writer gap/no-op repair, retention, cold-fill race, final-fence race, expansion, cross-process, Redis corruption/outage and settlement checks. Add each telemetry reason with deterministic accounting; >20k total/fitting prefix, oversized prefix, batch/memory caps; historical correction and recent-only upload between shared initial version read and loader (reject stale generation, then allow a fresh attempt to reuse unchanged historical revision); consumed initial proof from another attempt rejected/fallback; missing proof fields. A separate Redis-UNSET suite is required because current suite requires Redis at initialization.

If C qualifies: contained later start, earlier uncovered start, alternating races, midnight cutoff advance, true expiry, wider/narrower/incomparable concurrent fills, stale v1/v2 overlap, short race whose end precedes cutoff, and exact canonical score equality. Public outcomes plus actual SQL/Redis counts prove savings; helper-only tests are insufficient.

## Acceptance, ownership and release

A accounting reconciles with no unexplained gaps and no new telemetry DB writes/extra per-user calls. B/C gates above require end-to-end benefit, exact API/persisted/settled parity and unchanged budgets. A higher hit rate alone is not success. Preserve complete benchmark evidence including rejected hypotheses. No guaranteed host CPU delta.

Backend developer owns reader/prefetch/version projection/metrics/tests. All test runs require verified local *_test DB and isolated Redis. Relevant integrations + npm run test:unit; code-reviewer before done. Flutter analyze in umbrella checklist; no native builds. Each production observation deployment requires separate authorization; no staging start or capacity change. User approval of spec is not approval to deploy instrumentation.

## Revision log

- Draft: replaced generic cache recommendation with attributed measurement, prefix admission and initial-proof reuse; coverage redesign gated by evidence.
- Gap pass 1: distinguished bypasses/absent keys/paging from concurrency, preserved existing aggregate semantics and added complete per-stage accounting.
- Gap pass 2: bounded advisory metadata, pinned proof provenance and whole-row coverage/CAS semantics; separated Redis-unset coverage and evidence-gated policy branches.
- Architect review: APPROVE stages A/B; C remains a separately reviewed conditional prototype. Suggestions incorporated for actual-interval attribution, exact user/revision validation, equal-coverage TTL preservation and recent-only concurrent uploads.
