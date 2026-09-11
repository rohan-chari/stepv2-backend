# Retired event recap test disposition

Approved spec section 8 explicitly replaces the old recap worker/counterfactual feature.
These suites are archived unchanged for provenance, not skipped to make tests pass.
New public replacement contract: `test/integration/simple-event-recap.test.js`;
zero old runtime: `test/services/simpleEventRecapRetirement.test.js`; actual race
score parity and SQL cutover/drop are independently exercised by the matched HTTP
benchmark and migration rehearsal. Pure expiry tests remain active, unchanged
except their moved helper import. Mixed scoring/notification suites remain active.

## Recap-only suites retired

## Mixed suites retained and exact changed assertions

- `recordStepSyncV2ConcurrencyContract`: retain Read Committed/idempotency and
  ordinary resolution wake assertions; replace retired capture retry/lock-source
  assertions with zero capture machinery structural guard.
- `queueClaimBranchPlans`: retain race/notification branch assertions and applied
  migration provenance checks; retire only the two summary-worker source checks.
- `autoEnrollNewUserGlobalEvent`, `globalEventEnrollment`,
  `localGlobalEventEntitlement`: preserve exact enrollment identities,
  transaction/fence order and returned scoring event maps. Mechanically remove
  obsolete status/attribution metadata from expected membership rows.
- `globalStepEventRetention`: replace old worker-state/summary-ready gates with
  elapsed retention and no-active-race gates. Preserve counts, cutoff and healthy
  result assertions; model renamed to eventRecap.
- `homeLaunchAuxiliaryBatch`: only change injected raw-query method to match new
  parameterized query signature; all batching/result assertions remain intact.
- `startup/index`: expected registered jobs excludes only the deleted summary
  scheduler, preserving all other startup job counts.
- `globalEventSummaryLifecycle`: active unchanged date/DST assertions now import
  relocated pure expiry helper.

## Recap-only suites retired (individual title inventory)

- `feature-batch-2026-08-17-contracts`: retain all ownership/ack/review/private
  effect assertions using saved-recap fixtures; retire only “uses a transactional
  JobRun fence when global impact groups become final” (new first-writer HTTP
  concurrency tests replace the retired JobRun fence).
- `cron-work-bounds`: retain every seeded-election/activity/notification-fanout
  test. Retire only four obsolete capture-maintenance tests: routine wakes vs
  historical retention; fixed cutoff capture collectors; bounded old derived
  progress collection; live mutation journal compaction. SQL retirement tests
  now prove those journals/workers do not receive operational writes.

The `test/modules/loadTesting/globalEventSyncAnalysis.test.js` and
`globalEventSyncFixture.test.js` suites belong exclusively to the retired
capture-capacity CLI (including its SQL source map). Archive all their original
assertions unchanged. Replacement measurements use the simple-recap matched
HTTP/worker benchmark and the SQL retirement rehearsal, not old work receipts.

### test/jobs/globalEventSummary.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/jobs/globalEventSummary.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- summary exact-due scheduling excludes recovery deadlines owned by the fallback sweep
- leased WAITING_RACES and WAITING_SYNC work rearm at the lease, never their past boundary
- an overdue recovery deadline runs only on fallback and cannot re-arm a zero-delay due loop
- production summary drain failures reach the coordinator's one-second clamp
- global recap waits until the event enrollment window has closed
- closed events still require every durable enrollment to settle
- all-zero final groups are durably claimed without creating a summary
- mixed nonzero contributions summing to zero still create the recap
- v1 recap discovers only unfinished eligible groups in one bounded query
- v2 keeps its one-second cadence while v1 adaptively backs off
- summary scheduler shutdown waits for both phases and does not re-arm v1

### test/services/globalEventSummaryCaptureFilter.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/services/globalEventSummaryCaptureFilter.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- insufficient post-event coverage skips mutable scoring facts
- summary capture loads active and waiting work with event definitions in one query
- race post-processing hydrates artifacts only for actionable summary work

### test/services/globalEventSummaryAttributionParity.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/services/globalEventSummaryAttributionParity.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- boundary artifact uses the shared whole-race parity vectors

### test/lib/globalEventCaptureFactCache.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/lib/globalEventCaptureFactCache.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- global-event capture fact cache invariants
- does not treat the gap between two disjoint fills as covered
- evicts least-recently-used entries using samples and daily rows together
- expires entries at the configured TTL
- releases a pending waiter when a failed fill rolls back

### test/integration/durable-capture-compaction-cadence.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-compaction-cadence.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- ordinary summary wakes and new worker instances do not rerun compaction before it is due
- a full maintenance batch keeps its 128-row bound and schedules a prompt continuation
- a rolled-back compaction preserves both its history and its due deadline
- a concurrent maintenance owner does not make ordinary summary wakes wait on its lock
- the real summary wake coordinator continues compaction without another user upload

