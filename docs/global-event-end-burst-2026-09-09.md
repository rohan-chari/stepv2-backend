# 2× challenge end-cohort amplification — September 9, 2026

## Finding

Read-only production inspection at source `7915ad8` identified 87 entitlements
ending at 02:53 UTC (22:53 EDT). These were predominantly America/Denver,
America/Edmonton, America/Boise and America/Chihuahua users. Their end stamps
span 02:53:24–02:59:24 UTC. SQL timestamps were read as text to avoid the
diagnostic Node client's local-time interpretation of timestamp-without-time-zone.

The continuous start drain already batches starts. The minute scheduler still
processed ends one user/transaction at a time: claim entitlement, load impacts,
fence shared races, lock enrollment, load participants, enqueue those same races,
reload the impact vector, insert/read summary work, and stamp the entitlement.
Forty users in two shared races consequently produced forty queue upserts and
forty generation bumps on each race. This makes redundant generations available
to concurrent workers throughout the drain. The local benchmark below isolates
the repeated scheduler work; it does not measure how many concurrent worker
attempts are avoided in production.

Step sync requests had already risen from 20 at 02:51 to 51 at 02:52 UTC.
Application pg_stat_monitor calls rose from 9,970 to 16,590 per minute, and
resolution attempts from 31 to 80, reaching 99 at 02:54. The end cohort is an
additional confirmed amplification path, not a complete attribution of the
CPU spike's onset or of all host CPU. Direct managed metrics showed roughly
99.9% busy on one vCPU, negligible I/O wait, and approximately 2.6–2.8% steal.
Existing notification-repair scans and per-resolution work remain separate costs.

## Change

The existing end scheduler discovers at most 100 due entitlements, discovers
their race set, and takes sorted race fences followed by the enrollment lock.
It claims still-due entitlements with SKIP LOCKED, rereads the impact vectors,
and rejects a changed race set before writing. One queue upsert merges the
cohort's users/participants for each race. Existing scope caps and conservative
FULL fallback remain authoritative. Summary work and terminal job markers use
bulk INSERT ON CONFLICT DO NOTHING; the end stamps commit in the same transaction.
Existing summary rows, statuses, leases and capture artifacts are not rewritten.
Queue wakes occur after commit, once per affected queue for the batch.

Old single-entitlement callers retain their path and share summary-state
classification with the batch. If a batch fails, its transaction rolls back
before a bounded individual recovery pass. That pass gets a fresh five-second
budget, so a batch that exhausted the normal tick budget cannot suppress recovery.
Subsequent ticks pick up remaining due users. Future timezone cohorts are not claimed.

No migration, dependency, runtime control, scoring rule, or HTTP contract change.
Existing iOS and Android clients continue using the same endpoints and fields.
No production deployment or database mutation was performed.

## Tests first and measured work

Dedicated local PostgreSQL test databases were migrated from scratch. New real
scheduler/HTTP/worker tests failed on the unchanged `3f427fc` baseline after
their functional assertions passed: observed 10/40 queue upserts versus a budget
of one. A separate failure-recovery test failed with zero of ten users processed
after an injected 5.1-second batch failure, then passed with the fresh recovery
budget. Observation forwards all pg calls unchanged; only failure tests inject
faults after real database writes.

| Work, 40 users / two shared races | Baseline | Updated |
| --- | ---: | ---: |
| Scheduler SQL calls | 695 | 26 |
| Queue upsert statements | 40 | 1 |
| Generation bumps per shared race | 40 | 1 |
| Subsequent resolution plus HTTP-check SQL calls | 581 | 580 |
| Combined SQL calls | 1,276 | 606 |

This is **96.3% less scheduler SQL** and **52.5% less combined SQL** in the
fixture. At ten users, scheduler calls fell from 185 to 26. Downstream work was
deliberately run after the scheduler, so both versions process the races once;
no speculative savings from fewer superseded attempts are included. SQL calls
include transaction commands and observation-covered HTTP reads. They are not
rows scanned or total internal trigger statements. Local elapsed values are
retained in the evidence but are not a controlled single-vCPU CPU benchmark.

All eight new integrations pass:

- Ten- and forty-user cohort work budgets, unchanged old/current HTTP totals,
  and idempotent replay.
- Concurrent schedulers plus a changed HTTP step sync preserve all users and
  the latest total.
- Failure after real end stamps rolls back queue generations and summary work;
  later retry completes exactly once.
- Expired, incompatible, zero-race and existing leased summary states persist.
- Failure after exhausting the original tick budget still recovers the cohort.
- A 121-user fixture processes 100 then 20 due users; a future Auckland user
  remains untouched.
- In-challenge HTTP samples retain 2× scoring through the real capture/summary
  and resolution workers: 100 outside plus 60 inside produces 220 for both
  frozen and current client contracts.

Broader selected validation: **178 of 186 tests pass** (including the eight new
tests). All eight failures also reproduce on unchanged baseline; no existing
assertion was changed, skipped or removed:

- `global-event-reliability`: concurrent STEP_SYNC/start activation expects
  IMMEDIATE but receives COALESCE.
- `local-global-step-event-entitlements`: three existing HTTP cases fail
  (active-event dependency closure, end-boundary Home cache, display artifact
  crossing an entitlement end).
- `localGlobalEventEntitlement` service tests: three old materialization mocks
  lack `$queryRawUnsafe` required by the prior enrollment optimization.
- `raceWriteFenceInventory`: source inventory is missing an existing participant
  UPDATE in the resolution worker.

The full backend suite was not run. Flutter analysis reports no issues.
Independent code review approved the revised implementation with no blockers.
The broader suite is **not green**; baseline failures are unresolved.

## Reproduction

Create and migrate a dedicated local database ending in `_test`, then set
DATABASE_URL to it. Both the tests and setup reject nonlocal/non-test targets.
Provide NODE_ENV=test, REDIS_URL empty, a synthetic SESSION_TOKEN_SECRET,
REFERRAL_IP_HMAC_ACTIVE_VERSION=1 and a synthetic REFERRAL_IP_HMAC_SECRET_V1.

```sh
npx prisma migrate deploy
node --test --test-concurrency=1 --test-force-exit test/integration/global-event-end-burst.test.js
```

[Sanitized production cohort and local measurements](evidence/global-event-end-burst-2026-09-09.json)
contain the comparison. Production CPU improvement and the 70% idle target
remain unverified until an explicitly authorized deployment and observation of
a comparable natural challenge-end cohort.
