# Post-task cleanup catches up within one scheduled run

The ten-minute cleanup previously stopped after two 500-row pages. Even after
repairing its queries, a large accumulation could therefore take many timer
cycles to clear. The scheduler now keeps processing bounded pages until a page
returns fewer rows than requested, with a fixed retention cutoff for that run.

Each transaction still selects at most 500 candidates and retains the existing
receipt validation, seven-day retention (one day only with the existing accepted
cutoff stamp), two-second statement timeout, and three-second transaction timeout.
Fresh, unfinished, and receipt-conflicting work remains protected. There is no
schema, API, client, deployment configuration, or feature-flag change. Existing
iOS and Android versions continue receiving the same race progress responses.

A successful full page is followed by a one-second pause. Existing replication,
latency, or WAL budget exhaustion causes a 30-second cooldown and a fresh budget,
instead of waiting for the next ten-minute tick. These are database pressure
signals, not direct DigitalOcean CPU readings. Transient database errors retry
after 5/10/20/40/60 seconds; statement/transaction timeouts halve subsequent page
size down to one. Non-transient errors still exit through existing error logging.
The scheduler remains single-flight; shutdown cancels pauses and awaits the
current page before completing. Persistent pressure can still delay cleanup;
protected or locked candidates can still produce a short page and defer remaining
work to another tick. This change removes the artificial per-run row ceiling,
not those correctness protections.

## Validation

Tests were written before implementation: the new single-tick catch-up and actual
PostgreSQL timeout tests failed on the capped implementation. Real integration
coverage uses a dedicated local PostgreSQL 18 database, the actual worker entry
point, and authenticated public race-progress requests. The new cases prove:

- A single scheduled invocation removes 2,501 old rows through pages of at most
  500, creates all 2,501 receipts, and preserves public participant totals.
- A real slow-delete trigger causes PostgreSQL's statement timeout; the same run
  retries smaller transactions and removes all 501 rows with matching receipts.
- A denied replication preflight resumes after lag clears without a new tick.

The six relevant integration suites ran 74 tests: 72 initially passed, one old
assertion required the intentionally removed 1,000-row cap, and the timeout test's
8-second polling window was too short when the local database also timed out a
250-row page. The cap assertion now requires all 1,101 eligible rows to disappear
while retaining the fresh row; the new timeout test allows 20 seconds without
removing correctness assertions. Both affected suites then passed all 28 tests.
The other four suites passed unchanged in the initial run.

Targeted runner/auth/notification tests passed 50/50 with the required local test
session secret. These include real timer cancellation, waiting for an active
cleanup page, no subsequent cleanup after shutdown, and non-transient error exit.
The capacity suite passed with its existing gitignored local fixture restored.
The broad unit suite is not clean: six failures (one hitchhike structural guard,
five runtime-control manifest tests) reproduce on untouched commit 0a4594a and
were left unchanged. No integration tests ran against production.

A read-only code-reviewer approved the final implementation with no blockers.
