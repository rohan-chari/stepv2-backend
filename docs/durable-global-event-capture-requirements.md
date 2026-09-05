# Durable global-event capture

## Summary and authorization

The user authorized replacing repeated per-uploader history reconstruction with
durable shared scoring facts and asynchronous capture, starting with failing
integration tests. This document records the implementation contract; it is not
evidence by itself that the implementation is complete. The final acceptance
record below supersedes the chronological implementation notes later in this
document.

## Final verified acceptance

Implementation and relevant verification are complete; production deployment
and production-capacity measurement are not part of this acceptance.

- **Fresh migration chain:** all 222 migrations applied successfully to a new
  empty local test database. This change adds 14 migrations; no production or
  staging migration was run.
- **Final combined integration run:** 162 tests passed, zero failed/skipped.
  Included foundation, capture, directed scoring, stages, root budgets, snapshot
  bounds, terminal cleanup, interval reuse, legacy capture, expiry-v2, v1
  candidates, and existing Leech/Hitchhike/power-up integration contracts.
- **Tests-first evidence:** original history-reuse, warm-work budgeting,
  atomic snapshot, timestamp, corruption, and retention regressions failed
  before their corresponding fixes. Existing numeric score goldens remain;
  chronological fixture corrections were explicitly reviewed.
- **Shared immutable facts:** source triggers cover inserts/updates/deletes,
  empty versions, long spans, concurrent correction and baseline reconstruction.
  Foundation and interval tests prove version isolation and bounded collection.
- **Accepted-state consistency:** metadata and revisions share one SQL
  snapshot protected from collection; tests prove no old-metadata/new-facts
  mixture and preserve accepted preimages after later writes/deletes.
- **Durable restart/retry behavior:** real HTTP acceptance precedes scoring;
  a distinct child process prepares facts and another process resumes pending
  work. Separate fresh-process warm reuse reports zero source sample/page
  rereads. Lease-loss tests preserve completed operation counts and publication
  identity; corruption terminalizes without signing a result.
- **Bounded work:** shared budgets per claim are 16 fact pages, 32 projection
  roots (including cache hits), and 64 scoring operations. Cleanup shares one
  128-pin budget across completion/expiry/failure. Forty-day daily fallback
  uses 44 root operations and preserves exact score/missing-day semantics.
- **Artifacts and compatibility:** final artifacts retain the existing small
  schema-1 outcome/provenance envelope, not copied raw histories. Parked work
  remains an existing public state and excludes old workers until publication.
  Old-client and v1 integration paths pass; no frontend or platform API change.
- **Review:** final combined code review reports no blockers, issues or nits.
  `git diff --check` passes. Unrelated user worktree changes remain untouched.

Known limits: one-time metadata planning is separately capped at 16MiB and
O(E log E), not constant time; sample projection work can span the genuinely
required history but is resumable. Explicit account/source deletion retains
existing cascade behavior (not claimed bounded routine cleanup). Integration
timing does not certify million-user capacity or production CPU savings.
The wider reliability queue-mode assertion described below is confirmed failing
identically on unmodified baseline b70940e; it was neither weakened nor skipped.
No commit or deployment was performed by this implementation task.

## Required behavior

- A qualifying POST /steps/sync-v2 persists the upload and pins exact immutable
  scoring inputs for the summary. Return the existing 202 response and existing
  summary receipt fields. No whole-population sample hydration or counterfactual
  scoring may execute inside the HTTP transaction after baseline preparation.
- Unchanged historical facts survive worker restarts and are shared by captures
  from different users. Changes outside a captured interval must not rewrite or
  invalidate that interval. Late corrections inside the interval create a new
  version; accepted captures continue to reference their original version.
- Capture artifacts reference immutable facts instead of copying the same raw
  sample population into each artifact. Preserve exact Leech/Hitchhike scoring,
  historical effects, daily fallback, partial samples, time zones, and cutoff
  behavior. Scoring rules and user-visible results do not change.
- Workers consume durable capture requests with bounded claims, token-fenced
  leases, idempotent results, expiry, crash recovery, and bounded cleanup.
- Old artifacts remain readable and are finalized through their existing path.
  New writers must not publish artifacts that rolling old workers misinterpret.

## Original implementation and failure

