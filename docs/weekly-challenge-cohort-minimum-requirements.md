# Weekly Challenge Cohort Minimum Requirements

## Summary & user story

Weekly Challenge private cohorts should avoid small fields just as Daily
Challenge cohorts do. Weekly cohorts must use 50 people as the minimum target;
for example, 51 eligible users should produce one 51-person cohort rather than
two small groups.

## Scope / non-goals

In scope:

- Apply a 50-person minimum target to private seeded `WEEKLY_50K` windows.
- Preserve the existing Daily minimum of 15.
- Preserve deterministic skill ordering, friendship components, membership
  locking, legacy-stream isolation, and exact persisted race capacity.

Out of scope:

- Legacy/global weekly races, API endpoints, app UI, payouts, scoring, and
  weekly eligibility rules.
- Repacking already finalized windows.
- Post-finalization enrollment; the existing immutable-window boundary remains.

## Implementation path

- `src/modules/races/services/seededRaceBuckets.js` currently uses one
  `BUCKET_CAPACITY` value in `planBuckets`, finalization, and card fallbacks.
- Add a cadence-aware minimum helper: `DAILY` → 15 and `WEEKLY` → 50.
- Keep `planBuckets`'s default argument at 15 for existing callers/tests, and
  add an explicit minimum parameter for weekly finalization.
- Use the weekly minimum when `finalise` calls `planBuckets` and when featured
  cards need a fallback capacity. Persist each race capacity from its actual
  planned group size as today.
- No migration or endpoint change is needed.

Exact sizing formula for a minimum `m` and `n` eligible users:

- `n = 0` → no cohorts.
- `0 < n < m` → one cohort of `n`.
- `n >= m` → `floor(n / m)` cohorts, distributed as evenly as possible; the
  first `n % cohortCount` cohorts receive one extra user.
- Friendship components remain intact. If indivisible components would leave
  a trailing cohort below `m`, merge that remainder into the adjacent cohort,
  as the Daily implementation already does.

## API contract

No endpoint or JSON shape changes. Existing clients receive the same race/card
fields, with `maxParticipants` reflecting the actual planned group size. Old
clients continue using the legacy stream and are unaffected.

## Data model / migrations

No schema changes or backfill. Existing active/finalized buckets are immutable.
Only newly finalized weekly windows use the 50-person minimum.

## Frontend plan

No Flutter changes on iOS or Android. The existing participant-count and
`maxParticipants` readers already handle the larger weekly fields.

## Backward compatibility & rollout

Deploy backend first. Compatibility remains capability-based: tokenless frozen
clients stay on the legacy stream; bucket-capable clients use the same bucket
API and may see the larger persisted `maxParticipants`. No new endpoint,
required request/response field, or release flag is needed.

## Test plan

- Unit-test weekly minimum sizing at 49, 50, 51, 99, 100, 101, and a large
  production-sized roster.
- Assert Daily behavior remains 15-based.
- Assert permutation-independent, contiguous skill ordering and friendship
  component behavior under the weekly minimum.
- Integration-test a 51-person weekly finalization and persisted capacity,
  plus finalization idempotency and legacy-stream isolation.
- Run `npm run test:unit` and the seeded-race integration suite only against the
  dedicated integration database.

## Acceptance criteria / definition of done

- Weekly 49 users → one 49-person cohort.
- Weekly 50 users → one 50-person cohort.
- Weekly 51 users → one 51-person cohort.
- Weekly 101 users → 51/50.
- Daily behavior remains unchanged at 15-based sizing.
- Existing API compatibility and immutable-window behavior remain intact.
- Code review passes; no production deployment occurs in this task.

## Revision log

- Gap pass 1: made the weekly threshold cadence-specific and clarified that
  existing finalized windows are not repacked.
- Gap pass 2: specified the exact floor-and-balance formula, friendship merge
  fallback, API compatibility, and integration coverage.
- Architecture review: expanded zero-user, friendship, lifecycle, and
  capability-compatibility coverage.
