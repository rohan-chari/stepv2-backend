# Historical raw sample cache

## Summary and approved scope

Retain older raw step samples across ordinary recent sync generations, following
the existing historical/recent scoring split. The user approved implementation
after research and explicitly allows separate entries rather than reusing sums.
PostgreSQL remains authoritative. No change to accepted late corrections,
scoring rules, endpoints, or client responses. No production deployment yet.

## Current work and expected reduction

`raceScoringPrefetch.js` batches at most 25 user ranges and 50,000 rows per page.
Its process input cache invalidates all sample history when a user generation
changes. The historical window sum cache saves calculations only after raw rows
have been loaded. A recent measured production interval returned 36,844 rows in
48 calls over 45 seconds. A seven-day numerical fixture retained 1,439 of 2,015
rows as older history; this is an illustration, not a production saving claim.

## Implementation and data contract

1. Extend authoritative scoring version state additively with a historical raw
   revision and completeness metadata. Keep defaults safe for existing rows.
   Audit intake, direct model writers, retention, and legacy generation updates.
   Classification and proof update must commit atomically with source changes.
   An unclassified generation invalidates reuse, and a later classified writer
   must invalidate historical revision before closing that proof gap.
2. Classify both old removed/replaced sample spans and new spans. Use a common
   conservative boundary at UTC midnight minus two complete days. Unknown edits
   invalidate older history. Daily-only and time-boundary revisions may preserve
   raw history only with complete proof. Keep final generation fencing intact.
3. Add separate bounded Redis entries using existing connection/prefix utilities.
   Key by immutable schema version, user, historical revision and coverage; bound
   payload, row count, TTL (initially 10 minutes), request batches and concurrency.
   Limits: 1 MiB and 20,000 rows per entry; 25-user PostgreSQL proof batches;
   four-entry Redis read batches with a 4 MiB transport ceiling; sequential
   cache publication. Reject oversized entries inside Redis before transferring
   or parsing their values. No unbounded concurrent loads.
   Validate metadata and payload before use. No Redis IO inside final write
   transactions. Redis loss, corruption, expiry or unsupported proof use existing
   bounded full PostgreSQL reads. Never publish a potentially mixed-generation
   source read as verified cache content: verify proof/generation after loading.
4. Integrate with `raceScoringPrefetch.js` worker source-read phase, preserving
   existing complete-generation process cache and bounded paging/spill behavior.
   The cached cutoff is fixed for an entry. Older rows end at/before cutoff;
   recent reads overlap from cutoff, including straddling rows whole. Preserve
   canonical ordering, exact timestamps and rounding; no split/duplicate rows.
   Rebuild for wider coverage, invalidation, or new cutoff. Reload daily rows on
   generation changes. Propagate new proof fields through planning/fingerprint
   adapters or use a safe bounded independent proof read.
5. Record hits, misses, old rows reused and recent/full rows read using existing
   observability. Preserve no-op sync behavior and avoid per-user DB round trips.

## API and frontend

No endpoints, parameters, JSON fields or errors change. Old client sync headers
continue to work. No Flutter changes or native releases are required on iOS or
Android. Frontend review confirms the contract remains unchanged.

## Compatibility and release

Migration must be additive and safe while old backend writers run. Old code may
ignore metadata; new code fails closed on incomplete proof. No feature flags.
Deployment requires a later explicit instruction and applies migration before
backend restart. Rollback leaves additive metadata in place. Cache is disposable.

## Tests first and acceptance

Write failing tests before logic. Dedicated local `_test` Postgres and loopback
Redis only. Exercise real sync HTTP, resolution worker, and returned race totals.
Prove warm recent changes reduce historical rows read with exact score parity;
older corrections/removals/moves invalidate; cutoff crossing rounds once; proof
gaps (including an old writer followed by a new writer) fail closed; concurrent
source edits cannot poison later reuse; retention deletion is detected. Cover
Redis misses/outage/malformed payload, coverage expansion and bounds. Use pure
algorithm tests for numerous boundary/order/date cases unreachable economically
through HTTP. Preserve existing assertions and report baseline failures plainly.
Run focused integration regression, frontend analysis and code review. Document
local measured reduction, migration name and deployment requirements.

## Revision log

- First gap pass: added legacy-writer carry-forward invalidation, removed-row
  classification and post-read proof validation to prevent cache poisoning.
- Second gap pass: fixed per-entry cutoff, whole straddling rows, payload bounds,
  Redis fallback, no final-transaction Redis access, and unchanged daily reads.
- Architect review: use `(historicalRevision, completeThroughGeneration,
  protectedCutoff)` proof. Writers require the previous completeness stamp to
  equal the locked generation; otherwise rotate revision before restamping.
  Protected cutoff is monotonic `max(previous, DB decision cutoff)`, and both
  removed and added rows are classified against it. Reader cutoff cannot exceed
  it. Read real proof batches before/after source loading, independently of the
  cached planning adapter; compare generation and every proof stamp before
  publishing. Proof metadata stays outside the canonical fingerprint digest.
  Redis eligibility requires the existing outside-transaction worker opt-in;
  expiry/settlement stays direct PostgreSQL and gets an explicit regression test.
- Policy resolution: the old architect role's default-off cache flag guidance
  is superseded by the user's current AGENTS.md and backend AGENTS.md prohibition
  on new flags. This implementation uses permanent proof-validated behavior.
- Frontend contract review: existing sync-v2 and progress consumers need no
  changes; `flutter analyze --no-pub` passed with no issues. Both platforms retain
  the same API contract. No native builds or uploads are part of this change.
- Architect re-review: APPROVE, no required changes remain. Explicitly exercise
  forward midnight and backward clock movement in boundary tests.
