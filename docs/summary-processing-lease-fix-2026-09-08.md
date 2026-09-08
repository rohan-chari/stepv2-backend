# Recover lease-free PROCESSING summary work

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

Not deployed. Cherry-pick this fix onto the current production release after
fresh authorization; do not deploy unrelated unreleased main changes.
The normal bounded summary worker will expire eligible stranded rows and write
its existing job fences. No one-off database repair is needed. After release,
verify PROCESSING/NULL-lease expired rows drain, retry deadlines remain bounded,
worker errors do not rise and no late summaries are delivered. Existing expired
summaries cannot be restored by this fix. Reverting the application stops the
new claim behavior; it does not undo terminalization already committed.
