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

## Production verification

Runtime b69c1b5 was deployed through the guarded rolling wrapper on September 14
UTC. Exactly two HTTP workers, one resolution worker and one cron worker passed
the final topology/pool checks (32 aggregate connections); staging stayed stopped.
Migration audit found none missing or unfinished. No installation or migration was
needed. Environment and pre-existing remote lockfile hashes were preserved.
Required referral ledger audit/apply/audit found zero outstanding or changed rows.
Existing Decoy balance snapshot drift was reported and left unchanged.

The first scheduled cleanup after restart ran around 02:29:45 UTC. At 02:30:09,
all 100 sampled eligible tasks were absent and all 100 receipts matched their
original race, generation, dedupe key, terminal/snapshot state, intent count and
completion timestamp. At 02:30:28 only 32 currently eligible rows remained, the
oldest completed at September 7 02:29:49 UTC (newly aged since this run's fixed
cutoff). Post-task deletion statistics had advanced by at least 1,000 rows by
02:30:15; this is a coarse table-counter observation, not a per-query trace.

Public health and authenticated old/current app (2.3.13/2.3.14) authentication and
completed-race progress checks passed both after reload and after cleanup. Recent
DigitalOcean CPU samples around 02:30 were 33–42% non-idle; this short unmatched
window does not establish a causal CPU saving. Private local observation logs use
the /tmp/bara-cleanup-catchup- prefix. No manual bulk cleanup or synthetic production
work was introduced for verification.