`src/modules/steps/services/globalEventSummaryCapture.js` loads mutable sample,
daily, and generation rows in `loadMutableScoringFactsSnapshot`, constructs and
scores per-user artifacts in `buildArtifact`, and finalizes in
`persistCapturedSummaryImpactsForRace`. `globalEventCaptureFactCache.js` provides
only process-local reuse with a 100,000-row cap and 10-minute expiry.
`recordStepSyncV2.js` invokes capture within a 15-second intake transaction.
`src/modules/steps/jobs/globalEventSummary.js` already owns durable summary work.

The reported production window contains 40 broad reads, 2,771,160 returned rows,
and 47.52 seconds SQL duration. Those numbers do not establish the cache-miss
cause; tests must distinguish process lifetime, invalidation, eviction, bypass,
and rollback before making causal claims.

## Approved storage and implementation path

1. Add immutable per-user time-chunk fact versions and a durable manifest/root
   identifying each user's current chunk versions. Store raw precision required
   by the existing scorer; do not replace boundary-sensitive samples with daily
   sums. Updates create new versions only for affected chunks.
2. Cover all writers of step_samples and steps, including legacy endpoints,
   corrections, deletes/retention, and old binaries during migration. An atomic
   database-maintained revision/dirty record must fence unprepared inputs so
   missing coverage cannot silently become zero steps. Baseline preparation is
   resumable, bounded, and preserves changes concurrent with preparation.
3. Pin the input roots plus topology/effect/event snapshots at accepted capture
   time in one consistent statement/transaction boundary. A bare reference to
   mutable current rows or to a generation with no retained facts is invalid.
4. Add durable asynchronous capture work, integrate its consumer into the existing
   summary worker lifecycle, and retain request state through worker failure.
   Coalesce shared computation only when versions, windows and semantics match.
5. Store a small per-user outcome and references after scoring. Integrity checks
   verify referenced content and request provenance. Do not impose new HTTP
   response fields or require app releases on either iOS or Android.
6. Bound retained bytes, work per claim, and collection. Never collect data still
   referenced by a pending valid capture; account deletion must remove owned
   facts and handle other captures referencing those facts explicitly.

## Integration tests first

Use an exclusive disposable local database ending in `_test`. Exercise real
HTTP intake and the real worker entrypoint; internal cache clearing is a process
lifetime fault injection only, never a shortcut for business behavior.

- Repeated captures across cache clears/process restarts must not reload all
  unchanged dependencies. Assert physical SQL rows as well as exact results.
- Changes to one uploader or one dependency reload only affected time chunks.
- Mutations outside the requested window preserve historical reuse.
- Disjoint windows, uncovered middle windows, midnight/time zones, coarse-only
  daily input and cross-boundary samples preserve the existing results.
- Return 202 with durable capture pending before computation; pause workers,
  modify dependencies/topology, then resume and prove the pinned result is stable.
- Crash after intake commit and during scoring; restart another worker and prove
  exactly one durable result with no loss or duplicate summary.
- Concurrent shared dependencies, rollback before/after pin, failed SQL,
  out-of-order versions, expiry during scoring, deletion, and retention.
- Legacy artifacts and rolling producer/consumer versions remain safe.
- Large connected races: measure SQL rows, artifact bytes, queue work, and
  changed-chunk writes across increasing history and population sizes. Do not
  equate test timing with production CPU capacity.

## Scope and acceptance

No client UI changes, scoring changes, capacity changes, or production deployment
in this implementation task. Full completion requires durable fact maintenance,
reference artifacts, asynchronous bounded workers, safe migration/compatibility,
passing behavioral integration regressions and code review. A repaired local
cache alone does not satisfy this design.

## Architect decisions for implementation

- Use immutable per-user UTC-day fact chunks and transactionally maintained
  per-chunk revision heads. Database triggers on both source tables journal OLD
  and NEW scoring facts and advance the affected chunk revision atomically;
  scoring-neutral metadata updates must not create a new scoring revision.
- Pin all chunk roots using one INSERT/SELECT snapshot, explicitly representing
  revision-zero unprepared/empty chunks. Asynchronous cold reconstruction uses
  current source rows and inverse journal mutations newer than the pinned root
  within one MVCC statement; it must never combine separate current/journal
  snapshots. Prepared roots are shared durable immutable content, not cache-only.
- Root revisions cover the relevant time chunks rather than a global per-user
  generation. Cross-midnight source samples must remain exact, deduplicated and
  discoverable even when they begin before the requested day.
- Keep pending captures in a separate table/state that old summary consumers
  cannot claim. The old consumer rejects non-schema-1 artifacts. Publish only
  a legacy-compatible final outcome envelope into that consumer's path once
  scoring is complete; immutable references live in additive storage.
