# Race progress reads do not schedule scoring

Opening or refreshing progress/bootstrap returns committed scores and box state.
Production HTTP never schedules DISPLAY_REFRESH or POWERUP_GATE_REPAIR from
these endpoints, never waits for a scoring job, and never replays step samples
for leaderboard or box progress. Missing/expired Redis snapshots fall back to
stored participant totals. Step intake, score-changing mutations, timed effects,
and background recovery continue to use the resolution queue.

The queue stores its canonical box-award input in the nullable
`race_participants.box_progress_steps` column, within the same fenced transaction
as scores and awards. This is not the high-watered `raw_steps` value: downward
corrections must move the countdown correctly. The worker also initializes
unarmed/malformed gates during FULL processing, without retroactive box awards;
a first sync initializes the next threshold and a later crossing awards a box.

## Compatibility and rollout

Migration `20260908033000_committed_box_progress` only adds a nullable integer
column. Apply it before starting the new generated Prisma client/workers. No
frontend release or new request fields are required; existing iOS and Android
response shapes remain unchanged. Recent-mint notifications still use the
existing Redis consumption path.

Existing participants with null box progress temporarily see a full interval
until their next queue processing. Reads do not manufacture a backfill job.
Historical durable refresh/repair intents still drain through background
recovery. The retained injected/nonproduction replay test seam is unchanged;
production HTTP integration tests exercise the new contract explicitly.

One separate display calculation remains: an owner's active Piggy Bank counter
sums steps for its effect window on GET. It does not recalculate race scores or
queue work. This change does not claim every display field is precomputed.
The internal legacy STEP_SYNC_COMMITTED shortcut still derives box input from
raw_steps; current HTTP step producers use STEP_INPUT_CHANGED and do not take
that shortcut. Do not reconnect an HTTP producer to it without canonical box
input and correction/calendar coverage.

## Measurements

Same local HTTP/worker/post-task harness as the previous snapshot-lane fix,
real PostgreSQL 18 behind transaction-pooled PgBouncer, isolated Redis:

| Participants | Previous stale / repeated | Read-only stale / repeated |
| --- | ---: | ---: |
| 10 | 60 / 60 | 19 / 19 |
| 100 | 60 / 60 | 19 / 20 |

Counts are SQL client calls for the entire measured cycle, including harness
lookups. Candidate cycles create zero scoring attempts and read zero step-source
queries in these fixtures. Fresh cycles use 14–15 calls. Asynchronous timing can
move a call across windows. These are query-volume measurements, not CPU
attribution or proof of the production 70% idle target.

## Validation

Tests were written and observed failing before the read-path implementation:
cold/expired reads created scoring jobs. The box-before-GET scenario then exposed
uninitialized gates in FULL processing; that worker issue was fixed and tested.

84 focused integration cases pass across the final applicable runs:

- read-only production progress/bootstrap: 2;
- bootstrap queue-state contract: 11;
- repeated display benchmark and snapshot receipt/delivery invariants: 5;
- effect-expiry/cache compatibility, including historical intent recovery: 15;
- real worker raw-step parity and single-writer/debounce/handoff invariants: 51.

The production ownership policy test also passes. Tests cover real HTTP step
intake, box awards before any GET, downward corrections, viewer timezone changes,
Redis-off reads, cold/expired cache, old client and paged/compact bootstrap
requests, and preservation of every existing queue-row field and xmin.

Obsolete assertions requiring GET to enqueue work were explicitly surfaced and
changed to the requested read-only contract. Historical intent recovery tests
now seed an old-release intent rather than expecting a new GET to create one.
Initial regression failures were those obsolete expectations; a subsequent new
fixture omitted required requestedAt and was corrected before its passing rerun.
The full repository suite is not claimed green; previously established unrelated
baseline failures are recorded in snapshot-lane-query-efficiency.md.

Code reviewer approved the final diff. Production has not been changed by this
work. A fresh deploy approval is required for the additive migration and restart,
followed by managed-database CPU and pg_stat_statements delta monitoring.
