# Queue convergence correction and comparison — 2026-09-07

## Change

The queue could discard the first pending uploader's participant ID while another
claim was RUNNING, then retain a later uploader's ID. The planner accepted that
nonempty but incomplete scope. The authoritative input was saved, yet a successful
follow-up claim could leave a participant's persisted score stale.

Both pending participant and powerup scopes now use the same RUNNING-state rule
as dirty reasons. Source-input dependency planning also requires coverage of every
triggering user who is an accepted race participant. An incomplete envelope left
by an older writer takes the existing full-computation fallback.

This repairs future processing and already-queued incomplete envelopes. It does
not automatically revisit previously SUCCEEDED jobs with stale projections.
Any production recovery for those rows needs a separately reviewed operation.

## Publication finding

A newer generation arriving before or during publication can invalidate the
publication fence. Without proof of a newer successful publication, the existing
worker records a terminal failure. That historical record must remain truthful.

The change adds `SNAPSHOT_GENERATION_ADVANCED` only for an observed generation
fence rejection. Generic Redis/write/lock failures retain
`SNAPSHOT_NOT_PUBLISHED`. The projection API still returns a boolean. Tasks retain
`failed_no_retry`, their original attempt identity, and notification handling.
No attempted publication is requeued or repeated. A newer successful publication
can cover the older failure operationally; it does not make that old attempt
successful. Classification is retained on live tasks, not in compacted receipts.

An attempted design that reset a task to pending was rejected before implementation:
older workers could execute it again, and an indefinitely failing replacement
could leave an unbounded polling obligation. No such retry behavior ships.

This publication change is diagnostic. It does not improve publication throughput
or repair a failed latest-generation publication.

## Validation

- Two real HTTP/DB score regressions failed against the original source with a
  persisted score of 50 instead of 61, then passed after the correction.
- Tests cover HTTP uploads during a running claim and an incomplete envelope
  left by an older writer. Persisted scores are checked before public reads.
- Publication integration cases advance input before publication and after real
  Redis writes. They check the terminal failure, no repeated writes, unchanged
  attempt ID, successful newer publication, and final persisted/public scores.
- An injected Redis write rejection without newer input retains the generic error.
- 10 integration checks and 131 targeted existing contract checks pass (141 total).
- Required code review found no implementation blockers; its requested negative
  classification test was added and passed.
- No frontend changes: Flutter analysis/builds were not run. No API/schema change,
  new required request field, release flag, or client-version dependency.

## Experiment protocol

The original scaling evidence remains unchanged in the sibling investigation
worktree. Its frozen integration harness SHA-256 is
`173fa17e56c57ac4ad9eadfe20dad10ae7394b316150048c5f308fe3e4ed27f2`.

A separate experimental checkout of fix commit `6444cc4` raises only the local
worker cap to 20. The shipping fix keeps the cap at 5; production remains at
concurrency 3 with exactly two HTTP workers. Shared staging was not started.

All tests use local `steps-tracker-integration_test` and dedicated Redis port
16387. The comparison uses 1,000 synthetic users, 117 mixed-size races, 3,000
memberships, 24 closed step samples per user, the same effect fixture, two HTTP
processes, and one resolution process. The frozen harness checks every persisted
participant and samples two public progress responses after draining each stage.

The comparison visits concurrency 3, 20, 1, 15, 2, 10, 4, 5, each with a prepared
burst and 20-second offered-rate stages at 16, 64, and 256 uploads/second. Cases
run sequentially. A separate read-only query captures whether each failed
publication has a strictly newer successful publication before the next reset.
The original assertion requiring zero terminal failures is not weakened.

This is one comparison sweep, not a production capacity certification or a repeat
of the earlier full 61-case investigation. Local hardware, data history, fixture
mix, and short stage duration limit extrapolation to production user counts.

An initial scope-only calibration at concurrency 3 (2, 8, 32 uploads/second)
passed all 3,000 persisted-score checks in every drained stage. The latter two
stages still failed the zero-terminal-failures assertion (5 and 27 historical
publication failures respectively). Its raw result is preserved separately.

