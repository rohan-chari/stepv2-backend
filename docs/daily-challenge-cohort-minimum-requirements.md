# Daily Challenge Cohort Minimum Requirements

## Summary & user story

Daily Challenge private cohorts should avoid small fields. A player joining a
Daily Challenge must be placed into an existing cohort that can grow beyond the
15-person target before a new undersized cohort is created. For a daily roster
of 16, the desired result is one cohort of 16; for 31, two cohorts of 15 and 16.

## Scope / non-goals

In scope:

- Change private seeded Daily/Weekly cohort planning to use 15 as a minimum
  target rather than a hard maximum.
- Preserve deterministic ordering, friendship components, skill matching, and
  the durable per-window membership ledger.
- Keep late joiners in an existing cohort where possible.

Out of scope:

- Changes to legacy/global seeded races.
- Changes to payout, scoring, race duration, API payloads, or app UI.
- Changes to weekly-vs-daily eligibility or inactivity pruning.
- Repacking cohorts after a window has been finalized; finalized bucket identity
  and memberships remain immutable.

## Current implementation and exact implementation path

- `src/modules/races/services/seededRaceBuckets.js` owns `BUCKET_CAPACITY`,
  `planBuckets`, late assignment, and finalization.
- `planBuckets` currently caps every bucket at 15 and rebalances a trailing
  singleton, which produces 8/8 for 16–? edge cases such as the currently
  observed 8-person cohorts.
- `finalise` persists the plan into `seeded_race_buckets`,
  `seeded_race_bucket_assignments`, and `race_participants`.
- The frontend has no contract change: old and new clients continue to receive
  the same race fields and private bucket capability behavior.

Implementation:

1. Add a pure deterministic sizing helper in `seededRaceBuckets.js`.
2. Define the exact planner formula: `cohortCount = 1` for 1–14 users;
   otherwise `cohortCount = floor(userCount / 15)`. Distribute users as evenly
   as possible across that count, with the first `userCount % cohortCount`
   groups receiving one extra user. Thus 16/23 remain one group, 31 is 16/15,
   46 is 16/15/15, and 616 is 40×15 plus 1×16 across 41 groups.
3. Permit the resulting cohort size to exceed 15 and stamp each generated
   `Race.maxParticipants` to that group’s exact planned size. Leaving it at 15
   would make a planned 16-person cohort impossible to populate.
4. Keep the immutable-window rule: users joining after finalization are not
   added to an already-running private cohort. The minimum-size policy applies
   while the upcoming window is elected/finalized; pre-finalization arrivals
   must be included in that final plan rather than stranded in a new tiny race.
5. Update tests first, including 1–15, 16, 23, 30, 31, 46, 616,
   permutation independence, friendship components, and the pre-finalization
   election boundary.

## API contract

No endpoint or JSON shape changes. Existing clients continue to call the same
seeded race endpoints and receive the same fields. This is backend-only,
additive behavior at the data-placement layer, so frozen clients are unaffected.

## Data model / migrations

No schema migration. Existing rows are historical and immutable. New bucket
rows may contain more than 15 assignments, so the implementation must verify
that `Race.maxParticipants` and any creation validation do not reject the new
planned size. No production data rewrite is required.

## Frontend plan

No Flutter changes on iOS or Android. The existing race list/detail rendering
must continue to handle the same fields and arbitrary participant counts.

## Backward compatibility & rollout

Deploy backend first. Old app builds continue using the legacy stream unless
they support the existing seeded-bucket capability; supported clients see the
same API shape. No release flag or temporary runtime control is needed.

Existing active/finalized cohorts are not repacked. The new algorithm applies
to newly finalized windows and future late assignments only.

## Test plan

Tests are written before implementation in `test/services/seededRaceBuckets.test.js`:

- Pure planner sizing and deterministic/permutation-independent output.
- No cohort below 15 when the roster has at least 15 people.
- A 16-person roster remains one cohort of 16.
- A 31-person roster becomes 15/16, and a 46-person roster becomes 15/15/16.
- Existing friendship and skill-band behavior remains intact.
- Finalization/pre-finalization reconciliation does not create a new undersized
  cohort, and each generated race has capacity for its full planned group.
- Existing assertions remain unchanged except where their expected old
  hard-cap behavior directly contradicts this approved requirement.

## Acceptance criteria / definition of done

- No newly planned Daily/Weekly cohort is below 15 when at least 15 eligible
  users exist.
- 16 eligible users produce one 16-person cohort.
- 616 eligible users produce 41 cohorts: 40 of 15 and 1 of 16, rather than 42
  cohorts containing 8-person groups.
- Each generated race’s `maxParticipants` equals its planned group size.
- Existing active/finalized cohorts remain unchanged; post-finalization joins
  retain the existing immutable-window behavior.
- Backend unit/integration tests and `npm run test:unit` pass; no test uses the
  production database.
- `code-reviewer` reviews the final diff.
- No production deploy is performed in this task; the result is reported as
  ready to deploy only after verification.

## Revision log

- Gap pass 1: clarified that 15 is a minimum target, not a literal maximum;
  added 16/31/46 sizing examples and late-assignment behavior.
- Gap pass 2: clarified that existing finalized cohorts are immutable, no API
  or migration changes are needed, and race participant capacity must be
  checked before implementation.
- Architect review: required exact sizing formula, dynamic race/card capacity,
  explicit immutable-window boundary, and integration coverage for persisted
  capacity; all folded into this revision.
- Code review pass 1: required contiguous skill-aware packing instead of
  round-robin mixing, explicit 616-user and friendship-component coverage, and
  deterministic handling when indivisible friendship components would leave a
  short remainder; all folded into the implementation and tests.
