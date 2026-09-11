# Recover lease-free PROCESSING summary work

> Historical summary-worker/capture guidance is superseded by the simple event recap. Do not run retired capture/summary operations. See [retirement runbook](simple-event-recap-sql-retirement.md); unrelated findings remain historical evidence.

Revalidated against backend main `3ecc74e` and deployed `7e4132c` on
2026-09-08. Read-only production observations at 19:05 and 19:11 UTC found
357 PROCESSING summary-work rows; all had NULL leases and expired deadlines.
356 had no recorded error and one recorded P2028. This establishes stranded
work, not which historical release/error produced each row or its CPU cost.

The worker releases leases after retryable errors or exhausted tick budgets
without changing PROCESSING status. Recovery also clears expired leases.
The claim and next-due queries previously required a non-NULL PROCESSING lease,
so both paths could strand work permanently.

The fix adds a separate PROCESSING/NULL-lease branch, due at available_at,
to candidate selection, locked-row revalidation and next-due scheduling.
Existing batch limits, SKIP LOCKED, token fencing and expiry handling apply.
Live worker leases and durable capture's parked QUEUED leases remain protected.
No migration, runtime flag, new cron, API change or mobile release is required.

## Validation

Three new integration tests failed against the original worker for the intended
scheduling/recovery failures, then passed with the fix:

- Real budget release, exact retry deadline, no early retry and worker restart.
- Recovery clearing an expired PROCESSING lease followed by terminalization.
- Batch-size-one backlog recovery with concurrent workers, exactly-once job
  fences, live-lease protection, no summary creation and both capable/legacy
  HTTP contracts.

All 68 tests passed across global-event-summary-expiry-v2,
durable-global-event-capture, summary-notification-cpu,
durable-capture-terminal-cleanup and durable-capture-compaction-cadence.
Tests used a dedicated local PostgreSQL 18 database, summary_lease_fix_test.
JavaScript syntax and git whitespace checks passed. Frontend flutter analyze
reported no issues; neither platform's code or build configuration changed.
The full backend suite was not run. Required code-reviewer review reported
no blockers, issues or nits.

Production EXPLAIN (without ANALYZE, in read-only transactions) selected an
index-only scan on processing_lease_idx for the claim branch and the existing
status_available_at_lease_until_idx for next-due lookup. No production writes
or configuration changes were made. These plans are not a CPU benchmark.

## Release scope

The approved release plan isolates this fix on the current production release;
do not deploy unrelated unreleased main changes.
The normal bounded summary worker will expire eligible stranded rows and write
its existing job fences. No one-off database repair is needed. After release,
verify PROCESSING/NULL-lease expired rows drain, retry deadlines remain bounded,
worker errors do not rise and no late summaries are delivered. Existing expired
summaries cannot be restored by this fix. Reverting the application stops the
new claim behavior; it does not undo terminalization already committed.


## Production verification

User authorized deployment after implementation. Release `8dbcca0` cherry-picks
`7ef0a6b` onto deployed `7e4132c`; branch `release/summary-lease-fix` is pushed.
All 68 selected integration tests also passed on this exact release candidate.
The guarded production reload completed on 2026-09-08 at approximately 19:15 UTC.
Health and Redis checks passed; topology validation confirmed two HTTP workers,
one cron and one resolution worker, with the existing aggregate pool budget 32.
Staging stayed stopped and the server's existing package-lock modification was
preserved. No migrations, dependency installation or one-off data repair ran.

Saved the 357 stranded IDs before deployment. At 19:16:30 UTC, read-only audit
confirmed all 357 were EXPIRED_UNDELIVERED, all 357 had completion job fences,
and none retained a lease. Observed summary drain ticks reported zero retries
and zero summaries committed. This verifies recovery, not a measured CPU gain.