### test/integration/durable-capture-facts-foundation.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-facts-foundation.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- durable capture fact storage through real step intake
- journals HTTP scoring changes and reconstructs a pinned version after another upload
- does not invalidate historical days or metadata-only sample changes
- represents empty revision zero and preserves it across later insertion
- retains deleted and moved preimages and deduplicates crossing-day samples
- rolls back source facts, heads, journal, and pins atomically
- bounds membership fanout for years-long legacy samples
- reuses one immutable materialization across different durable owners
- reconstructs unprepared pre-migration revision-zero rows after correction
- collection preserves inverse history for an unprepared revision-zero pin
- collection bounds deletions and retains latest historical materialization after release
- pins different owners in one SQL statement and shares overlapping roots
- overlapping warm pins do not wait for another intake transaction to commit
- intake can pin immutable identity while a worker holds its preparation lock
- concurrent first creation keeps its saved revision vector after waiting for the winning creator
- reclaims aged latest facts and idle heads only after their final pin is released
- a large day is prepared in bounded resumable pages instead of one population-sized JSON
- cursor-crossing moves, deletion, and new rows between pages preserve exactly the originally pinned facts
- an old unprepared root replays a large correction journal in bounded pages
- eviction deletes bounded child rows and allows a new pin without resurrecting partial old pages
- long-span sentinel preparation is bounded and preserves transitions between long and ordinary samples
- rolling back a page rolls back its cursor, identity ledger, and digest together

### test/integration/durable-capture-interval-reuse.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-interval-reuse.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- durable interval projection reuse
- batches related immutable projections while preserving public event attribution
- reuses exact sample answers after same-day mutations without reading immutable payloads
- revalidates changed roots when journal proof has been compacted, never assumes missing rows mean zero
- applies in-window journal corrections while accepted captures retain their original result
- falls back to immutable facts when a retained journal has a gap
- does not invalidate sample-window answers when only the daily counter changes
- does not reuse a retired head's answer when a new root repeats its numeric revision
- advances moved cross-midnight samples without duplicating their day-chunk contributions
- bounds the recent proof tail and collects it after its quiet interval
- preserves exact contributions when legacy facts move into and out of the long-span sentinel

### test/integration/durable-capture-root-budget.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-root-budget.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- durable cached-root aggregation budget
- yields and resumes long warm root vectors without replaying their completed prefix
- keeps exact-date daily input work linear across a race older than thirty days

### test/integration/durable-capture-root-sweep.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-root-sweep.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- summary maintenance traverses retained roots without rewriting them and propagates its bounded cursor deadline
- forced old compact wrapper sees an unpinned root immediately after a short sweep
- rollback preserves cursor and roots; an eligible root behind retained pages is eventually collected
- direct maintenance never takes the outer schedule row behind its advisory lock
- new roots behind the cursor and roots made eligible after a visit are found on wrap
- shared intake pins fence simultaneous direct and scheduled maintenance without deadlock
- forced compact prioritizes oldest eligible transition when age order disagrees with UUID order
- root-only continuation reaches the real summary wake coordinator without another upload
- pinned superseded roots do not read revision heads merely to rule out their eviction
- scheduled root pages do not scan current revision heads for future retirement

### test/integration/durable-capture-snapshot-bounds.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-snapshot-bounds.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- durable capture snapshot bounds
- loads revision heads only inside each race population's own capture window

### test/integration/durable-capture-terminal-cleanup.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-capture-terminal-cleanup.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- bounded terminal durable-capture pin release
- ${terminal} releases at most128pins per worker pass and eventually releases all (recovery=${recovery})
- shares one128pin budget across aged cleanup, new expiry, and new failure in the same pass

### test/integration/durable-directed-capture.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-directed-capture.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- exact directed capture dependency planning
- an incoming leecher is a raw-fact leaf; its own incoming chain and disconnected history are irrelevant
- competing drains and a victim's Hitchhike copy preserve exact uploader credit without evaluating leaf scores
- a frozen outgoing victim is not evaluated or loaded
- a departed competing leecher remains a raw leaf because its victim is still drained
- a Hitchhike raw leaf retains its finish clamp even though its score is never evaluated

