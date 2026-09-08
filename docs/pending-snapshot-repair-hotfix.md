# Pending-race snapshot repair hotfix

Pending races cannot publish live snapshots. Historical DISPLAY_REFRESH jobs
nevertheless created failed snapshot tasks; the database trigger generated repair
intents, and the repair drain enqueued new generations indefinitely. The previous
guard handled completed/cancelled races but omitted pending races.

The repair drain now retires historical intents for every non-active race, matching
the publisher's active-only requirement. Failure/receipt history stays intact. A
later race start atomically enqueues its own new generation; retiring an older
repair touches only that task and lease and cannot remove the start generation.
Active-race failure recovery is unchanged. No migration, runtime control, scoring
rule, API change, or iOS/Android release is required.

Regression: real resolution worker → failed publisher → PostgreSQL repair trigger
→ three scheduler/worker/post-task cycles on a pending race, followed by real HTTP
start and successful active snapshot publication. Before the code change this
failed with generation 7 instead of 1. Afterward it passes.

Validation before deployment: all 27 cases across race-effect-expiry-cache,
race-effect-expiry-publication, and read-only-race-progress integration suites
passed against a fresh dedicated local test database. Flutter analysis was clean.
Code reviewer reported no blockers and approved shipment. Full backend integration
suite was not run for this narrow hotfix.

Production verification must confirm the three incident races stay at a stable
generation while pending, outstanding repairs drain, and new failed tasks stop.
Compare actual managed-database CPU and statement deltas with traffic; do not
infer a CPU percentage from the eliminated job count.
