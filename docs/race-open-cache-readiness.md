# Race opening display cache readiness

Status: implementation and verification complete; ready for production deployment with existing-suite failures and the first-deploy freshness window documented below. Nothing deployed.

## Scope
Cache the remaining race detail display fields covered in race-open-cache-requirements.md. HTTP contracts and both mobile platforms remain unchanged. Redis is reconstructible display storage; one narrow SQL gate continues to enforce access, with the original separate compatibility preflight retained for older clients. Mutations and scoring continue to use authoritative data. No migration, dependency, runtime flag, mobile build, or release configuration change is planned.

## Final verification
- Backend baseline `2a748a47ba76f4661baa4835ae53a573ccf75fc5`; production observed read-only at `340b40574fac8f6be75792f00af17c9a2caf745e`. Runtime sources match; intervening commit contains only a retirement script and tests.
- Full backend unit suite: **3,399 passed, zero failed**, matching baseline.
- Full integration baseline: **3,256 passed, 106 failed, one skipped** (3,363 tests).
- Full integration candidate: **3,302 passed, 95 failed, one skipped** (3,398 tests). All **35 new cache tests pass**. These are completed full-run counts.
- Failure audit: 78 matched normalized conditions; nine changed messages accounted for by baseline conditions or focused reproduction; eight newly appearing identities classified individually. Five reproduce on baseline, two are environment-sensitive waiter/cleanup failures in unchanged paths, and one reflects the intended query reduction. See [all 95 failure dispositions and limitations](artifacts/race-open-cache-final-regressions.json). No remaining failure was identified as a cache regression; the existing full suite remains red.
- After the full run, the old exact-two-read assertion was tightened to exact-one. That focused test passes; its whole file has three passes and four baseline failures. All captured source/test fingerprints remain unchanged; this additional assertion-only change is recorded separately.
- Frontend unchanged at `587d8cb16163ebdeaafe20e782862e6ec5f5109b`: Flutter analysis clean, 3,400 visible passes and 36 pre-existing admin-screen failures reproduced in all four affected suites. See frontend `docs/race-open-cache-client-verification.md`. This backend-only change needs no native builds.
- Independent combined runtime review approved implementation. Verification caught and fixed bootstrap completion refresh, scoring-proof versus display-output invalidation, and old-client concurrent-resize compatibility regressions. Their protected checks now pass.

## Tests-first and assertion integrity
Initial HTTP SQL-elimination and viewer-overlay tests failed on unchanged runtime before implementation. The final suites contain 17 display, eight transition and ten viewer tests. Coverage includes separate writer/worker processes, time-only expiry, malformed/evicted Redis, writer Redis failures and held in-flight fills. Payout and C0-marker negative controls fail when only the relevant invalidation is removed. Protected resize tests pass 8/8; final display/resize/bootstrap checks pass 37/37.

Two catalog fixtures now activate effects through the public powerup endpoint after warming Redis, instead of bypassing invalidation with raw SQL. All original assertions remain, plus an HTTP success assertion; the adapted suite passes 9/9 on both runtimes. The only other existing-test change tightens core query count2→1. Both were surfaced explicitly; no assertion was skipped, removed or weakened.

Logs: `/tmp/race-open-cache-final-integration.log`, `/tmp/race-open-cache-baseline-isolated-integration.log`, `/tmp/race-open-cache-final-unit.log`. Tests used dedicated local test PostgreSQL and isolated local Redis, never production.

## Scope-to-evidence map
| Approved scope | Integration evidence |
|---|---|
| Race/current viewer status and mute preferences | Display core SQL elimination, sibling mute writes, seeded cron/admission transitions; fresh access and old-client guards under writer Redis failure |
| Participant capacity, progress, bonus and box threshold | Participant SQL elimination; actual intake/resolution worker and separate powerup writer; time-derived countdown assertions |
| Full participant and payout summary | Summary SQL elimination; public team settlement with barriers isolating the payout overwrite hook |
| Display effects | Effects SQL elimination, public powerup use, finite/null-expiry time-only transitions across response contracts |
| Mystery-box preview and current capability/config derivation | Preview SQL elimination and retained catalog authority suite using public activation after warm cache |
| Trail Mix history | History SQL elimination and separate powerup writer |
| Rematch and series properties | Viewer suite: separate process changes, rollback, wire-held in-flight fill, account deletion, descendant completion and actual recurring worker |
| Existing response compatibility and Redis fallback | Standalone/bootstrap/paged/full/team/null-timezone/old-header paths; malformed/evicted fragments; private revocation and team-size growth with writer Redis unavailable |

