const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const DIGEST_VERSION = 1;

function canonicalizeJson(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function iso(value, name) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`invalid ${name}`);
  return parsed.toISOString();
}

function canonicalDomainEventEnvelope(input) {
  const audience = [...(input.audience || [])]
    .map((entry) => ({
      ordinal: Number(entry.ordinal),
      recipientId: String(entry.recipientId),
      facts: canonicalizeJson(entry.facts || {}),
    }))
    .sort((left, right) => left.ordinal - right.ordinal);
  if (audience.some((entry, index) =>
    !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0 ||
    (index > 0 && audience[index - 1].ordinal === entry.ordinal)
  )) {
    throw new TypeError("invalid or duplicate audience ordinal");
  }
  return {
    eventKey: String(input.eventKey),
    eventType: String(input.eventType),
    schemaVersion: Number(input.schemaVersion),
    aggregateType: String(input.aggregateType),
    aggregateId: String(input.aggregateId),
    occurredAt: iso(input.occurredAt, "occurredAt"),
    availableAt: iso(input.availableAt, "availableAt"),
    payload: canonicalizeJson(input.payload || {}),
    audience,
  };
}

function digestDomainEventEnvelope(input) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalDomainEventEnvelope(input)), "utf8")
    .digest("hex");
}

function buildDomainEventReceiptModel(prisma = defaultPrisma) {
  const model = {
    async findByEventKey(eventKey, tx = prisma) {
      return tx.domainEventReceipt.findUnique({ where: { eventKey } });
    },
    async reserve({
      envelope, replaySourceType, replaySourceId, domainEventId,
      terminalStatus = null, completedAt = null,
    }, tx = prisma) {
      const canonical = canonicalDomainEventEnvelope(envelope);
      const digest = digestDomainEventEnvelope(canonical);
      const now = new Date();
      const inserted = await tx.domainEventReceipt.createMany({
        data: [{
          eventKey: canonical.eventKey,
          domainEventId,
          eventType: canonical.eventType,
          schemaVersion: canonical.schemaVersion,
          aggregateType: canonical.aggregateType,
          aggregateId: canonical.aggregateId,
          occurredAt: new Date(canonical.occurredAt),
          availableAt: new Date(canonical.availableAt),
          envelopeDigest: digest,
          receiptState: "FINAL",
          digestVersion: DIGEST_VERSION,
          replaySourceType,
          replaySourceId,
          terminalStatus,
          completedAt,
          finalizedAt: now,
          createdAt: now,
          updatedAt: now,
        }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) return { inserted: true, digest };
      const existing = await tx.domainEventReceipt.findUniqueOrThrow({
        where: { eventKey: canonical.eventKey },
      });
      if (existing.receiptState !== "FINAL" || existing.envelopeDigest !== digest ||
          existing.domainEventId !== domainEventId ||
          existing.replaySourceType !== replaySourceType ||
          existing.replaySourceId !== replaySourceId ||
          (terminalStatus != null && existing.terminalStatus !== terminalStatus) ||
          (completedAt != null &&
            existing.completedAt?.getTime() !== new Date(completedAt).getTime())) {
        const error = new Error("domain event receipt immutable envelope mismatch");
        error.code = "DOMAIN_EVENT_RECEIPT_COLLISION";
        throw error;
      }
      return { inserted: false, digest, receipt: existing };
    },
    assertEnvelope(receipt, envelope) {
      const digest = digestDomainEventEnvelope(envelope);
      if (receipt?.receiptState !== "FINAL" || receipt.envelopeDigest !== digest) {
        const error = new Error("domain event receipt immutable envelope mismatch");
        error.code = "DOMAIN_EVENT_RECEIPT_COLLISION";
        throw error;
      }
      return digest;
    },
    assertIdentity(receipt, { domainEventId = null, replaySourceType, replaySourceId }) {
      if ((domainEventId != null && receipt?.domainEventId !== domainEventId) ||
          receipt?.replaySourceType !== replaySourceType ||
          receipt?.replaySourceId !== replaySourceId) {
        const error = new Error("domain event receipt immutable source identity mismatch");
        error.code = "DOMAIN_EVENT_RECEIPT_COLLISION";
        throw error;
      }
      return true;
    },
    async finalize({
      envelope, domainEventId, replaySourceType, replaySourceId,
      terminalStatus = null, completedAt = null,
    }, tx = prisma) {
      const [receipt] = await model.finalizeMany({
        items: [{
          envelope, domainEventId, replaySourceType, replaySourceId,
          terminalStatus, completedAt,
        }],
      }, tx);
      return receipt;
    },
    async finalizeMany({ items = [] }, tx = prisma) {
      if (!items.length) return [];
      const current = new Date();
      const input = items.map((item) => ({
        eventKey: item.envelope.eventKey,
        domainEventId: item.domainEventId,
        digest: digestDomainEventEnvelope(item.envelope),
        replaySourceType: item.replaySourceType,
        replaySourceId: item.replaySourceId,
        terminalStatus: item.terminalStatus || null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
      }));
      const receipts = await tx.$queryRawUnsafe(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
             "eventKey" text,"domainEventId" uuid,digest text,
             "replaySourceType" text,"replaySourceId" text,
             "terminalStatus" text,"completedAt" timestamp
           )
         ), updated AS (
           UPDATE domain_event_receipts receipt
              SET envelope_digest=input.digest,receipt_state='FINAL',digest_version=$2,
                  replay_source_type=input."replaySourceType",
                  replay_source_id=input."replaySourceId",
                  terminal_status=COALESCE(input."terminalStatus",receipt.terminal_status),
                  completed_at=COALESCE(input."completedAt",receipt.completed_at),
                  finalized_at=$3,updated_at=$3
             FROM input
            WHERE receipt.event_key=input."eventKey"
              AND receipt.domain_event_id=input."domainEventId"
              AND (receipt.receipt_state='PROVISIONAL' OR
                   (receipt.receipt_state='FINAL'
                    AND receipt.envelope_digest=input.digest
                    AND receipt.replay_source_type=input."replaySourceType"
                    AND receipt.replay_source_id=input."replaySourceId"
                    AND (receipt.terminal_status IS NULL OR input."terminalStatus" IS NULL OR
                         receipt.terminal_status=input."terminalStatus")
                    AND (receipt.completed_at IS NULL OR input."completedAt" IS NULL OR
                         receipt.completed_at=input."completedAt")))
           RETURNING receipt.*
         ) SELECT * FROM updated`,
        JSON.stringify(input), DIGEST_VERSION, current,
      );
      if (receipts.length !== input.length) {
        const error = new Error("domain event receipt immutable envelope mismatch");
        error.code = "DOMAIN_EVENT_RECEIPT_COLLISION";
        throw error;
      }
      const byKey = new Map(receipts.map((receipt) => [receipt.event_key || receipt.eventKey, receipt]));
      return items.map((item) => byKey.get(item.envelope.eventKey));
    },
    async backfillPage({ limit = 100 } = {}, tx = prisma) {
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 100));
      return tx.$transaction(async (client) => {
        const candidates = await client.$queryRawUnsafe(
          `SELECT event.id
             FROM domain_event_outbox event
             LEFT JOIN domain_event_receipts receipt
               ON receipt.domain_event_id=event.id
            WHERE receipt.event_key IS NULL OR receipt.receipt_state='PROVISIONAL'
            ORDER BY event.created_at,event.id
            LIMIT $1
            FOR UPDATE OF event SKIP LOCKED`,
          pageSize,
        );
        if (!candidates.length) return 0;
        const events = await client.domainEventOutbox.findMany({
          where: { id: { in: candidates.map((row) => row.id) } },
          include: { audience: { orderBy: { ordinal: "asc" } } },
        });
        for (const event of events) {
          const envelope = {
            eventKey: event.eventKey,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            occurredAt: event.occurredAt,
            availableAt: event.availableAt,
            payload: event.payload,
            audience: event.audience.map((row) => ({
              ordinal: row.ordinal,
              recipientId: row.recipientId,
              facts: row.facts,
            })),
          };
          const existing = await client.domainEventReceipt.findUnique({
            where: { eventKey: event.eventKey },
          });
          if (existing) {
            await model.finalize({
              envelope,
              domainEventId: event.id,
              replaySourceType: event.aggregateType,
              replaySourceId: event.aggregateId,
              terminalStatus: ["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"].includes(event.status)
                ? event.status : null,
              completedAt: event.completedAt,
            }, client);
          } else {
            await model.reserve({
              envelope,
              domainEventId: event.id,
              replaySourceType: event.aggregateType,
              replaySourceId: event.aggregateId,
              terminalStatus: ["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"].includes(event.status)
                ? event.status : null,
              completedAt: event.completedAt,
            }, client);
          }
        }
        return events.length;
      });
    },
    async cleanupDeletedSources({ limit = 500 } = {}, tx = prisma) {
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 500));
      return tx.$transaction(async (client) => {
        await client.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await client.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        const deleted = await client.$queryRawUnsafe(
        `WITH candidate AS MATERIALIZED (
           SELECT receipt.event_key
             FROM domain_event_receipts receipt
            WHERE receipt.receipt_state='FINAL'
              AND receipt.replay_source_type IN (
                'RACE','USER','FRIENDSHIP','RACE_MESSAGE','FEEDBACK_THREAD',
                'TOURNAMENT','GLOBAL_STEP_EVENT','GLOBAL_STEP_EVENT_ENTITLEMENT',
                'POWERUP','REFERRAL'
              )
              AND NOT EXISTS (
                SELECT 1 FROM domain_event_outbox event
                 WHERE event.id=receipt.domain_event_id
              )
              AND CASE receipt.replay_source_type
                WHEN 'RACE' THEN NOT EXISTS (
                  SELECT 1 FROM races source WHERE source.id=receipt.replay_source_id)
                WHEN 'USER' THEN NOT EXISTS (
                  SELECT 1 FROM users source WHERE source.id=receipt.replay_source_id)
                WHEN 'FRIENDSHIP' THEN NOT EXISTS (
                  SELECT 1 FROM friendships source WHERE source.id=receipt.replay_source_id)
                WHEN 'RACE_MESSAGE' THEN NOT EXISTS (
                  SELECT 1 FROM race_messages source WHERE source.id=receipt.replay_source_id)
                WHEN 'FEEDBACK_THREAD' THEN NOT EXISTS (
                  SELECT 1 FROM feedback_threads source WHERE source.id=receipt.replay_source_id)
                WHEN 'TOURNAMENT' THEN NOT EXISTS (
                  SELECT 1 FROM tournaments source WHERE source.id=receipt.replay_source_id)
                WHEN 'GLOBAL_STEP_EVENT' THEN NOT EXISTS (
                  SELECT 1 FROM global_step_events source WHERE source.id=receipt.replay_source_id)
                WHEN 'GLOBAL_STEP_EVENT_ENTITLEMENT' THEN NOT EXISTS (
                  SELECT 1 FROM global_step_event_entitlements source
                   WHERE source.id=receipt.replay_source_id)
                WHEN 'REFERRAL' THEN NOT EXISTS (
                  SELECT 1 FROM coin_transactions source WHERE source.id=receipt.replay_source_id)
                WHEN 'POWERUP' THEN NOT EXISTS (
                  SELECT 1 FROM race_active_effects source WHERE source.id=receipt.replay_source_id)
                  AND NOT EXISTS (
                  SELECT 1 FROM race_powerups source WHERE source.id=receipt.replay_source_id)
                  AND NOT EXISTS (
                  SELECT 1 FROM race_powerup_events source WHERE source.id=receipt.replay_source_id)
                  AND NOT EXISTS (
                  SELECT 1 FROM user_powerup_items source WHERE source.id=receipt.replay_source_id)
                ELSE false
              END
            ORDER BY receipt.created_at,receipt.event_key
            LIMIT $1
            FOR UPDATE OF receipt SKIP LOCKED
         ), removed AS (
           DELETE FROM domain_event_receipts receipt
           USING candidate
           WHERE receipt.event_key=candidate.event_key
           RETURNING receipt.event_key
         ) SELECT event_key FROM removed`,
        pageSize,
      );
        return deleted.length;
      }, { timeout: 3_000, maxWait: 2_000 });
    },
  };
  return model;
}

const DomainEventReceipt = buildDomainEventReceiptModel();

module.exports = {
  DIGEST_VERSION,
  canonicalizeJson,
  canonicalDomainEventEnvelope,
  digestDomainEventEnvelope,
  buildDomainEventReceiptModel,
  DomainEventReceipt,
};