Publication coverage is measured at the final evidence capture, after drain and
public verification. It does not establish uninterrupted freshness during input
or inspect every race's current Redis entry. Performance values for settled
requests include the stage and its drain; unresolved requests must be reported
separately. A single run does not establish a precise ordering between nearby
concurrency settings.

The existing five-second ingestion debounce remains enabled throughout this
comparison. Roughly six-second low-concurrency p95 values therefore include
intentional batching delay; they are not six seconds of scoring CPU time.
Increasing concurrency does not remove that delay.

## Completed comparison

All eight prepared bursts passed. Of 24 continuing-input stages, 22 received
the full offered workload and ran the complete oracle: their score, public
response, and placement checks passed. Their zero-terminal-failures assertion
remains red. The other two stages were overload cases and skipped the complete
oracle; sampled convergence must not be substituted for that missing check.

Across the sweep, 49,818 of 53,760 planned measured uploads were accepted,
2,312 were not issued by the bounded generator, and 1,630 returned HTTP 500.
An additional 8,000 accepted uploads prepared the burst fixtures.

| Concurrency | Burst jobs/s | Burst drain, s | 256/s score p95, s | 256/s accepted / planned | Full oracle at 256/s |
|---:|---:|---:|---:|---:|:---|
| 1 | 34.7 | 5.65 | 5.92 | 5120 / 5120 | Yes |
| 2 | 47.4 | 4.61 | 6.25 | 5120 / 5120 | Yes |
| 3 | 59.8 | 4.01 | 6.00 | 5120 / 5120 | Yes |
| 4 | 47.8 | 4.67 | 12.54 | 5120 / 5120 | Yes |
| 5 | 50.1 | 4.58 | 7.69 | 4978 / 5120 | No — overload |
| 10 | 72.7 | 3.49 | 8.13 | 5120 / 5120 | Yes |
| 15 | 79.2 | 3.48 | 22.50 | 1320 / 5120 | No — overload |
| 20 | 82.9 | 3.45 | 18.11 | 5120 / 5120 | Yes |

Concurrency 5 dropped 142 generator requests at 256/s. Concurrency 15 dropped
2,170 and returned 1,630 HTTP 500 responses (generic internal-error payloads,
commonly around two seconds). These failures remain unresolved as an overload
finding; this patch does not repair the intake overload path. Their p95 values
exclude rejected/unissued work and are not equivalent-load comparisons.

The concurrency 3 versus 20 cases did receive all planned input. Their p95
request-to-score delay was 6.005 versus 18.110 seconds at 256/s. The stage plus
drain recorded 47 versus 869 superseded discards. Concurrency 20 also had eight
failed core attempts that later recovered, and up to 28 waiting worker-pool
acquisitions versus zero at concurrency 3. This supports targeting discarded
recomputation and contention before raising production concurrency.

There were 1,169 historical publication failures across all cases. Every one was
classified as a generation-advance rejection and had a strictly newer successful
publication at final capture. None was relabeled successful or replayed. This
explains the remaining historical-failure assertion without claiming continuously
fresh publication or correcting a failed newest-generation publication.

The burst curve has run-to-run variability (notably concurrency 4). This one
sweep does not prove that 4 is intrinsically worse than 3 or establish an exact
production ceiling. The correction is primarily a correctness fix; these data
do not establish a throughput improvement. Retain production concurrency 3
pending targeted recomputation/slot-refill work and longer, production-like
validation. Already-SUCCEEDED stale rows require separate recovery planning.

[Comparison chart](queue-fix-comparison-2026-09-07/comparison.png),
[PDF](queue-fix-comparison-2026-09-07/comparison.pdf),
[CSV](queue-fix-comparison-2026-09-07/comparison.csv), and
[JSON summary](queue-fix-comparison-2026-09-07/summary.json).

Raw per-process logs, frozen harness, per-case results, and publication-coverage
queries are retained in the local `stepv2-queue-fix-scaling` worktree under
`artifacts/queue-fix-comparison/`. The original baseline and initial calibration
remain intact in their respective worktrees. No production deployment, database
write, or shared-staging start was performed. The test database retains the last
synthetic fixture; owned experiment workers and dedicated Redis are stopped.
