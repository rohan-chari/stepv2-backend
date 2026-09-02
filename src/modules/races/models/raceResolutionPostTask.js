const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const TASK_STATES = Object.freeze(["queued", "running", "succeeded", "succeeded_with_failures"]);
const SNAPSHOT_STATES = Object.freeze([
  "pending", "attempting", "succeeded", "failed_no_retry",
  "ambiguous_at_most_once", "skipped_superseded",
]);
const INTENT_STATES = Object.freeze([
  "pending", "attempting", "accepted", "rejected_no_retry", "ambiguous_at_most_once",
]);
const INTENT_KINDS = Object.freeze([
  "STATE_NOTIFICATION", "EFFECT_NOTIFICATION", "NUDGE", "STEP_SYNC",
]);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_INTENTS = 1000;
const LEASE_MS = 30_000;

function containsDeviceToken(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDeviceToken);
  return Object.entries(value).some(
    ([key, child]) =>
      key.replace(/[_-]/g, "").toLowerCase() === "devicetoken" ||
      containsDeviceToken(child)
  );
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validatePostTaskPayload({ snapshotCommand, intents }) {
  const snapshotKeys =
    snapshotCommand && typeof snapshotCommand === "object" && !Array.isArray(snapshotCommand)
      ? Object.keys(snapshotCommand).sort()
      : [];
  const allowedSnapshotKeys = [
    ...(snapshotCommand?.allowSupersededComplete === true
      ? ["allowSupersededComplete"]
      : []),
    ...(snapshotCommand?.effectExpiryParticipantSteps != null
      ? ["effectExpiryParticipantSteps"]
      : []),
    "raceId",
    "timeZone",
  ].sort();
  if (
    !snapshotCommand ||
    typeof snapshotCommand !== "object" ||
    Array.isArray(snapshotCommand) ||
    snapshotKeys.length !== allowedSnapshotKeys.length ||
    snapshotKeys.some((key, index) => key !== allowedSnapshotKeys[index]) ||
    typeof snapshotCommand.raceId !== "string" ||
    snapshotCommand.raceId.length === 0 ||
    typeof snapshotCommand.timeZone !== "string" ||
    snapshotCommand.timeZone.length === 0
  ) {
    throw new TypeError("invalid snapshot command");
  }
  if (snapshotCommand.effectExpiryParticipantSteps != null) {
    const entries = Object.entries(snapshotCommand.effectExpiryParticipantSteps);
    if (
      typeof snapshotCommand.effectExpiryParticipantSteps !== "object" ||
      Array.isArray(snapshotCommand.effectExpiryParticipantSteps) ||
      entries.some(([participantId, steps]) =>
        participantId.length === 0 || !Number.isFinite(Number(steps))
      )
    ) {
      throw new TypeError("invalid effect expiry participant steps");
    }
  }
  if (!Array.isArray(intents) || intents.length > MAX_INTENTS) {
    throw new RangeError("post-task intent cap exceeded");
  }
  if (containsDeviceToken(snapshotCommand)) throw new TypeError("device token forbidden");
  const normalized = intents.map((intent, ordinal) => {
    if (!INTENT_KINDS.includes(intent?.kind)) throw new TypeError("invalid intent kind");
    if (!intent.payload || typeof intent.payload !== "object" || Array.isArray(intent.payload)) {
      throw new TypeError("invalid intent payload");
    }
    if (containsDeviceToken(intent.payload)) throw new TypeError("device token forbidden");
    if (!/^[a-f0-9]{64}$/i.test(intent.deliveryKeyHash || "")) {
      throw new TypeError("invalid delivery key hash");
    }
    const payloadBytes = jsonBytes(intent.payload);
    if (payloadBytes > MAX_INTENT_BYTES) throw new RangeError("intent payload cap exceeded");
    return {
      ordinal,
      kind: intent.kind,
      recipientUserId: intent.recipientUserId || null,
      payload: intent.payload,
      payloadBytes,
      deliveryKeyHash: intent.deliveryKeyHash.toLowerCase(),
      cooldownClaimId: intent.cooldownClaimId || null,
    };
  });
  const payloadBytes =
    jsonBytes(snapshotCommand) + normalized.reduce((sum, intent) => sum + intent.payloadBytes, 0);
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new RangeError("post-task payload cap exceeded");
  return { snapshotCommand, intents: normalized, payloadBytes, intentCount: normalized.length };
}

