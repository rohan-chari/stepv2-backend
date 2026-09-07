# Race resolution input reuse

Scope: reduce repeated PostgreSQL work during step intake and queued race
resolution while preserving scores, timed effects, durable work and older apps.
Baseline: `ba6149d3e25307a5663fac0e2dde373b70917872`.

## Implementation

1. Round cached history coverage starts down to a UTC day so races with different
   start/join minutes can reuse the same user's immutable input generation.
   Calculation windows remain exact. A new source generation or uncovered range
   requires a fresh read. Reuse is process-local, bounded by the existing cache's
   size/row limits and TTL; it is not a promise of one read across every process,
   restart, eviction, or arbitrary race history window.
2. Reuse the protected planning snapshot for race/roster, effect and event inputs.
   The write transaction still reads a fresh fingerprint. Historical modifiers
   are included in that protection; expired Leech/Hitchhike links retain their
   dependency-graph semantics. The adapter retains the worker's captured-write
   model so scoring cannot bypass the commit fence. Fingerprint schema 4 causes
   older derived artifacts to fall back to recomputation.
3. Compare incoming samples with the already-read, locked stored snapshot.
   Submit only changed tuples in mixed batches. Preserve all retained windows
   for overlap cleanup, including when cleanup needs a DELETE without INSERTs.
   PostgreSQL also compares every mutable field with `IS DISTINCT FROM`.
   Existing participant-result no-op suppression, required bonus/accounting,
   effect publication and durable queue acknowledgements remain in place.

No API, database migration, client requirement, scoring rule, release flag or
process-capacity change. Existing iOS and Android versions use identical request
and response contracts. No Flutter files changed.

## Test-first evidence

All integration tests use real HTTP intake/read paths, the real resolution worker
and a dedicated local PostgreSQL database. They assert persisted scores before
HTTP reads so read-side repair cannot hide a wrong worker result.

`race-resolution-memory-reuse.test.js` covers:

- one sync / three differently timed races sharing one covered history read;
- later sync invalidation and a new sync arriving between compute and commit;
- simultaneous race jobs and separate scoring windows;
- an older history range forcing a cache miss;
- duplicate effect and roster reads eliminated only inside a protected attempt;
- changed-only mixed batches, retained row versions, metadata-only updates and
  nullable source-field clearing;
- finer samples replacing overlapping coarse history without touching unrelated
  retained rows;
- DELETE-only cleanup with no insert tuples, preserving retained IDs and row versions;
- a historical timed modifier changing before commit, rejecting the stale closure
  and publishing the corrected score.

Observed red results before the corresponding implementation: two history reads
instead of one; an unchanged row's physical version changing; a duplicate effect
read; three roster reads instead of zero; no historical-effect fence rejection;
three insert tuples instead of one. The final dedicated suite passes 13/13.
The DELETE-only branch has an additional passing regression.

Existing planning-input and timed-effect expiry integration suites pass 26/26.
These retain real powerup use/expiry, steps during and after effect windows,
team/scalar scoring, and event/version invalidation coverage. The final unit suite
passes 3,353/3,353. Existing assertions were not weakened or skipped.

## Performance verification

`race-resolution-memory-profile.test.js` is a reproducible real-worker comparison:
40 users, three queued races, with zero or twelve historical effects per user per
race. It verifies every persisted score. Run the same test on baseline/candidate
against a dedicated local `*_test` database, sequentially.

Observed deterministic query counts for those three jobs:

| Work | Baseline | Candidate |
| --- | ---: | ---: |
| History batch reads | 4 | 2 |
| Compute race/roster reads | 9 | 0 |
| Compute scoring-prefetch queries | 5 | 1 |
| Total queries, no historical effects | 556 | 541 |
| Total queries, historical effects | 555 | 540 |

Mixed three-sample intake submits one changed tuple instead of three; unchanged
rows retain their physical PostgreSQL row versions. Metadata-only changes persist.

Query counts do not establish a production CPU percentage. Full historical-effect
fencing adds work to fingerprint reads, and timing must be evaluated alongside
query reduction. Preliminary local paired timings overlap and depend on concurrent
test load; no production CPU reduction is claimed from them.

## Release gates

- Compare full integration failures with the unmodified baseline, preserving all
  assertions. User explicitly permits release with proven unrelated failures;
  keep those fixes outside this change.
- Complete the performance comparison and investigate any material regression.
- Read-only code review: no remaining blockers or issues, including DELETE-only
  branch coverage.
- Commit the verified change and retain baseline/candidate test logs.
- Deployment remains a separate action. Observe comparable pre/post traffic:
  DB CPU and query time/calls, resolution queue depth/age, retry/fence rejection
  rates, worker memory and API latency. Do not interpret a post-reload lull as
  sustained savings. Preserve the authorized production process capacity.

## Baseline failure audit

The unmodified baseline full run executed 2,853 tests: 2,824 passed, 28 failed,
with one existing skipped test. It reproduced failures in query-plan expectations,
discard cap visibility, event scheduling/entitlement behavior, notifications,
onboarding, the coordinated pipeline, powerup inventory, persisted standings,
invites/leave compatibility, referral workflows, tournament behavior and the
477-player inventory-count assertion. The 477-player timing gates passed.

A standings tie-order failure not seen in that particular baseline full run was
reproduced on both baseline and candidate in an isolated comparison. A Shortcut
failure in the first candidate run was a `cleanDatabase` hook deadlock before the
behavior ran; the protected behavior test passed when rerun on both versions.

One candidate regression was found and fixed: the new roster projection included
`user.displayName` in the full artifact fingerprint. An existing test deliberately
renames a mine victim between display and commit, requiring artifact reuse plus
the current name in the feed. Presentation fields are now excluded from that
fingerprint; the existing transaction-time presentation rebinding still reads
current names. The original test passes unchanged. All scoring and membership
fields remain protected. Read-only review cleared the correction.

An additional candidate full run against the separate profile database was
abandoned: one existing CLI test requires the exact integration database name,
and concurrent suites shared local Redis. Those results are not a release gate.
The final release run uses the repository's standard integration command alone.
