#!/usr/bin/env node

const fs = require("node:fs");
const { prisma } = require("../src/db");
const domainEventOutbox = require("../src/modules/domainEvents/models/domainEventOutbox");
const {
  RaceResolutionPostTask,
} = require("../src/modules/races/models/raceResolutionPostTask");
const {
  NotificationScheduleReceipt,
} = require("../src/modules/notifications/models/notificationScheduleReceipt");
const {
  acceptReceiptCleanupCutoff,
  markReceiptCleanupCutoffObserved,
} = require("../src/shared/queues/receiptCleanupCutoff");

const ACK = "I_ACCEPT_RECEIPT_AWARE_ROLL_FORWARD_ONLY_CLEANUP";

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) values[argv[index].slice(2)] = argv[++index];
  }
  return values;
}

async function safetySnapshot() {
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM domain_event_receipts
         WHERE receipt_state='PROVISIONAL') AS provisional,
       (SELECT COUNT(*)::int FROM domain_event_outbox event
         WHERE event.status IN ('COMPLETED','SUPPRESSED')
           AND NOT EXISTS (SELECT 1 FROM domain_event_receipts receipt
             WHERE receipt.domain_event_id=event.id AND receipt.receipt_state='FINAL')) AS missing_receipts,
       (SELECT COUNT(*)::int FROM notification_schedules schedule
         WHERE NOT EXISTS (SELECT 1 FROM notification_schedule_receipts receipt
           WHERE receipt.recipient_user_id=schedule.recipient_user_id
             AND receipt.delivery_key=schedule.delivery_key)) AS missing_schedule_receipts,
       (SELECT COUNT(*)::int FROM race_resolution_post_tasks task
         WHERE task.state IN ('succeeded','succeeded_with_failures')
           AND NOT EXISTS (SELECT 1 FROM race_resolution_post_task_receipts receipt
             WHERE receipt.race_id=task.race_id
               AND receipt.source_generation=task.source_generation
               AND receipt.dedupe_key=task.dedupe_key)) AS missing_task_receipts,
       (SELECT COUNT(*)::int FROM race_resolution_delivery_intents intent
         JOIN race_resolution_post_tasks task ON task.id=intent.task_id
         WHERE intent.state IN ('accepted','rejected_no_retry','ambiguous_at_most_once')
           AND NOT EXISTS (SELECT 1 FROM race_resolution_delivery_intent_receipts receipt
             WHERE receipt.delivery_key_hash=intent.delivery_key_hash
               AND receipt.race_id=task.race_id
               AND receipt.source_generation=task.source_generation
               AND receipt.task_dedupe_key=task.dedupe_key
               AND receipt.intent_kind=intent.kind)) AS missing_intent_receipts,
       COALESCE((SELECT MAX(EXTRACT(EPOCH FROM replay_lag))::float8
         FROM pg_stat_replication),0) AS replica_lag_seconds,
       pg_current_wal_lsn()::text AS wal_lsn`,
  );
  return row;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.ack !== ACK) throw new Error(`--ack must exactly equal ${ACK}`);
  if (!options.output || fs.existsSync(options.output)) throw new Error("a new --output path is required");
  const observedSince = new Date(options["observed-since"]);
  if (Number.isNaN(observedSince.getTime()) || Date.now() - observedSince.getTime() < 7 * 86400_000) {
    throw new Error("--observed-since must prove a completed seven-day receipt-aware observation window");
  }
  const before = await safetySnapshot();
  if (before.provisional !== 0 || before.missing_receipts !== 0 ||
      before.missing_schedule_receipts !== 0 || before.missing_task_receipts !== 0 ||
      before.missing_intent_receipts !== 0 || before.replica_lag_seconds > 5) {
    throw new Error("receipt cleanup cutoff preflight failed");
  }
  const acceptedAt = new Date();
  const domainEventCutoff = new Date(acceptedAt.getTime() - 7 * 86400_000);
  const postTaskCutoff = new Date(acceptedAt.getTime() - 24 * 60 * 60_000);
  let deleted = 0;
  const pages = [];
  let previousLsn = before.wal_lsn;
  let evidenceGatePassed = true;
  let observationMarkerCommitted = false;
  const operations = [
    {
      kind: "domain_event_outbox",
      run: (client = prisma) => domainEventOutbox.deleteRetentionPage(client, {
        cutoff: domainEventCutoff,
        pageSize: 500,
      }),
    },
    {
      kind: "race_resolution_post_tasks",
      run: () => RaceResolutionPostTask.cleanupTerminal({
        before: postTaskCutoff,
        limit: 500,
      }),
    },
    {
      kind: "notification_schedules",
      run: () => NotificationScheduleReceipt.cleanupTerminalPayloads({ limit: 500 }),
    },
  ];
  for (let page = 0; page < 10 && operations.length > 0; page += 1) {
    const operation = operations.shift();
    const started = process.hrtime.bigint();
    const rows = page === 0
      ? await prisma.$transaction(async (tx) => {
          const removed = await operation.run(tx);
          await markReceiptCleanupCutoffObserved({ observedAt: acceptedAt, prisma: tx });
          return removed;
        }, { timeout: 3_000, maxWait: 2_000 })
      : await operation.run();
    if (page === 0) observationMarkerCommitted = true;
    const after = await safetySnapshot();
    const [wal = {}] = await prisma.$queryRawUnsafe(
      "SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::bigint AS bytes",
      after.wal_lsn,
      previousLsn,
    );
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const walBytes = Number(wal.bytes || 0);
    pages.push({
      page: page + 1,
      kind: operation.kind,
      rows,
      durationMs,
      walBytes,
      replicaLagSeconds: after.replica_lag_seconds,
    });
    deleted += rows;
    if (durationMs > 500 || walBytes > 16 * 1024 * 1024 ||
        pages.reduce((sum, item) => sum + item.walBytes, 0) > 64 * 1024 * 1024 ||
        after.replica_lag_seconds > 5) {
      evidenceGatePassed = false;
      break;
    }
    previousLsn = after.wal_lsn;
    if (rows === 500) operations.push(operation);
  }
  if (!pages.length || !evidenceGatePassed) {
    throw new Error(
      "first bounded cleanup/evidence page did not pass WAL, latency, and replica gates" +
      (observationMarkerCommitted
        ? "; receipt_aware_payload_cleanup_observed_v1 committed: rollback is receipt-aware-only"
        : ""),
    );
  }
  // This marker changes recurring retention horizons. It is deliberately the
  // final database write, after at least one bounded cleanup page has produced
  // acceptable evidence; a failed first page can never activate the cutoff.
  await acceptReceiptCleanupCutoff({ acceptedAt, prisma });
  fs.writeFileSync(options.output, `${JSON.stringify({
    schema: "receipt-aware-cleanup-cutoff-v1",
    acceptedAt: acceptedAt.toISOString(),
    observedSince: observedSince.toISOString(),
    domainEventCutoff: domainEventCutoff.toISOString(),
    postTaskCutoff: postTaskCutoff.toISOString(),
    deleted,
    pages,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
