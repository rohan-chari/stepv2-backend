# Production race performance rollout — 2026-08-13

## User-reported symptoms in scope

This rollout tracks every performance complaint raised during the investigation:

1. Opening a race felt slow, especially after the overnight user influx.
2. CPU appeared to spike on a five-minute cadence, with the placement/background
   resolution work suspected of starving interactive requests.
3. Opening and spinning a mystery box felt delayed.
4. Loading Sneaky Swap targets and using Sneaky Swap felt delayed, especially in
   the 269-member Daily Challenge.
5. Using Leg Cramp felt delayed even though it does not require a full race
   recomputation.
6. Planting Trail Mine felt delayed. Its fresh canonical scoring pass is required,
   but unrelated hydration and the second full race load were not.
7. Other successful powerup casts could feel delayed because their shared tail
   reloaded race/inventory state and evaluated multiplier notifications even when
   the cast could not change the caster's multiplier.
8. Placement freshness must remain unchanged: user step syncs, due effect expiry,
   visible placement notifications, and race resolution must still converge
   correctly after the optimizations.
9. Database connection headroom and temporary droplet upscaling were discussed as
   mitigations. They are monitoring context, not substitutes for removing excess
   work; this rollout does not increase the DB pool or resolution concurrency.

The earlier removal of race-open-triggered global synchronization is already in
production and is separate from this rollout. This release addresses the remaining
powerup, placement, step-sync, and push-transport work.

## Root causes mapped to the rollout

| Symptom | Excess work found | Production change |
| --- | --- | --- |
| Mystery-box opening | Full race/cosmetic hydration, duplicate participant reads, then another full load during inventory sync | Lean per-roll race context plus narrow invariant repair |
| Sneaky Swap | Two queries per candidate, exceeding 500 candidate-dependent queries in a large race | Two bounded bulk reads independent of candidate count |
| Leg Cramp/shared casts | Sequential state reloads and shared post-cast work beyond the cast's needs | Lean state reuse with a fresh minimal caster read only where current multiplier semantics require it |
| Trail Mine | Required canonical scoring plus unnecessary accessory/shop hydration and a second full race load | Preserve canonical scoring and reuse its computed race result |
| Five-minute placement spike | Cross-process duplicate work, broad relation writes, and silent changes entering push work | Distributed tick claim, bounded scalar CAS writes, and inert-push suppression |
| Step-sync/push overhead | Per-user token/storage work and repeated APNs connections | Bulk step-sync scheduling and reusable bounded APNs sessions |

## Deployed artifact and switches

- Backend commit: `1d4835b` (`perf: optimize race powerup and placement paths`)
- Deployment date: 2026-08-13
- API/client contract: unchanged
- Database migration: none
- Final code review: 95 focused tests passed; no blockers or issues; `SHIP`
- Production switches enabled:
  - `PLACEMENT_DISTRIBUTED_CLAIM_ENABLED=true`
  - `PLACEMENT_LEAN_BASELINE_WRITES_ENABLED=true`
  - `PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED=true`
  - `STEP_SYNC_BULK_ENABLED=true`
  - `APNS_SESSION_REUSE_ENABLED=true`

Each switch remains an independent kill switch. Setting it to anything other than
the exact string `true` restores that path's legacy implementation.

## Pre-deploy observations

The previous production revision (`1ffd0c7`) was sampled for three hours:

- 680 health samples
- health latency median: 14.2 ms
- health latency p95: 1,088.3 ms
- worst health latency: 5,004.2 ms
- non-200 health samples: 2
- placement example: 36 races, 767 participants, 421 emitted changes, 70,058 ms

The old monitor's CPU field came from process-lifetime CPU rather than an interval
counter. It is retained as historical context but must not be used for a before/
after CPU-spike claim.

## Immediate post-deploy observations

The first optimized production placement tick completed with:

- 44 races
- 933 participants
- 366 baseline proposals and 366 CAS wins
- 1 recovery enqueue
- 362 emitted changes
- 9,279 ms total duration

That first tick was about 86.8% faster in wall time than the prior 70,058 ms tick
despite processing more races and participants. It is an early signal, not a final
result.

Initial real-traffic structured samples after deployment included:

- mystery-box open: 50.7 ms
- Sneaky Swap target lookup: 25.1 ms for 13 returned targets
- successful powerup use: 52.7–133.8 ms in the first observed samples
- bulk step-sync scheduling: 3–130 ms in the first observed samples
- APNs primary-session reuse observed
- database snapshot: 1 active connection / 19 total connections

These samples are not an apples-to-apples p50/p95 benchmark and are not used as a
final acceptance result.

## Four-hour production monitor

The post-deploy monitor runs for four hours from 2026-08-13 21:29 UTC. It records:

- true 15-second interval process CPU from `pidstat`
- RSS and host load
- local health status/latency on every sample
- public health status/latency every fourth sample
- structured race endpoint, placement, step-sync, APNs, resolution-lag, and
  relevant error events

The end-of-window review will report:

- CPU median/p95/max and whether five-minute spike area declined
- health median/p95/max and non-200 count
- every placement tick's duration, work counts, claim behavior, and errors
- observed mystery-box, Sneaky Swap, Trail Mine, Leg Cramp, and other powerup
  endpoint latency distributions when traffic supplies samples
- step-sync bulk duration/failures and APNs reuse/reconnect behavior
- resolution queue lag and any new 4xx/5xx, deadlock, uniqueness, Redis, or push
  failures after the deployment boundary

Do not infer success for an endpoint that receives too little organic traffic in
the four-hour window; report it as insufficient evidence instead.
