# Snapshot-priority completion and empty-entitlement reads

September 7, 2026 EDT. Based on production runtime 441f307. This branch does not contain the rejected guarded-display caching experiment.

## Changes

The priority snapshot lane previously published an empty task, updated snapshot completion, released its lease, and woke the ordinary delivery lane to claim and finish the same task. It now uses the claim's authoritative `hasIntents` EXISTS result to combine snapshot completion and terminal receipt creation through the existing fenced `finish` operation. A successful empty task needs no requeue or ordinary wakeup. Tasks with actual intents follow the existing delivery path, regardless of stale `intent_count` metadata. Failed receipt transactions preserve the attempt marker and do not retry snapshot publication; a nonterminal finish preserves the known publication outcome before releasing the lease.

Global-event lookup previously read membership/join timestamps even when it found no local entitlements. Those timestamps are consumed only while applying local entitlements. The empty case now skips the membership read. Nonempty entitlements still load memberships and impact rows, with the same join-time clipping and eligibility rules; those reads run in parallel.

No scoring cache, scoring-rule change, runtime flag, migration, API change, or app build is required. Old iOS/Android clients keep the same response and notification behavior. No production deployment has occurred.

## Measurements

Real legacy-compatible HTTP reads and step intake, actual resolution worker and post-task runner, local PostgreSQL18 with transaction-pooled PgBouncer and Redis. Two sizes, same fixtures and services; original runtime and candidate run sequentially.

| Participants | Control first stale / repeated | Candidate first stale / repeated |
| --- | ---: | ---: |
| 10 | 64 / 64 | 60 / 60 |
| 100 | 64 / 62 | 60 / 60 |

Values are whole-cycle pg.Client.query invocations, including harness job-state lookups and an explicit ordinary tick in both variants. That tick is still counted even after the optimized snapshot lane has already finished the task; production also avoids the unnecessary wakeup. Asynchronous handoff timing can move a small number of calls between measurement windows. These are not CPU measurements. The isolated first stale cycle removes four calls (6.25%); do not extrapolate that percentage to total production CPU or the 70% idle target.

A controlled 10-member trace placed 27 calls in snapshot/post-task processing and only eight in the compute stage before this change. The trace exposed the separate completion/requeue path. Phase labels are diagnostic context, not per-query CPU attribution.

## Tests and review

Tests were written first: the two no-membership-read assertions and empty priority-task completion assertion failed on baseline; the new immutable-receipt collision assertion separately failed on baseline. No existing assertions were weakened.

Five new integration cases pass: repeated unchanged HTTP reads at 10/100 members with exact redundant-query guards and real step correction; empty HTTP-generated task completes in the priority lane and serves the updated total; stale zero intent metadata still delivers actual work; receipt collision rolls back completion and recovery does not republish. The 15 unchanged effect-expiry/cache cases also pass.

Broader run: 46/49 pass. All three failures are in `local-global-step-event-entitlements.test.js` and reproduce on untouched 441f307 (26/29 in that suite):

- seeded promotion enrolls accepted racers transactionally under the shared boundary lock;
- HTTP step-sync dependency closure fails closed while that participant's local event is active;
- HTTP display artifact cannot cross a participant's local entitlement end fingerprint.

Code review found no introduced correctness or compatibility issues and approved the focused change. The full suite is not claimed green. A fresh deployment approval is required, followed by managed-database CPU and statement-delta monitoring under comparable traffic.
