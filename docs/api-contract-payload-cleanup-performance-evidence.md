# API contract/payload cleanup performance evidence

All commands in this document ran on the disposable local database
`steps_tracker_contract_test`. No staging or production database was queried or
mutated.

## USER message watermark

The exact production predicate/order behind the body-free Activity watermark
was exercised by `test/integration/api-contract-query-plans.test.js` after
seeding 5,000 mixed-kind rows and running `ANALYZE`.

```text
Limit ... (actual ... rows=50 loops=1)
  Buffers: shared hit=10
  -> Index Only Scan using race_messages_user_watermark_idx on race_messages
       Index Cond: ((race_id = $0) AND (kind = 'user'::"RaceMessageKind"))
       Heap Fetches: 50
Planning Time: 2.503 ms
Execution Time: 0.168 ms
```

The pre-migration red plan used
`race_messages_race_id_created_at_idx`, filtered out other kinds/deleted rows,
and performed an incremental `id` tie-break sort. Migration
`20260814090000_race_message_user_watermark_index` adds the exact concurrent
partial ordering required by the contract.

## Focused behavior/query-count evidence

- Additive HTTP contracts and legacy opt-out: 7/7 real-HTTP/real-Postgres tests.
- Race-keyed single-writer, reason metadata, fixed coalescing, malformed
  fallback, bulk rollout, rollback drill, committed STEP_SYNC reuse/fence
  fallback, and durable nudge reservation are covered by the focused suite.
- Compact contract plus atomic sync-v2 baseline: 16/16 before the later
  tournament/action and malformed-metadata cases were added.
- Durable post-task DB dedupe/immutability/account-deletion behavior: 1/1.
- Immutable delivery decision/transport, runner ordering/readiness/ambiguity,
  task handoff and exact inline fallback: 19/19 focused unit tests plus one
  public-mutation/real-Postgres durable nudge-intent case.
- Display artifact: four real HTTP/Postgres/Redis cases cover byte-parity hit,
  missing fallback, concurrent-mutation fence fallback, and Trail Mine's
  pre-detonation HTTP view versus captured effect/feed commit with a
  presentation rename between compute and fence.
- Ordered participant persistence at 10/100/350 rows: exactly two production
  statements at every size (one ascending-user lock and one set update), proven
  by `api-contract-resolution-query-count.test.js` with Prisma query events.
- Separately spawned plain-Node production workers: `race-resolution-spawned-
  worker-scale.test.js` drives a public `/steps/samples` enqueue at 10, 100,
  and 350 participants. One child process claims and exits before processing;
  after its lease is expired, a second child process recovers and completes the
  same durable row, with the public mutation's 1,234-step total observed at
  every size. This is real Postgres and distinct process memory/DB clients, not
  an in-process worker mock.
- Notification caps/cooldowns and the generation task are now one transaction:
  the task generation insert wins dedupe before its deferred claim resolver
  runs; resolver failure rolls back both the task and reservation. Duplicate
  generations run no resolver and therefore cannot consume a delivery cap.

## Projection and post-task plans

`api-contract-query-plans.test.js` additionally exercises production-shaped
sets and records `ANALYZE, BUFFERS` plans for:

- accepted friend topology through the requester/addressee status indexes;
- the compact Ranked profile projection at 350 IDs (the 15,000-row fixture's
  cost model selected a 0.75 ms sequential pass; the primary key remains the
  alternate plan at lower density);
- profile stats through the `(user_id,date)` steps index;
- race access and 350-participant progress through participant indexes;
- a full 16-player/15-match tournament history through tournament participant
  and ordered matchup indexes, against 100 additional full histories;
- post-task claim, intent ambiguity, generation dedupe, and seven-day retention
  through their bounded indexes.

The post-task retention evidence exposed the missing terminal-keyset index.
Additive migration `20260814130000_race_resolution_post_task_cleanup_index`
adds `(state, completed_at, id)` concurrently; its post-migration plan is now
covered and green. No required planner case remains hidden behind a cache.
