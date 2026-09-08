# Shared powerup guard release validation

2026-09-08. Production baseline `3b241ff`; candidate code `4364048`.
User approved production deployment conditional on no new broader-suite
regressions. That condition is satisfied by the comparisons below. No test
assertions were edited, skipped or weakened during this release validation.

| Run | Baseline | Candidate |
| --- | --- | --- |
| Full tracked integration suite | 2,711 pass / 206 fail / 1 skip | 2,770 pass / 207 fail / 1 skip |
| Previously failing files with local admin configured | 588 pass / 41 fail | 588 pass / 41 fail |
| Query-plan cases from identical physical database copies | 2 pass / 0 fail | 2 pass / 0 fail |
| Leech-repair tests on their required exact database name | 7 pass / 0 fail | 7 pass / 0 fail |

The full run covers 303 baseline files and 308 candidate files. All 60 added
cases passed. The original and candidate runs used separate fresh local test
PostgreSQL databases, ran sequentially, and used the same environment.

Two full-run candidate-only failures were the legacy query-plan benchmark's
requirement for a greater-than-50% buffer-hit reduction. The test's reference
SQL used 406/483 hits on the baseline database, but 21/25 on the candidate
database; its comparison SQL used 12/14 versus 11/15. No powerup command is
invoked by these cases, and their SQL/worker implementation is unchanged by
this release. Both cases passed on both revisions when repeated from identical
physical copies of the post-suite database. This establishes that those two
assertions are sensitive to database/test history rather than evidence of a
new powerup-code regression.

Many original failures were missing local admin authorization. All 47 failing
baseline files were rerun on fresh databases with `ADMIN_EMAILS=admin@test.com`.
The candidate and baseline each had 41 failures. A standings-ordering test
changed pass/fail between runs, but its candidate failure also occurred in the
original production-baseline run. Every remaining candidate failure appears in
at least one baseline run.

Seven Leech-repair cases reject any database name except
`steps-tracker-integration_test`. They were therefore rerun without weakening
that guard on a separate disposable PostgreSQL instance using the required
name. All seven passed on both revisions; the test-owned instance was stopped.
The normal local integration database was never modified.

The earlier full unit run had 3,356 passing and five failing tests, and all
five failures reproduced on unchanged `9b2cfb8`. See the implementation report.
The broader suites are not completely green; this validation establishes no
new regressions relative to the existing failures.

Machine-readable failure identities/counts:
[comparison data](powerup-shared-guards-release-validation.json).
Implementation and load results:
[shared guard report](powerup-shared-race-guards-results.md).

Production preflight confirmed the expected baseline, healthy HTTP/Redis,
238/238 migrations applied with no failed migration, two HTTP processes plus
one resolution and one cron process, staging stopped, and the existing 32-pool
budget. Deployment uses the isolated powerup branch. Dependencies, schema,
ecosystem configuration and catalog copy are unchanged. Existing npm peer-only
metadata edits to the server's package lock are preserved.