async function recordIntentReceipt(client, value) {
  const inserted = await client.raceResolutionDeliveryIntentReceipt.createMany({
    data: [{
      deliveryKeyHash: value.deliveryKeyHash,
      raceId: value.raceId,
      sourceGeneration: Number(value.sourceGeneration),
      taskDedupeKey: value.taskDedupeKey,
      intentKind: value.intentKind,
      terminalDisposition: value.terminalDisposition,
      completedAt: value.completedAt,
      createdAt: value.completedAt,
    }],
    skipDuplicates: true,
  });
  if (inserted.count === 1) return;
  const receipt = await client.raceResolutionDeliveryIntentReceipt.findUniqueOrThrow({
    where: { deliveryKeyHash: value.deliveryKeyHash },
  });
  if (
    receipt.raceId !== value.raceId ||
    Number(receipt.sourceGeneration) !== Number(value.sourceGeneration) ||
    receipt.taskDedupeKey !== value.taskDedupeKey ||
    receipt.intentKind !== value.intentKind ||
    receipt.terminalDisposition !== value.terminalDisposition
  ) {
    const error = new Error("delivery intent receipt immutable identity mismatch");
    error.code = "DELIVERY_INTENT_RECEIPT_COLLISION";
    throw error;
  }
}

async function terminalizeAttemptingIntentsForRecovery(client, taskId, now) {
  const recovered = await client.$queryRawUnsafe(
    `UPDATE race_resolution_delivery_intents intent
     SET state='ambiguous_at_most_once', completed_at=$2,
         last_error_code='LEASE_RECOVERY', updated_at=$2
     FROM race_resolution_post_tasks task
     WHERE intent.task_id=$1 AND intent.state='attempting' AND task.id=intent.task_id
     RETURNING intent.delivery_key_hash AS "deliveryKeyHash",
       intent.kind AS "intentKind", task.race_id AS "raceId",
       task.source_generation AS "sourceGeneration",
       task.dedupe_key AS "taskDedupeKey"`,
    taskId,
    now,
  );
  for (const intent of recovered) {
    await recordIntentReceipt(client, {
      ...intent,
      terminalDisposition: "ambiguous_at_most_once",
      completedAt: now,
    });
  }
}

