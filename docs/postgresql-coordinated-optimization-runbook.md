# PostgreSQL coordinated optimization rollout and rollback runbook

This runbook is operational guidance for the additive queue/scoring/receipt release. It does not authorize a deployment or any production mutation. Production remains exactly two HTTP processes, one resolution process, one cron process, and no `all` role.

## Locked compatibility contract

The release changes no public endpoint, request body, response body, status code, or error case. All schema changes are additive. The previous binary ignores the new columns/tables/indexes and is a valid rollback target only while neither cleanup marker exists—that is, before the first destructive receipt-aware deletion. The observation marker, not later cutoff acceptance, is the authoritative boundary.

## Before deployment

1. Restore a recent sanitized production snapshot to a non-production database.
2. Run Prisma validation and all unit/integration tests only after confirming the database name ends in `_test` or is disposable/local.
3. Capture two immutable snapshots around each measurement interval. First run `DATABASE_URL=... node scripts/postgresql-coordinated-optimization-metrics.js --output evidence/pre-start.json`, execute the fixed-duration scenario, then run `DATABASE_URL=... node scripts/postgresql-coordinated-optimization-metrics.js --baseline evidence/pre-start.json --output evidence/pre.json`. Repeat for the candidate interval. Calls/s, blocks, rows, WAL, and execution time are computed only from the two-snapshot deltas; `pg_stat_statements_info` supplies reset/deallocation validity and statistics are never reset. The collector uses one read-only transaction and emits no bind values or user data.
4. Record queue latency at 10 ms resolution. With Redis healthy, newly committed eligible work must request a drain and begin its first claim immediately; 5/10/30/60-second intervals are recovery only.
5. Verify there is no receipt digest collision, the sanitized backfill completes, and all four receipt tables have the expected population.

## Migration order

Apply, one at a time, without dropping old indexes:

1. `20260902120000_durable_queue_receipts_and_readiness`
2. `20260902121000_durable_queue_active_indexes`
3. `20260902122000_domain_event_receipt_terminal_bridge`
4. `20260902123000_projection_counter_noop_guard`
5. `20260902124000_domain_event_failure_health_indexes`
6. `20260902125000_domain_event_retry_due_index`
7. `20260902126000_exact_due_branch_indexes`
8. `20260902127000_schedule_and_admission_expiry_indexes`
9. `20260902128000_global_summary_exact_lease_indexes`

The migrations add summary readiness, projection counters, all four receipt tables, previous-binary receipt bridges, and purpose-built active indexes. Migration 1260 adds compact normal- and admission-expiry indexes used by Inbox exact-due recovery. Migration 1270 adds the schedule normal/admission expiry branches and a class-leading Inbox admission-expiry index. Migration 1280 adds compact lease-boundary indexes for the summary `WAITING_RACES` and `WAITING_SYNC` recovery branches, avoiding an unindexable `MIN(GREATEST(...))` scan; the prior broader indexes remain in place for mixed-version rollback. They do not add a placement artifact, fillfactor, or autovacuum reloption. No such tuning value is proven.

## Receipt backfill and verification

The receipt-aware binary performs bounded reconciliation: at most 100 provisional event receipts and projection counters per minute, and at most ten 500-row receipt pages in the daily maintenance run. Before any shortened payload cleanup, verify:

```sql
SELECT receipt_state, COUNT(*), MIN(created_at) FROM domain_event_receipts GROUP BY receipt_state;
SELECT COUNT(*) FROM domain_event_outbox event
WHERE NOT EXISTS (SELECT 1 FROM domain_event_receipts receipt WHERE receipt.domain_event_id=event.id);
SELECT COUNT(*) FROM notification_schedules schedule
WHERE NOT EXISTS (SELECT 1 FROM notification_schedule_receipts receipt
  WHERE receipt.recipient_user_id=schedule.recipient_user_id AND receipt.delivery_key=schedule.delivery_key);
SELECT COUNT(*) FROM race_resolution_post_tasks task
WHERE task.state IN ('succeeded','succeeded_with_failures') AND NOT EXISTS (
  SELECT 1 FROM race_resolution_post_task_receipts receipt
  WHERE receipt.race_id=task.race_id AND receipt.source_generation=task.source_generation);
```

`PROVISIONAL` must be zero and remain zero. Any immutable digest/source collision stops rollout. `LEGACY_UNMAPPED` event/schedule receipts are deliberately retained indefinitely.

## Authoritative retention

