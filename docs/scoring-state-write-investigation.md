# Queue and scoring-state write investigation — 2026-09-07 EDT

## What the production evidence supports

The previous five-minute window had 885 batched queue upserts affecting 1,058
rows, with 10.11 seconds aggregate execution. The scoring-state lock upsert
ran 174 times with 9.55 seconds execution (54.9 ms/call). Both use necessary
per-race/per-user serialization; execution time is not per-query CPU time.

A fresh bounded 60-second read-only observation sampled activity 30 times.
There were 39 active client-backend observations: 36 with no wait event, three
with IO waits, and **zero sampled Lock waits**. Short waits between samples
remain possible. In this window:

- Queue upsert: 181 calls, 202 affected/returned rows, 684.69 ms execution
  (3.78 ms/call).
- Scoring lock upsert: 32 calls, 30.37 ms execution (0.95 ms/call).

This does not establish sustained lock contention as the current CPU cause.
Costs vary sharply across workload windows. No individual observed query is
proven to account for most managed-database CPU.

The queue statement is the actual batched enqueue/dirty-envelope merge in
RaceResolutionJobV2.enqueueMany. It can be called by step intake, summary work,
and scheduled race work. Its conflict path preserves generation and processing
fences, dirty participants/reasons, wake scheduling, and display artifacts.
The count alone does not prove redundant enqueues; queue behavior is unchanged
in this patch. Proving redundant wake sources requires attribution by trigger,
not blindly dropping ON CONFLICT updates.

## Confirmed unnecessary scoring-row update

lockScoringInputState used INSERT ... ON CONFLICT DO UPDATE SET
generation=generation solely to lock/read an existing row. Normal intake later
persists the final state in another UPDATE. An integration-test database audit
trigger proves that an unchanged public /steps/sync-v2 request physically updates
this table twice even though its scoring generation does not change.

The candidate first selects and locks an existing row with FOR NO KEY UPDATE,
the same row-lock strength as the original non-key update. A materialized CTE
feeds an insert/upsert fallback only when no existing row was locked. This keeps
one round trip and preserves the concurrent-creation case where an uncommitted
row is invisible to the statement snapshot: ON CONFLICT waits and returns the
committed state. Existing users now incur one final persistence update, not two.
This reduces tuple churn, not the required serialization or every intake write.

## Verification

Tests were written first. The physical-update audit failed with 2 versus the
expected 1 before implementation and passed afterward. Four new real HTTP/DB
cases verify:

- Existing unchanged intake creates only one scoring-row update.
- Concurrent first intakes and identical corrections do not lose/inflate
  scoring generations.
- A request blocked by an uncommitted new row observes generation 7 after the
  creator commits and advances to 8.
- A request blocked by an existing-row writer likewise observes the committed
  generation rather than stale statement-start state.

The latter cases assert an actual PostgreSQL blocking relationship before
releasing the holder. Test teardown waits for the durable after-commit event
claim before disconnecting. Final run: 24 tests passed, no skips, no error logs,
including bounded-history intake and existing one-round-trip structural guards.
No existing assertions were weakened. All tests ran on the dedicated local
*_test database. The temporary test audit trigger/function/table were removed.

No migration, dependency, API, scoring rule, or new flag. Older iOS/Android
clients retain existing behavior. Production deployment requires fresh approval;
no production CPU improvement is claimed for this unreleased change.

Review confirmed the lock and concurrent-creation semantics and suggested
preserving the post-lock database timestamp. The final SELECT now samples the
clock after either lock/insert path returns; all 24 tests passed again.

Evidence: /tmp/write-contention-1min.jsonl, /tmp/scoring-lock-red.log,
/tmp/scoring-lock-safety.log, /tmp/scoring-lock-final.log.
