# Completed-race snapshot repair hotfix

## Incident and fix

The September 6, 2026 timed-effect deployment added durable snapshot repair.
Live snapshots intentionally return no result for completed/cancelled races.
Publication records that as `SNAPSHOT_NOT_PUBLISHED`; the database trigger
creates a repair intent, whose consumer previously enqueued another
`DISPLAY_REFRESH` without checking race lifecycle. Twelve completed races
produced 1,350 repair records in a five-minute production sample.

The consumer now acknowledges completed/cancelled race repair intents under
its existing lease token and does not enqueue another generation. Existing
and old-worker repair records drain normally. Active-race repair, effect
deadline dispatch, scoring, snapshot publication, and notifications retain
their existing behavior. A concurrent race ending can leave one final
publication attempt; its subsequent repair is terminal. No API, schema,
configuration, feature flag, or client update is needed.

## Regression and verification

The regression uses real HTTP powerup activation, local PostgreSQL and Redis,
the real resolution/post-task workers, the database repair trigger, and three
scheduler recovery/drain cycles. Both COMPLETED and CANCELLED cases failed
before the fix: generation increased from 1 to 7. They now assert stable
generation/task count, acknowledged repair, and successful progress HTTP reads.

All 38 tests in the deadline, expiry cache, publication, index, and load
integration suites passed. These include active-race failed-publication
recovery and timed-effect behavior through existing HTTP response variants.

## Deployment and observation

Ship the reviewed code-only hotfix using the safe production reload wrapper.
Keep two HTTP workers and one worker each for resolution and cron; staging
stays stopped. No database cleanup or migration is required. Check health,
worker topology, completed-race repair creation/drain, resolution throughput,
and short-interval PostgreSQL statement activity after reload. Preserve any
pre-existing production package-lock changes.
