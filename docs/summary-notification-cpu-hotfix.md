# Summary wake and notification planning hotfix

A successful race-resolution commit previously woke the summary worker even when
it had no summary consequences. Production observation found 35 summary wakes
for 35 race-resolution commits in 65 seconds, while an earlier three-minute
sample had 65 summary claims returning no work.

The worker now publishes that wake only when its fenced transaction finalized or
terminalized summary impacts, or refreshed waiting summary work. The readiness
update count is carried out of the existing transaction; no new lookup is added.
The flag resets for every fenced attempt and publication remains after commit.
Independent summary capture, compaction deadlines, and 60-second recovery remain.
The separate expired PROCESSING-with-null-lease backlog is outside this patch.

Nine recurring notification queue SQL shapes now opt into protocol-level named
preparation: event claims, next-due lookup, projection claims, scheduled-event
projection (including its lock/lane reads), silent-placement completion/expansion,
and parent completion. SQL, parameters, locks, transaction boundaries, and result
shapes are otherwise identical. The existing per-pool 128-name admission budget
is shared with prepared reads. Overflow executes unnamed; there is no eviction,
error replay, cache of results, or runtime release flag. Production PgBouncer
already supports named statements with max_prepared_statements=128.

## Verification

- TDD: new HTTP/worker regression failed on two unwanted summary wakes and unnamed
  notification queries before business changes, then passed after implementation.
- Positive summary regression: real post-boundary HTTP sync, captured impact,
  worker wake, and one recap with exact steps remain correct.
- 80 relevant integration tests: 76 passed; four notification-domain-isolation
  failures reproduced on unchanged production commit 86d239c with the same errors.
  They concern support retry, placement/daily-mover fixtures and retention results.
- 29 integration tests passed through local PgBouncer 1.25.2 transaction pooling.
  Final three-test hotfix suite also passed through that pool, including repeated
  binds beyond initial custom plans and an injected post-claim failure proving
  transaction rollback, retryability, and exactly-once public Inbox delivery.
- 28 integration tests passed with force_generic_plan and UTC, including delivery
  admission and bulk scheduled-event projection. This is correctness validation,
  not a claim that generic plans are faster under every data distribution.
- Full unit run: 3356 passed, five failures. All five reproduce on baseline. One
  was a missing gitignored capacity overlay; supplying the existing local overlay
  makes its suite pass. Remaining failures are three outdated entitlement mocks
  and a stale race-write-fence inventory assertion. Assertions were not weakened.
  Targeted capacity/protocol tests: 43 passed.
- Flutter analysis clean. No Flutter change or mobile build is required; frozen
  iOS and Android clients retain the same API behavior.
- Code reviewer found no implementation blocker.

## Deployment and observation

One application commit, no dependency change, migration, seed, or data repair.
Use the safe production reload wrapper; keep two HTTP workers, one cron worker,
one resolution worker, and staging stopped. Preserve unrelated server edits.
Verify health, PgBouncer prepared support, named query planning, summary wakes,
and comparable host CPU after release. Query CPU and planning elapsed are different
measurements; do not promise this change explains or removes the full CPU gap.
Rollback, if needed, is an application revert and the same safe reload. Keep
PgBouncer prepared support enabled because existing prepared reads still use it.