### test/integration/durable-global-event-capture.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-global-event-capture.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- durable asynchronous global-event capture
- accepts the sync before calculating or publishing its capture artifact
- scores the accepted input version even when a later sync replaces its samples
- reuses prepared history in a genuinely fresh worker process
- \n
- reports physical source preparation separately from immutable page reads
- retains accepted facts when source retention deletes samples before the worker reads them
- does not let event retention bypass recent capture provenance and bounded pin cleanup
- pins race metadata and dependency revisions from one committed snapshot
- reclaims an abandoned compute lease and publishes only once across upload retries
- expires pending captures without preparing facts and releases their pins
- terminalizes a corrupt capture without publishing or retrying it forever
- retains the existing scoring-input size bound for durable request metadata
- yields oversized input preparation and resumes to the exact event result
- \n
- collects old completed capture inputs without releasing pending capture pins
- runs bounded fact collection through the worker and can reconstruct a later capture
- scores Hitchhike v3 from captured inputs without writing live checkpoints
- rejects a corrupt ${corruption} instead of signing a wrong summary
- reuses prepared scoring inputs across event captures without reloading immutable history
- reuses event-window samples after an unrelated same-day upload
- shares prepared facts between different uploaders in a connected race

### test/integration/durable-stage-capture.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/durable-stage-capture.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- bounded durable warm scoring stages
- a warm directed graph still yields arithmetic work and resumes from completed stages
- a serialized late join keeps the canonical base cutoff under a floor-sensitive incoming Leech
- resumes a warm arithmetic cursor after losing its lease without replaying completed operations
- checkpoints exceptional historical fractional multipliers in exact legacy row order
- deleting an account detaches one score owner and reclaims scratch points in bounded worker passes
- does not publish a plausible but wrong score when an accepted transfer checkpoint disappears
- rejects ${corruption} corruption of a persisted multiplier point
- retains per-segment rounding, umbrella masking, and signed global boosts
- sums signed Hitchhike copies before flooring and keeps copied steps drainable

### test/integration/global-event-capture-fact-reuse.test.js

Disposition: retire old capture/worker behavior, preserve original source under
`docs/retired-event-recap-tests/integration/global-event-capture-fact-reuse.test.js`. Replacement: simple
save-once HTTP tests plus complete absence of journaling/worker jobs.

- global-event durable fact reuse contract
- cold capture reads its directed historical dependencies exactly once
- reports actual physical candidates separately from logical facts and durable version reuse
- a second uploader reuses unchanged dependencies and prepares only its newly required leaf
- retains shared facts when the next uploader reaches a fresh worker
- ignores a nondependency's outside-window mutation without replaying the historical graph
- reuses a real dependency after both distant and same-day outside-window uploads
- keeps warm-read work flat as sequential uploaders introduce one new directed leaf
- prepares shared fact versions once when one sync captures multiple race impacts
- reuses wider prepared roots when a later capture needs only a narrower race window
- extends earlier coverage for required users without leaking it into narrower artifacts
- never treats in-range facts as coverage of a disjoint event window
- does not invent coverage for the populated gap between disjoint fills
- does not invalidate directed inputs when an irrelevant participant's generation changes
- captures a relevant competing source's changed facts and their actual score consequence
- coalesces concurrent cold captures sharing a directed leaf across independent race fences
- does not grow directed membership when a distant retained edge is added
- adds an actually relevant competing source without replaying retained roots
- does not invalidate retained facts when a distant edge is removed
- excludes a formerly required victim after its actual dependency edge is removed
- pins facts and root revisions from one committed snapshot across a held dependency transaction
- does not publish facts or pins from an intake transaction that rolls back
- retains accepted immutable inputs when artifact publication rolls back and retries safely
- does not hydrate again when the client retries the same accepted sync
- never reuses facts across unrelated user identities
- does not turn ordinary dependency syncs into capture hydration

## Final mixed-suite disposition and added coverage