The three new integration files now contain 35 tests. They exercise real HTTP and PostgreSQL with isolated Redis; worker-owned changes use production process entrypoints. No mutation/scoring reads were replaced by display caches.

## Measured read cost
Apples-to-apples production-mode paged bootstrap measurements:

| Client profile | Baseline cold SQL | Candidate cold SQL | Baseline warm SQL | Candidate warm SQL |
|---|---:|---:|---:|---:|
| Current app (10v10 capability) | 27 | 25 | 18 | 5 |
| Older app (compatibility preflight retained) | 28 | 26 | 19 | 6 |

Both versions perform zero SQL writes and add zero queue jobs in these measurements. The five current-app warm statements read the authenticated user, authoritative access gate, global powerup inventory, bounded standings page, and discard-cap aggregate. The fixture leaves existing inventory/discard caches disabled and has no worker-published standings projection. All six targeted display SQL families are absent when warm.

For both profiles, Redis total processed commands rise from 87 to 209 cold and 52 to 142 warm. These include Lua-internal commands, not network round trips. EVAL entry calls rise from 14 to 38 cold and 12 to 31 warm; EVALSHA is zero. New fragment payloads occupy 4,706 bytes in this fixture. These results demonstrate reduced database work, not measured production CPU or end-to-end latency improvements.

Writer overhead (source audit, not timing): representative step upload and C0 resolution add no SQL statements, database round trips, durable writes or jobs. A committed uploader totals update adds four distinct generation markers; a plain successful C0 commit adds two, or three when it updates effects. One upload plus one C0 therefore adds six marker SET operations and at most two EVAL calls plus two PUBLISH calls; existing transaction batches can absorb these markers and reduce incremental calls. IDs come from already-loaded results, so these marker counts do not grow with the roster. Rejected/rolled-back/no-write uploader paths publish none.

Lucky Horseshoe use adds four internal marker SETs and Fanny Pack use six, normally within existing invalidation batches with no additional EVAL/PUBLISH calls. The existing 256-marker batch boundary, multi-target effects, retries and Redis failures can add calls; these are healthy-Redis representative paths, not universal limits. Marker lifetimes remain 48 hours. No extra SQL lookup is introduced by these powerup hooks.

## Deployment plan after separate approval
1. Recheck production HEAD, environment and existing package-lock modification; verify the intended release contains only reviewed changes.
2. Preserve the previous runtime commit for rollback; follow DEPLOY_RUNBOOK.md preflight and use the repository's PM2 safe production reload wrapper. Keep exactly two HTTP workers, the existing resolution/cron companions and staging stopped.
3. This change needs no migration, seed, new environment value, or mobile upload. New versioned cache entries are filled on demand.
   The safe wrapper intentionally replaces HTTP readers before retiring old companion writers. During this first mixed-runtime handoff, old writers cannot invalidate the new display fragments. Confirm every old HTTP/cron/resolution PID has exited, then allow ten minutes on the all-new runtime before judging display freshness: nested 300-second metadata/core caches can extend this one-time stale-display window to approximately ten minutes. Other summary fragments are bounded to five minutes and mutable participant/effect/viewer fragments to thirty seconds. Access, current race status and large-team compatibility still use the fresh SQL gate; mutations remain authoritative. No global Redis flush or rollout flag is required.
4. Verify health and authenticated cold/warm bootstrap, paged progress, legacy detail, powerup mutation refresh, and access denial. Observe SQL/Redis/error metrics with comparable traffic.
5. Rollback runtime to the recorded previous commit with the same safe wrapper. Old readers ignore the new cache namespace; no data reversal is required. Avoid flushing Redis globally.

Nothing has been deployed, uploaded, or started on staging as part of this task.
