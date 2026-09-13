# Effect history read reduction

## Behavior
The race-resolution worker already loads effects for its planning fingerprint and uses those rows for calculation. The change removes a second planning capture in the team FULL fallback and lets final validation reuse privately retained base effect rows when the database effect revision matches. Conditional Leech checkpoint data remains freshly read in the final roster statement. Scores, API contracts, and final generation/digest fences are preserved.

The effect revision is maintained by PostgreSQL for effect mutations, including old application writers. There is no new Redis entry and no new checkpoint-counter write during step sync. A missing or changed proof falls back to the canonical effect query.

## Baseline measurement
Measured using real old-client HTTP step sync, the real worker, a dedicated loopback PostgreSQL test database, and passive SQL observation. The 200-effect fixture uses expired modifiers whose windows precede the uploaded sample; both individual and team scores are 100. Original source was isolated with `git archive 4261964`, so ongoing edits could not affect the baseline.

| Fixture | Full effect reads | Effect rows loaded | Fingerprint SQL statements |
| --- | ---: | ---: | ---: |
| Individual, 200 historical effects | 2 → 1 (50% fewer) | 400 → 200 | 8 → 7 |
| Team FULL, 200 historical effects | 3 → 1 (67% fewer) | 600 → 200 | 12 → 7 |

The fingerprint statement counts above use Redis disabled; they are not whole-worker or HTTP query totals. They include the pre-existing canonical event reads. Separate baseline fixtures also cover empty effects, Runner's High and Rainstorm.

## Validation and results
The independent six-fixture comparison passed with identical persisted and public API scores. EXPLAIN on the actual final roster statement confirms one checkpoint aggregation and one proof lookup, with no full effect table read; its checkpoint table was empty, so it does not establish large checkpoint-table cost.

The migration adds one proof update per affected race per effect mutation statement (and a proof row when a race is created). No-op effect updates and checkpoint-only/step-sync changes add no proof updates. Existing Leech checkpoint reads remain where required. Snapshots opt out above 20,000 rows or 2 MiB and expire within 30 seconds or an earlier effect/race boundary. Missing/mismatched proofs reload canonically.

Architect and code reviewer approved. Frontend `flutter analyze --no-pub` and Prisma validation passed. Final combined integration verification passed **112/112**: 27 new effect-reuse cases, 56 event-cache cases, 11 planning-reuse cases, 16 Leech-boundary cases, and 2 settlement-parity cases. No failures or skips. New tests failed on the original 2/3 full reads before implementation. Database CPU and production latency have not been measured for this change. Production deployment is recorded below.


## Release
Backend-only, additive migration `20260913040000_effect_fingerprint_versions`. Old deployed writers are covered by database triggers; installed iOS/Android clients require no updates. No release flags or new Redis cache. Deploy migration before reloading the backend, with fresh user authorization.

## Evidence
- [Before measurements](evidence/effect-fingerprint-reuse/baseline.json)
- [After measurements](evidence/effect-fingerprint-reuse/after.json)
- [Final query plan check](evidence/effect-fingerprint-reuse/plan-check.json)
- [Integration tests](../test/integration/effect-fingerprint-reuse.test.js)


## Production deployment — 2026-09-13
Merged to main and deployed runtime `2dba77b`. The additive migration finished at 04:19:38 UTC. The guarded reload completed with two HTTP workers, one resolution worker and one cron worker, a pool ceiling of 32, and staging stopped. All 2,029 races had effect proof rows; all five proof triggers were enabled. The environment and existing server lockfile edit were preserved. Referral audit/apply/audit reported zero missing rows; power-up copy already matched; three known Decoy balance differences were retained.

At 04:23:23 UTC the new worker had 63 successful commits (50 closure, 13 FULL), and the queue was clear. PostgreSQL recorded 59 full effect loads and 59 final effect reuse proof queries, consistent with the intended one-load path. These are aggregate query counts, not per-job hit-rate tracing or a CPU savings measurement. Local/public health and Redis were OK; marketing/privacy/support returned 200. No sampled new database errors appeared; the existing BILLING_UNAVAILABLE messages remained.

[Production evidence](evidence/effect-fingerprint-reuse/production-verification.json)