function buildRaceResolutionPostTaskModel(prisma = defaultPrisma) {
  const model = {
    async findByGeneration({ raceId, sourceGeneration }) {
      return prisma.raceResolutionPostTask.findUnique({
        where: { raceId_sourceGeneration: { raceId, sourceGeneration } },
        select: { id: true },
      });
    },

    async create({
      raceId,
      sourceGeneration,
      snapshotCommand,
      intents,
      resolveIntents = null,
      fastHandoff = false,
      recordPhaseTiming = null,
      now = new Date(),
      }, tx = null) {
      const measure = async (name, operation) => {
        if (typeof recordPhaseTiming !== "function") return operation();
        const startedAt = process.hrtime.bigint();
        try {
          return await operation();
        } finally {
          try {
            recordPhaseTiming(
              name,
              Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)
            );
          } catch {}
        }
      };
      const insert = async (client) => {
        // Validate the command before opening a claim transaction.  Delivery
        // claims deliberately happen only after this generation has won the
        // durable-task insert below: resolving a duplicate must not consume a
        // cooldown or high-multiplier cap without an owning outbox row.
        validatePostTaskPayload({ snapshotCommand, intents: [] });
        const id = crypto.randomUUID();
        const dedupeKey = `v1:post-delivery:${raceId}:${sourceGeneration}`;
        const completedReceipt = await client.raceResolutionPostTaskReceipt.findUnique({
          where: { raceId_sourceGeneration: { raceId, sourceGeneration } },
          select: { dedupeKey: true, terminalState: true, completedAt: true },
        });
        if (completedReceipt) {
          if (completedReceipt.dedupeKey !== dedupeKey) {
            const error = new Error("post-task receipt immutable identity mismatch");
            error.code = "POST_TASK_RECEIPT_COLLISION";
            throw error;
          }
          return {
            created: false,
            id: null,
            receiptOnly: true,
            dedupeKey,
            terminalState: completedReceipt.terminalState,
            completedAt: completedReceipt.completedAt,
          };
        }
        const task = await measure(
          "taskInsert",
          () => client.$queryRawUnsafe(
            `INSERT INTO race_resolution_post_tasks (
               id, race_id, source_generation, dedupe_key, state, requested_at,
               not_before_at, snapshot_state, snapshot_command, payload_bytes,
               intent_count, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,'queued',$5,$5,'pending',$6::jsonb,$7,$8,$5,$5)
             ON CONFLICT (race_id, source_generation) DO NOTHING
             RETURNING id`,
            id, raceId, sourceGeneration, dedupeKey, now,
            JSON.stringify(snapshotCommand),
            fastHandoff ? jsonBytes(snapshotCommand) : 0,
            0
          )
        );
        if (task.length === 0) {
          const existing = await client.$queryRawUnsafe(
            `SELECT id FROM race_resolution_post_tasks
             WHERE race_id=$1 AND source_generation=$2`,
            raceId,
            sourceGeneration
          );
          return { created: false, id: existing[0]?.id || null };
        }
        const decidedIntents = typeof resolveIntents === "function"
          ? await measure("resolveIntents", () => resolveIntents(client))
          : intents;
        const payload = validatePostTaskPayload({ snapshotCommand, intents: decidedIntents });
        // The winning insert already carries the final snapshot command and its
        // exact bytes. With no resolved intents there is nothing left to amend.
        if (fastHandoff && payload.intents.length === 0) {
          return { created: true, id, dedupeKey, ...payload };
        }
        if (fastHandoff && payload.intents.length > 0) {
          const rows = payload.intents.map((intent) => ({
            id: crypto.randomUUID(),
            taskId: id,
            ...intent,
          }));
          // One database round trip: finalize the owner row and insert its
          // immutable intents in the same statement/transaction.
          await measure(
            "intentInsert",
            () => client.$executeRawUnsafe(
              `WITH finalized AS (
                 UPDATE race_resolution_post_tasks
                 SET payload_bytes=$2, intent_count=$3, updated_at=$4
                 WHERE id=$1 RETURNING id
               )
               INSERT INTO race_resolution_delivery_intents (
                 id, task_id, ordinal, kind, recipient_user_id, payload,
                 payload_bytes, delivery_key_hash, cooldown_claim_id, state,
                 created_at, updated_at
               )
               SELECT row.id, row."taskId", row.ordinal, row.kind,
                      row."recipientUserId", row.payload, row."payloadBytes",
                      row."deliveryKeyHash", row."cooldownClaimId", 'pending', $4, $4
               FROM finalized,
                 jsonb_to_recordset($5::jsonb) AS row(
                   id text, "taskId" text, ordinal integer, kind text,
                   "recipientUserId" text, payload jsonb, "payloadBytes" integer,
                   "deliveryKeyHash" text, "cooldownClaimId" text
                 )`,
              id,
              payload.payloadBytes,
              payload.intentCount,
              now,
              JSON.stringify(rows)
            )
          );
          return { created: true, id, dedupeKey, ...payload };
        }
        await measure(
          "taskUpdate",
          () => client.$executeRawUnsafe(
            `UPDATE race_resolution_post_tasks
             SET snapshot_command=$2::jsonb, payload_bytes=$3, intent_count=$4, updated_at=$5
             WHERE id=$1`,
            id,
            JSON.stringify(payload.snapshotCommand),
            payload.payloadBytes,
            payload.intentCount,
            now
          )
        );
        if (payload.intents.length > 0) {
          const rows = payload.intents.map((intent) => ({
            id: crypto.randomUUID(),
            taskId: id,
            ...intent,
          }));
          await measure(
            "intentInsert",
            () => client.$executeRawUnsafe(
              `INSERT INTO race_resolution_delivery_intents (
                 id, task_id, ordinal, kind, recipient_user_id, payload,
                 payload_bytes, delivery_key_hash, cooldown_claim_id, state,
                 created_at, updated_at
               )
               SELECT row.id, row."taskId", row.ordinal, row.kind,
                      row."recipientUserId", row.payload, row."payloadBytes",
                      row."deliveryKeyHash", row."cooldownClaimId", 'pending', $2, $2
               FROM jsonb_to_recordset($1::jsonb) AS row(
                 id text, "taskId" text, ordinal integer, kind text,
                 "recipientUserId" text, payload jsonb, "payloadBytes" integer,
                 "deliveryKeyHash" text, "cooldownClaimId" text
               )`,
              JSON.stringify(rows),
              now
            )
          );
        }
        return { created: true, id, dedupeKey, ...payload };
      };
      return tx ? insert(tx) : prisma.$transaction(insert);
    },

    async claimNext({ now = new Date(), leaseMs = LEASE_MS } = {}) {
      const leaseToken = crypto.randomUUID();
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `WITH candidate_ids AS MATERIALIZED (
             SELECT id, requested_at FROM (
               (SELECT id, requested_at FROM race_resolution_post_tasks
                WHERE state='queued' AND not_before_at <= $1
                ORDER BY not_before_at, requested_at, id LIMIT 16)
               UNION ALL
               (SELECT id, requested_at FROM race_resolution_post_tasks
                WHERE state='running' AND lease_expires_at <= $1
                ORDER BY lease_expires_at, requested_at, id LIMIT 16)
             ) branches
             ORDER BY requested_at, id LIMIT 16
           ), candidate AS (
             SELECT task.id FROM race_resolution_post_tasks task
             JOIN candidate_ids USING (id)
             ORDER BY task.requested_at, task.id
             LIMIT 1 FOR UPDATE OF task SKIP LOCKED
           )
           UPDATE race_resolution_post_tasks task
           SET state='running', started_at=COALESCE(started_at,$1),
               lease_expires_at=$2, lease_token=$3, updated_at=$1
           FROM candidate WHERE task.id=candidate.id
           RETURNING task.id, task.race_id AS "raceId",
             task.source_generation AS "sourceGeneration",
             task.requested_at AS "requestedAt",
             task.snapshot_state AS "snapshotState",
             task.snapshot_command AS "snapshotCommand",
             task.lease_token AS "leaseToken"`,
          now, new Date(now.getTime() + leaseMs), leaseToken
        );
        const task = rows[0];
        if (!task) return null;
        await terminalizeAttemptingIntentsForRecovery(tx, task.id, now);
        if (task.snapshotState === "attempting") {
          await tx.$executeRawUnsafe(
            `UPDATE race_resolution_post_tasks
             SET snapshot_state='ambiguous_at_most_once', snapshot_completed_at=$2,
                 snapshot_error_code='LEASE_RECOVERY', updated_at=$2
             WHERE id=$1`,
            task.id, now
          );
          task.snapshotState = "ambiguous_at_most_once";
        }
        return task;
      });
    },

    async nextDueAt({ now = new Date() } = {}) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT LEAST(
           (SELECT MIN(not_before_at) FROM race_resolution_post_tasks WHERE state='queued'),
           (SELECT MIN(lease_expires_at) FROM race_resolution_post_tasks WHERE state='running')
         ) AS "dueAt"`,
      );
      const dueAt = rows[0]?.dueAt || null;
      return dueAt && new Date(dueAt) < now ? now : dueAt;
    },

    async claimById({ id, now = new Date(), leaseMs = LEASE_MS } = {}) {
      if (!id) return null;
      const leaseToken = crypto.randomUUID();
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE race_resolution_post_tasks task
           SET state='running', started_at=COALESCE(started_at,$2),
               lease_expires_at=$3, lease_token=$4, updated_at=$2
           WHERE task.id=$1
             AND ((task.state='queued' AND task.not_before_at <= $2)
               OR (task.state='running' AND task.lease_expires_at <= $2))
           RETURNING task.id, task.race_id AS "raceId",
             task.source_generation AS "sourceGeneration",
             task.requested_at AS "requestedAt",
             task.snapshot_state AS "snapshotState",
             task.snapshot_command AS "snapshotCommand",
             task.lease_token AS "leaseToken"`,
          id,
          now,
          new Date(now.getTime() + leaseMs),
          leaseToken
        );
        const task = rows[0];
        if (!task) return null;
        await terminalizeAttemptingIntentsForRecovery(tx, task.id, now);
        if (task.snapshotState === "attempting") {
          await tx.$executeRawUnsafe(
            `UPDATE race_resolution_post_tasks
             SET snapshot_state='ambiguous_at_most_once', snapshot_completed_at=$2,
                 snapshot_error_code='LEASE_RECOVERY', updated_at=$2
             WHERE id=$1`,
            task.id,
            now
          );
          task.snapshotState = "ambiguous_at_most_once";
        }
        return task;
      });
    },

    async listIntents(taskId) {
      return prisma.$queryRawUnsafe(
        `SELECT id, ordinal, kind, recipient_user_id AS "recipientUserId", payload, state
         FROM race_resolution_delivery_intents
         WHERE task_id=$1 ORDER BY ordinal ASC`,
        taskId
      );
    },

    async beginIntent({ id, now = new Date() }) {
      const attemptId = crypto.randomUUID();
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE race_resolution_delivery_intents
         SET state='attempting', attempt_id=$2, attempted_at=$3, updated_at=$3
         WHERE id=$1 AND state='pending'
         RETURNING id`, id, attemptId, now
      );
      return rows.length ? attemptId : null;
    },

    async completeIntent({ id, state, providerDisposition = null, errorCode = null, now = new Date() }) {
      if (!["accepted", "rejected_no_retry", "ambiguous_at_most_once"].includes(state)) {
        throw new TypeError("invalid terminal intent state");
      }
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE race_resolution_delivery_intents intent
           SET state=$2, provider_disposition=$3, last_error_code=$4,
               completed_at=$5, updated_at=$5
           FROM race_resolution_post_tasks task
           WHERE intent.id=$1 AND intent.state='attempting' AND task.id=intent.task_id
           RETURNING intent.delivery_key_hash AS "deliveryKeyHash",
             intent.kind AS "intentKind", task.race_id AS "raceId",
             task.source_generation AS "sourceGeneration",
             task.dedupe_key AS "taskDedupeKey"`,
          id, state, providerDisposition, errorCode, now
        );
        if (rows[0]) {
          await recordIntentReceipt(tx, {
            ...rows[0],
            terminalDisposition: providerDisposition || state,
            completedAt: now,
          });
        }
      });
    },

    async beginSnapshot({ taskId, leaseToken, now = new Date() }) {
      const attemptId = crypto.randomUUID();
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE race_resolution_post_tasks
         SET snapshot_state='attempting', snapshot_attempt_id=$3,
             snapshot_attempted_at=$4, updated_at=$4
         WHERE id=$1 AND lease_token=$2 AND snapshot_state='pending'
         RETURNING id`, taskId, leaseToken, attemptId, now
      );
      return rows.length ? attemptId : null;
    },

    async completeSnapshot({ taskId, state, errorCode = null, now = new Date() }) {
      if (!SNAPSHOT_STATES.includes(state) || ["pending", "attempting"].includes(state)) {
        throw new TypeError("invalid terminal snapshot state");
      }
      await prisma.$executeRawUnsafe(
        `UPDATE race_resolution_post_tasks
         SET snapshot_state=$2, snapshot_error_code=$3,
             snapshot_completed_at=$4, updated_at=$4
         WHERE id=$1 AND snapshot_state='attempting'`, taskId, state, errorCode, now
      );
    },

    async finish({ taskId, leaseToken, now = new Date() }) {
      return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `WITH failures AS (
           SELECT COUNT(*)::int AS count
           FROM race_resolution_delivery_intents
           WHERE task_id=$1 AND state IN ('rejected_no_retry','ambiguous_at_most_once')
         ), pending AS (
           SELECT COUNT(*)::int AS count
           FROM race_resolution_delivery_intents
           WHERE task_id=$1 AND state IN ('pending','attempting')
         ), finished AS (
         UPDATE race_resolution_post_tasks task
         SET state=CASE WHEN failures.count > 0 OR task.snapshot_state IN ('failed_no_retry','ambiguous_at_most_once')
                        THEN 'succeeded_with_failures' ELSE 'succeeded' END,
             completed_at=$3, lease_expires_at=NULL, lease_token=NULL, updated_at=$3
         FROM failures, pending
         WHERE task.id=$1 AND task.lease_token=$2 AND pending.count=0
           AND task.snapshot_state NOT IN ('pending','attempting')
         RETURNING task.race_id, task.source_generation, task.dedupe_key,
           task.state, task.snapshot_state, task.intent_count, failures.count
         ), receipt AS (
           INSERT INTO race_resolution_post_task_receipts (
             race_id, source_generation, dedupe_key, terminal_state,
             snapshot_state, intent_count, failure_count, completed_at
           ) SELECT race_id, source_generation, dedupe_key, state,
                    snapshot_state, intent_count, count, $3 FROM finished
           ON CONFLICT (race_id,source_generation) DO NOTHING
           RETURNING race_id,source_generation,dedupe_key,terminal_state,
                     snapshot_state,intent_count,failure_count,completed_at
         ), validated AS (
           SELECT inserted.terminal_state FROM receipt inserted
           UNION ALL
           SELECT stored.terminal_state
             FROM finished expected
             JOIN race_resolution_post_task_receipts stored
               ON stored.race_id=expected.race_id
              AND stored.source_generation=expected.source_generation
              AND stored.dedupe_key=expected.dedupe_key
              AND stored.terminal_state=expected.state
              AND stored.snapshot_state=expected.snapshot_state
              AND stored.intent_count=expected.intent_count
              AND stored.failure_count=expected.count
              AND stored.completed_at IS NOT DISTINCT FROM $3
            WHERE NOT EXISTS (SELECT 1 FROM receipt)
         ) SELECT (SELECT COUNT(*)::int FROM finished) AS "finishedCount",
                  (SELECT terminal_state FROM validated LIMIT 1) AS state`,
        taskId, leaseToken, now
      );
      if (Number(rows[0]?.finishedCount || 0) === 1 && !rows[0]?.state) {
        const error = new Error("post-task receipt immutable identity mismatch");
        error.code = "POST_TASK_RECEIPT_COLLISION";
        throw error;
      }
      return rows[0]?.state || null;
      });
    },

    async cleanupTerminal({ before, limit = 500 }) {
      const bounded = Math.max(0, Math.min(500, Number(limit) || 0));
      if (!(before instanceof Date) || Number.isNaN(before.getTime()) || bounded === 0) {
        return 0;
      }
      return prisma.$transaction(async (client) => {
        await client.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await client.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        const rows = await client.$queryRawUnsafe(
        `WITH candidates AS MATERIALIZED (
           SELECT task.id, task.race_id, task.source_generation, task.dedupe_key,
             task.state, task.snapshot_state, task.intent_count, task.completed_at
           FROM race_resolution_post_tasks task
           WHERE task.state IN ('succeeded','succeeded_with_failures')
             AND task.completed_at < $1
             AND task.snapshot_state NOT IN ('pending','attempting')
             AND NOT EXISTS (
               SELECT 1 FROM race_resolution_delivery_intents intent
               WHERE intent.task_id=task.id
                 AND intent.state IN ('pending','attempting')
             )
           ORDER BY task.completed_at ASC, task.id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), intent_receipts AS (
           INSERT INTO race_resolution_delivery_intent_receipts (
             delivery_key_hash, race_id, source_generation, task_dedupe_key,
             intent_kind, terminal_disposition, completed_at, created_at
           ) SELECT intent.delivery_key_hash, candidate.race_id,
                    candidate.source_generation, candidate.dedupe_key,
                    intent.kind, COALESCE(intent.provider_disposition,intent.state),
                    intent.completed_at, intent.completed_at
             FROM candidates candidate
             JOIN race_resolution_delivery_intents intent ON intent.task_id=candidate.id
           WHERE intent.state IN ('accepted','rejected_no_retry','ambiguous_at_most_once')
              AND intent.completed_at IS NOT NULL
           ON CONFLICT (delivery_key_hash) DO NOTHING
           RETURNING delivery_key_hash
         ), task_receipts AS (
           INSERT INTO race_resolution_post_task_receipts (
             race_id, source_generation, dedupe_key, terminal_state,
             snapshot_state, intent_count, failure_count, completed_at
           ) SELECT candidate.race_id, candidate.source_generation,
                    candidate.dedupe_key, candidate.state, candidate.snapshot_state,
                    candidate.intent_count,
                    COUNT(intent.id) FILTER (WHERE intent.state IN ('rejected_no_retry','ambiguous_at_most_once'))::int,
                    candidate.completed_at
             FROM candidates candidate
             LEFT JOIN race_resolution_delivery_intents intent ON intent.task_id=candidate.id
           GROUP BY candidate.id, candidate.race_id, candidate.source_generation,
              candidate.dedupe_key, candidate.state, candidate.snapshot_state,
              candidate.intent_count, candidate.completed_at
           ON CONFLICT (race_id,source_generation) DO NOTHING
           RETURNING race_id, source_generation, dedupe_key
         ), doomed AS (
           SELECT candidate.id
           FROM candidates candidate
           WHERE EXISTS (
               SELECT 1 FROM race_resolution_post_task_receipts receipt
               WHERE receipt.race_id=candidate.race_id
                 AND receipt.source_generation=candidate.source_generation
                 AND receipt.dedupe_key=candidate.dedupe_key
                 AND receipt.terminal_state=candidate.state
                 AND receipt.snapshot_state=candidate.snapshot_state
                 AND receipt.intent_count=candidate.intent_count
                 AND receipt.failure_count=(
                   SELECT COUNT(*)::int FROM race_resolution_delivery_intents failed
                    WHERE failed.task_id=candidate.id
                      AND failed.state IN ('rejected_no_retry','ambiguous_at_most_once')
                 )
                 AND receipt.completed_at IS NOT DISTINCT FROM candidate.completed_at
             )
             AND NOT EXISTS (
               SELECT 1 FROM race_resolution_delivery_intents intent
               LEFT JOIN race_resolution_delivery_intent_receipts receipt
                 ON receipt.delivery_key_hash=intent.delivery_key_hash
               WHERE intent.task_id=candidate.id
                 AND (
                   receipt.delivery_key_hash IS NULL
                   OR receipt.race_id<>candidate.race_id
                   OR receipt.source_generation<>candidate.source_generation
                   OR receipt.task_dedupe_key<>candidate.dedupe_key
                   OR receipt.intent_kind<>intent.kind
                   OR receipt.terminal_disposition<>
                     COALESCE(intent.provider_disposition,intent.state)
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM intent_receipts inserted
                   WHERE inserted.delivery_key_hash=intent.delivery_key_hash
                 )
             )
         )
         DELETE FROM race_resolution_post_tasks task
         USING doomed
         WHERE task.id=doomed.id
         RETURNING task.id`,
        before,
        bounded
      );
        return rows.length;
      }, { timeout: 3_000, maxWait: 2_000 });
    },

    async readinessSnapshot({ now = new Date() } = {}) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT
           COALESCE((
             SELECT EXTRACT(EPOCH FROM ($1 - MIN(requested_at))) * 1000
             FROM race_resolution_post_tasks
             WHERE state IN ('queued','running')
           ), 0)::float8 AS "oldestPendingLagMs",
           (
             (SELECT COUNT(*) FROM race_resolution_delivery_intents intent
              JOIN race_resolution_post_tasks task ON task.id=intent.task_id
              WHERE intent.state='attempting'
                AND task.lease_expires_at IS NOT NULL
                AND task.lease_expires_at <= $1)
             +
             (SELECT COUNT(*) FROM race_resolution_post_tasks task
              WHERE task.snapshot_state='attempting'
                AND task.lease_expires_at IS NOT NULL
                AND task.lease_expires_at <= $1)
           )::int AS "expiredAttemptCount"`,
        now
      );
      return {
        oldestPendingLagMs: Math.max(0, Number(rows[0]?.oldestPendingLagMs || 0)),
        expiredAttemptCount: Math.max(0, Number(rows[0]?.expiredAttemptCount || 0)),
      };
    },
  };
  return model;
}

const RaceResolutionPostTask = buildRaceResolutionPostTaskModel();

module.exports = {
  TASK_STATES, SNAPSHOT_STATES, INTENT_STATES, INTENT_KINDS,
  MAX_PAYLOAD_BYTES, MAX_INTENT_BYTES, MAX_INTENTS, LEASE_MS,
  validatePostTaskPayload, buildRaceResolutionPostTaskModel, RaceResolutionPostTask,
};