- Journal collection must respect unresolved pinned roots, including roots not
  yet materialized. Bounded preparation/compaction prevents lifetime journal
  scans on an active user. These are required completion criteria.
- Park public work as QUEUED with lease token `capture:<request UUID>` and
  leaseUntil/nextRecoveryAt equal to expiresAt. The separate request owns its
  independently expiring compute lease. Publication must atomically compare
  that lease, the parked work token/state, and the database deadline before
  releasing work into the existing schema-1 consumer. Expose no new public state.
- Count durable payload bytes and scoring work separately from source SQL rows.
  Add reusable prepared scorer inputs with exact fact/window/effect/topology and
  scorer-version keys; whole-result keys additionally contain the uploader.
  Day revision changes outside a requested interval require journal overlap
  checks or projection reuse, not unconditional interval invalidation.

## Revision log

- Gap pass 1: added legacy writers, concurrent baseline preparation, retention,
  and explicit consistent pinning instead of trusting generation numbers alone.
- Gap pass 2: added rolling old-consumer behavior, deletion of shared inputs,
  bounded storage/cleanup and a prohibition on substituting a cache-only fix.

## Implementation evidence and remaining gates

- HTTP/worker tests now prove deferred publication, accepted-version scoring
  after a later correction, and expiry without fact hydration or leaked pins.
- A new regression initially read 450 durable fact bytes for unchanged inputs.
  It now reads zero by persisting per-user sample-window/daily query answers,
  while a different event multiplier still produces its own correct outcome.
  The scope key contains immutable root IDs, input window bounds, and an input
  semantics version. This is not yet evidence for all connected-race shapes.
- Foundation review found that pinning shared roots with an UPDATE serializes
  otherwise independent uploaders. The implementation now pins without updating
  existing roots. Bounded preparation and staged eviction are implemented;
  foundation-agent verification reported 21 passing tests on a freshly migrated
  isolated database. Final combined review remains required.
- The existing fact-reuse integration suite currently has 19 failures: most
  assume synchronous artifact publication and embedded raw facts; the rollback
  injection also targets the former inline artifact write. Preserve their
  mathematical/data-integrity assertions when adapting the worker driver and
  pinned-reference inspection. Do not count the new focused green tests as
  full regression coverage.
- Focused tests now cover prepared-input retention, corruption validation and
  same-day out-of-window reuse. Bounded warm scoring, the legacy contract
  migration, and final combined code review remain required.

### Paged consumer verification

The latest parent run passes 30 focused HTTP/worker integration tests on the
dedicated `capture_paged_20260905_test` database: 16 asynchronous-capture cases,
five directed-dependency cases, and nine interval-reuse cases. This database
was initially migrated from empty and received subsequent migrations; a fresh
final migration-chain verification is still required.
The 600-source-row regression failed before paged preparation and now proves
yield-and-resume with the exact 200-step event delta. Two fault-injection tests
initially published results from corrupt prepared answers/cursors; both now
terminalize without artifact publication after checksum and cursor validation.
Tests drive repeated real worker claims instead of assuming one tick finishes
all work. Existing score assertions remain unchanged.

Terminal-request/derived-data cleanup and abandoned-lease recovery have focused
passing tests. Outstanding review blockers include bounded warm whole-race
scoring (page budgets only bound fact reads), mid-compute lease loss under large
graphs, and the existing legacy regression suite's synchronous driver/embedded-
payload assumptions. These focused passes do not establish readiness to deploy
or production CPU improvement.

### Physical-work telemetry regression

A real HTTP intake followed by real worker claims initially failed because
source preparation emitted no source-row metrics. It now verifies sample,
daily, and journal counts against the persisted preparation counters, as well
as independently nonzero immutable bytes consumed. Instrumentation records the
SQL function's per-invocation work immediately after its result, not lifetime
root totals. Source counts include examined candidate rows even if interval
filtering omits them from the immutable payload; they must not be equated with
unique retained facts. Journal counts are separate from mutable source rows.
The scoped code review found no blockers. The regression additionally resets
telemetry and retries the same published HTTP upload: it proves the artifact
identity remains unchanged and no source/journal/page observations recur.
Candidate counters are not disk reads or all PostgreSQL tuples examined, and
cannot count failed SQL statements that return no work result.

Additional existing HTTP integration verification passes 23 cases across
Hitchhike settlement parity, Leech sample granularity, power-up batch/Leech/
X-ray, and Hitchhike/Quick Rinse suites. This covers current canonical scorer
extractions, not the still-unfinished resumable stage implementation.