- `domain_event_receipts`: until the source-type-specific replay source is deleted; provisional and unmapped receipts are never age-cleaned.
- `notification_schedule_receipts`: source-backed receipts until their source is deleted; direct receipts through alert visibility plus the maximum producer retry horizon. Both also require no live schedule, alert, outbox, or device attempt.
- `race_resolution_post_task_receipts`: owning race lifetime only; never selected by age.
- `race_resolution_delivery_intent_receipts`: owning race lifetime only; never selected by age.

Notification schedule producer inventory:

- Source-backed: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1` in
  `domainEventV1Projection.js`, keyed to the immutable
  `global_step_event_entitlements.id` plus monotonic `scheduleRevision`.
- Direct: every other typed projection in `domainEventV1Projection.js`, the
  support/high-multiplier projectors in `notificationProjector.js`, and the
  durable compatibility submissions in `notificationHandlers.js`. These
  carry no `sourceRef`; their receipt remains through the resulting Inbox
  alert's 30-day visibility plus the 15-minute maximum producer retry horizon.
- Legacy rows with a non-null source that cannot be classified from stable
  columns are stamped `LEGACY_UNMAPPED` and retained indefinitely.

Payload cleanup rechecks terminal state, final receipt, and absence of active descendants under `FOR UPDATE SKIP LOCKED`. Pages are limited to 500 with `lock_timeout=100ms` and `statement_timeout=2s`.

## Irreversible cleanup cutoff

No seven-day payload cleanup begins automatically. Observe the receipt-aware binary for at least seven full days after every old process has exited. Before accepting the cutoff, preserve the last receipt-aware build artifact and understand that the pre-receipt binary ceases to be a safe rollback target after the first deletion.

An authorized operator may then run:

```sh
DATABASE_URL=... node scripts/postgresql-receipt-cleanup-cutoff.js \
  --observed-since 2026-09-02T00:00:00Z \
  --ack I_ACCEPT_RECEIPT_AWARE_ROLL_FORWARD_ONLY_CLEANUP \
  --output evidence/cleanup-cutoff.json
```

The command refuses a window under seven days, provisional/missing receipts, replica replay lag over five seconds, or an existing evidence file. It stops after ten pages total across all payload and receipt families and fails without stamping the accepted cutoff if a page exceeds 500 ms, page WAL exceeds 16 MiB, run WAL exceeds 64 MiB, or replica lag exceeds five seconds. The first destructive transaction atomically stamps `job_runs.receipt_aware_payload_cleanup_observed_v1`; that observation marker is the authoritative signal that a pre-receipt binary is no longer a safe rollback target, even if the process crashes or a later evidence gate fails. After the successful page's WAL/latency/replica evidence is verified, the command stamps the separate accepted marker. Operators must query and preserve both markers in incident evidence. The output contains aggregate counts only. Recurring cleanup applies the same shared ten-page, fail-closed WAL, latency, and replica gates to every destructive family.

Acceptance stamps the durable operational marker
`job_runs.receipt_aware_payload_cleanup_cutoff_v1`. This is irreversible data
lifecycle state, not a rollout flag: the recurring retention workers then use
seven days for successful domain-event payloads, 24 hours for completed
post-task/intent payloads, and may delete terminal notification schedules only
after a matching terminal receipt exists and no Inbox alert/outbox/device
descendant remains. Before this marker, post tasks keep the existing seven-day
horizon and the newly shortened schedule/domain payload cleanup stays off.

## Post-deployment acceptance

Capture candidate evidence and run:

```sh
node scripts/postgresql-coordinated-optimization-load-gate.js evidence/pre.json evidence/post.json
```

Required gates are at least 90% lower idle queue calls, global-summary scans, and terminal-projection fetches; no participant-linear SQL fallback at 500 participants; bounded 32 MiB page heap growth; unchanged p95 resolution/placement/notification latency; healthy-Redis p50/p95/p99 commit-to-wake and commit-to-first-claim no slower at 10 ms resolution; and convergence within 5/10/30/60 seconds only for lost-wake recovery.

Also compare database CPU, transaction rate, tuple fetches, WAL, dead tuples, lock waits, replica lag, queue depth/age, receipt provisional count/age, and application aggregate metric snapshots. Do not include IDs, payloads, tokens, step totals, or connection strings.

## Rollback

Before rollback, query both `receipt_aware_payload_cleanup_observed_v1` and `receipt_aware_payload_cleanup_cutoff_v1` in `job_runs`. Only when neither exists may the pre-receipt binary be used. If the observation marker exists—even without the accepted marker—a destructive receipt-aware page committed and rollback is receipt-aware-only. After either marker: deploy only the last receipt-aware compatibility build. Never drop receipt/readiness columns, tables, old indexes, or triggers during an incident. Do not reset PostgreSQL statistics, change settings, vacuum, reindex, or kill queries as part of application rollback.
