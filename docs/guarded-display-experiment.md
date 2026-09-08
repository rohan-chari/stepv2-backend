# Guarded display reuse experiment — not recommended for production

September 7, 2026 EDT. This branch is an implementation experiment, not a CPU fix ready to deploy. Production was not changed.

## Implementation

A resolution worker retains up to eight committed calculations, each at most 1 MiB and valid for at most 60 seconds from computation. Only sole DISPLAY_REFRESH jobs may reuse them. Eligibility requires an active non-team race, closed samples, no scoring effects or global events, unchanged authoritative input fingerprint, same triggering users/timezone, and no crossed scoring/box midnight or race end. A restart or eviction simply falls back to FULL.

The witness is stored only after a FULL calculation commits with no participant total/bonus or effect/event writes. A hit skips canonical scoring but preserves input/generation validation under the existing write fence, box checks, placement handoff and durable snapshot/post-task publication. An upload arriving between candidate selection and commit must reject the witness and retry. No runtime flag, schema migration or client API change was added. Existing iOS/Android clients use the same endpoint and response shape.

The current baseline only fingerprints STEP_INPUT_CHANGED work. Therefore safe display reuse must add fingerprint capture and in-transaction revalidation; treating the prior source fence as already covering DISPLAY_REFRESH was incorrect. This is the central cost discovered by implementing the candidate.

## Matched control

Run against unchanged runtime code 441f307, using the reproduction from 3466f77 with the same powerups-enabled fixture and synthetic source-version rows as the candidate. Both use the same local PostgreSQL18/PgBouncer/Redis and public HTTP + actual worker entry points, sequentially. These fixture changes mean the earlier 55–58-call reproduction is not the correct matched control for this experiment.

| Participants | Control first stale FULL | Control repeated FULL | Candidate repeated reuse |
| --- | ---: | ---: | ---: |
| 10 | 64 | 64 | 66 |
| 100 | 64 | 62 | 66 |

These are whole-cycle pg.Client.query invocations including harness job-state lookups and real post-task work, not per-query CPU or server statement counts. The initial candidate used 74 calls on a cold miss; the final candidate additionally reuses freshly captured fingerprint models during its FULL seed calculation to avoid duplicate reads. Final verification measured 66 calls for both cold FULL and repeated reuse at both sizes. Core timings for cold/reused candidates were 24/18 ms (10 participants) and 32/17 ms (100); these isolated local timings do not establish database CPU savings.

The matched control performed zero calls whose SQL text matched step_samples/durable_capture_ during these stale cycles: its existing scoring-input cache already avoided source rereads. The candidate's matching calls include its fingerprint SQL. A FULL plan label alone therefore does not prove a full database source replay.

The test shows no net query reduction. Individual local core timings are noisy and are not managed-database CPU measurements. This experiment cannot establish that production CPU would decrease or reach the user's 70% idle target. It also excludes effect/global-event races, so even a gain here would not establish a workload-wide gain.

## Validation and review

The desired reuse assertion failed on the original runtime before implementation. Initial candidate integration cases passed after adding the missing display fingerprint path. The final suite covers legacy HTTP display stability, real step corrections, a concurrent HTTP upload rejected at the fence, race-end clock exclusion, a real powerup-use mutation and repeated effect-bearing FULL refreshes, and future-ending source samples. Five pure calendar/expiry tests cover differing race/caller timezones, computation-before-midnight/commit-after-midnight, timezone trimming consistent with the canonical scorer, and age/race-end limits. Existing effect-expiry/cache integration tests remain unchanged.

Final validation: 18/18 integration cases and 5/5 calendar cases passed, no skips. The matched control passed 2/2. Local test services were shut down after verification.

The code review found and prompted fixes for separate scoring/box calendar boundaries, measuring witness age from computation rather than insertion, and retaining non-atomic publication compatibility. The final recommendation is to preserve the experiment for evidence, not deploy it merely because its correctness tests pass.

## Implication for the next optimization

Avoid adding another expensive validation pass around already-cached scoring. To make display-only work cheap, mutation paths need a trustworthy committed scoring version that can be checked with a bounded lookup, with explicit invalidation for time boundaries. That requires auditing all source/membership/effect/event writers and concurrency behavior before using it to bypass race-wide fingerprint reads. Queue/placement/publication overhead also needs measurement independently of the FULL plan label. No such version protocol has been implemented in this experiment.