### Legacy integration contract migration

The reviewer mapped every legacy scenario before adaptation. Tests must use
HTTP acceptance followed by real worker completion and independently inspect
pinned facts, without fabricating raw arrays on the published artifact. Keep
all unchanged-fixture numeric score goldens. Enumerate directed dependencies
independently of the production planner. Preserve irrelevant mutations as
negative cases and add relevant dependency mutations. Preserve both atomicity
boundaries: intake failure rolls back upload/request/pins; publication failure
after accepted intake retries without undoing accepted source data. Replace
obsolete process-cache/generation counts with actual physical preparation and
durable reuse assertions, never missing-metric defaults that make budgets pass.

### Accepted snapshot regression and fix

The consistency review confirmed that the race-resolution queue fence does
not exclude every production metadata writer (power-up changes and checkpoint
updates use other locks). A new real-HTTP concurrency regression holds the
input-retention fence, commits an effect/dependency-source change together,
and resumes capture. It initially failed because the accepted context contained
the old effect while its dependency roots represented the later source state.
The intake now acquires the shared retention fence before selecting all mutable
metadata and the dependency revision vector in one SQL snapshot, then pins
that saved vector without rereading mutable heads. The concurrency regression
now passes. Merely adding a race-row lock would have been insufficient.

The subsequent parent run passes 32 cases (18 asynchronous capture, five
directed dependencies, nine interval reuse). Review caught bare timestamp
serialization in checkpoint JSON; explicit UTC timestamp assertions failed in
an America/New_York test process and now pass after formatting every captured
checkpoint timestamp as ISO UTC, preserving nulls and bigint precision.

The parent integrated the resumable scorer into the existing worker, sharing
its 64-operation and 16-page budgets across race impacts and treating lease
loss as a non-publishing exit. The warm-graph yield/resume regression passed
its first parent run. Stage retention/account deletion and broader scorer
parity are still under active verification; this is not a completion claim.

### Wider summary contract verification

The existing expiry-v2 HTTP suite now passes all 32 cases. Its driver waits for
real asynchronous capture publication; raw-fact assertions independently read
pinned references through a test-only SQL oracle. QUEUED assertions remain at
the intake boundary, before worker advancement. Exact 50/1000 score goldens
remain unchanged. Review confirmed the fixture's default joinedAt=now was
inconsistent with its intended pre-event participation; createRace now stamps
joinedAt=race.startedAt. Explicit late-join scoring remains separately covered
by the stage integration regression.

One wider reliability test, `merges a concurrent STEP_SYNC queue reason and
scopes with global-event activation`, expects IMMEDIATE but observes COALESCE.
The identical failure was reproduced in a detached temporary worktree of
unmodified committed baseline b70940e against the same isolated test database.
The assertion and unrelated queue behavior have not been changed or skipped;
this pre-existing failure must be reported separately from this implementation.

### Fresh migration-chain and combined integration evidence

A new empty isolated database, `capture_final_20260905_test`, applied all 222
migrations successfully. The subsequent combined run passed 127/127 integration
tests across fact foundation, interval reuse, snapshot bounds, terminal cleanup,
directed dependencies, asynchronous capture, scoring stages, legacy fact reuse,
and expiry-v2 summary behavior. No production or staging database was used.

Cleanup review now accepts the shared 128-pin budget across an entire worker
pass, including completed-owner cleanup, new expiry and new failure. An indexed
release queue schedules completed owners at completed_at+30days and failed or
expired owners immediately. Event retention excludes durable request owners
until this lifecycle retires them. The regression first deleted a recent
capture prematurely, then passed with pins/artifact preserved and eventual
normal event cleanup verified after capture retention.

The 127-test run preceded the long-history cached-root budget fix. Its new
regression subsequently passed in a 45-case parent run including asynchronous
capture and legacy reuse. A checksummed aggregate cursor now charges cached
root hits against a shared 32-root budget and resumes without completed-prefix
replay. Code review found no blocker in that fix. Daily exact-date aggregation
now selects only matching day roots, avoiding quadratic empty lookups. Its
selected-root cursor uses a distinct v4 namespace so earlier full-vector
progress cannot be reinterpreted.

A further real-HTTP integration case launches two distinct Node worker
processes, rather than merely clearing a process cache. The first prepares the
inputs; the second scores a new accepted capture with the exact same 200-step
result, no source sample reads and no immutable fact-page reads. The helper
rejects non-local/non-test databases before importing app modules and disables
external Redis access.