- `local-global-step-event-entitlements`: all actual scoring, timezone, notification, enrollment and cache assertions retained. Only obsolete membership metadata removed; retention explicitly no longer waits for recap settlement. Two-race score200vs100 retained; recap now real POST returns200extra across2races.
- `active-impact-home-summary-cache`: unchanged Redis cold/warm, miss invalidation, Redis outage and DEL-breaker assertions. All-zero/mixed-net-zero now suppressed (approved policy); negative creation changed to positive250 with actual POST finalization.
- `postgresql-coordinated-optimization-public-pipeline`: score2400, placements, notification schedule/release/provider/Inbox, race completion and immutable sync replay retained. Replace worker ticks with one saved recap from contiguous legacy HTTPsync; replay checks same output count.
- `resolved-impact-events-v2`: all active-effect score/rollback/ownership assertions untouched. Only final global recap-zero case adopts permanent suppression instead of allowing a later mixed-zero vector.
- `home-open-capacity-session` and `redis-cache-efficiency-writers`: obsolete work fixture becomes constantzero and savedrecap fixture; all actual HTTPnormalraceworker/session/ack/cachemarker assertions remain.
- `global-event-enrollment-query`, its fixture harness, `query-efficiency-enrollment`, `race-resolution-planning-input-reuse`, `seeded-signup-recovery`: removed only obsolete summaryAttributionVersion fixture fields. All active enrollment/scoring assertions retained.
- `homeOpenProfile`: old receipt polling/fanout tests explicitly replaced with zero summarypolls/zero extraHomefetch; all ordinary resolution/session/fallback/deadline tests retained. Obsolete summaryscan/recovery metrics removed from the sharedloadgate; other capacityacceptance gates unchanged.
- `global-event-summary-expiry-v2`: original retained unchanged below. Its final two mixed settlement cases extracted to `event-recap-settlement-compat.test.js`: COMPLETED/winner/placement/200actualsteps/payout10/coins+10 all preserved. Frozen recapvector assertion changes only when missing membership is repaired by ordinary settlement; existing membership still identical. Original legacyHomecapability/expiry/ack assertions covered in simple-event-recap public tests. Every other case exercises the retired capturecounterfactual/scheduler, whose immutable-copy/concurrency/input ownership replacement is save-once caller-only HTTP. Leech/Hitchhike actualscoring remains actively covered by unchanged buff-stacking-event-scoring and race-resolution-planning-input-reuse suites, not the retired recap attribution50.
- Root-owned mixed end-burst/recovery disposition: see `simple-event-recap-mixed-test-disposition.md`.

### global-event-summary-v1-candidates.test.js

Original source: `docs/retired-event-recap-tests/integration/global-event-summary-v1-candidates.test.js`. Each title retired/replaced as described above:

- finds one eligible group among thousands of fenced historical groups
- leaves groups with pending impacts untouched
- uses the entitlement end time for local events
- durably fences all-zero groups without creating visible summaries
- creates a summary when mixed nonzero contributions sum to zero
- enforces the 100-candidate batch limit
- keeps simultaneous runners idempotent through the unique fence
- keeps the combined compatibility tick result stable
- classifies pending impacts and terminal-only groups without writing

### global-event-summary-expiry-v2.test.js

Original source: `docs/retired-event-recap-tests/integration/global-event-summary-expiry-v2.test.js`. Each title retired/replaced as described above:

- selects summary capture eligibility and event definitions in one real SQL query
- gates v2 summaries on both capabilities and returns exact expiry metadata
- omits expired, null-expiry, and attribution-v1 summaries
- serves owner-only work state and hides absent, foreign, and incapable requests
- reports active work as expired immediately after its authoritative deadline
- retries PROCESSING work after a budget release at its exact available time
- recovers PROCESSING work when readiness recovery clears its expired lease
- drains stranded PROCESSING summaries in bounded claims without stealing live leases or sending expired recaps
- claims ready summary work once with a token-fenced database lease
- exact-due lookup respects a live WAITING_RACES lease after a budget skip
- promotes pending old-worker rows but fails a final v1 row closed for a v2 event
- captures a late pending v1 race in the complete fenced vector
- fails a ready work group closed if an old worker appends a late final v1 row
- keeps acknowledgement available with the legacy impact_summaries capability
- finalizes active-race impact from the first post-boundary sync and creates one recap
- preserves boundary finalization through large-race FULL-trigger promotion
- captures cross-user Leech/Hitchhike inputs and attributes the whole-race counterfactual
- captures only the uploader
- captures only the uploader
- uses the New York fallback deadline for version-2 legacy-global events
- claims work on a qualifying scoring no-op sync with retained coverage
- does not claim summary work that appears after the capture dependency closure is locked
- allows cross-race captures with a shared scoring dependency to proceed concurrently
- keeps uploader-before-C0 ordering with a rolling old capture
- materializes and captures a missing dependency generation witness
- terminalizes capture when the uploader is no longer an accepted participant
- captures one committed dependency snapshot without waiting for an uncommitted newer input
- deletes capture artifacts and work before deleting the owning account
- permanently expires work when no qualifying sync arrives before the deadline
- reconciles captured impacts through the same C0 path for completed and cancelled races
- suppresses an all-zero vector but delivers a mixed nonzero net-zero vector
- serializes the terminal summary against a rolling old-worker impact insert
- expires summary work concurrently with its running C0 post-task without deadlock
- race expiry skips every v2-summary impact write but retains v1 settlement
- settles local-entitlement scoring without mutating captured or terminal v2 vectors

### capture-maintenance-contention.test.js

Original source: `docs/retired-event-recap-tests/integration/capture-maintenance-contention.test.js`. Each title retired/replaced as described above:

- real HTTP intake stays durable while bounded maintenance services retained populations

The retired helper drivers durableCaptureAssertions and runDurableCaptureWorker are archived unchanged with their callers. Dedicated capacity-analysis unit suites are archived unchanged; report compatibility fields remain small constant zeros, never workers or polls.
