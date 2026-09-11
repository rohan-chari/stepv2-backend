const { prisma: defaultPrisma } = require("../../../db");
const {
  canonicalDomainEventEnvelope,
  DomainEventReceipt,
} = require("../models/domainEventReceipt");
const {
  DomainEventReceiptRecovery: defaultRecovery,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_LEASE_MS,
} = require("../models/domainEventReceiptRecovery");
const {
  coordinatedOptimizationMetrics: defaultMetrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");
const { createPostgresWakeCoordinator } = require("../../../shared/queues/postgresWakeCoordinator");
const { subscribeDurableQueueWakeup } = require("../../../shared/cache/redisCache");

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FALLBACK_INTERVAL_MS = 60_000;

function sourceEnvelope(event) {
  if (!event || !event.id) {
    const error = new Error("domain event source was deleted");
    error.code = "SOURCE_DELETED";
    error.terminal = true;
    throw error;
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
      !Array.isArray(event.audience)) {
    const error = new Error("domain event source is malformed");
    error.code = "MALFORMED_SOURCE";
    throw error;
  }
  return canonicalDomainEventEnvelope({
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
  });
}

function buildDomainEventReceiptRecoveryWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const recovery = dependencies.recovery || defaultRecovery;
  const receiptModel = dependencies.receiptModel || DomainEventReceipt;
  const now = dependencies.now || (() => new Date());
  const metrics = dependencies.metrics || defaultMetrics;
  const logger = dependencies.logger || console;
  const customLoadEvent = dependencies.loadEvent;

  async function loadContexts(ids) {
    if (customLoadEvent) {
      return Promise.all(ids.map(async (id) => [id, await customLoadEvent(id)]));
    }
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      return tx.domainEventOutbox.findMany({
        where: { id: { in: ids } },
        include: { audience: { orderBy: { ordinal: "asc" } } },
      });
    }, { timeout: 5_000, maxWait: 2_000 });
    return rows.map((row) => [row.id, row]);
  }

  async function repair(candidate, event) {
    if (!event || !event.id) {
      const error = new Error("domain event source was deleted");
      error.code = "SOURCE_DELETED";
      error.terminal = true;
      throw error;
    }
    // Validate the durable candidate identity before attempting to interpret
    // any other source field. A corrupt source payload must not hide a
    // candidate-to-source identity mismatch.
    if (candidate.eventKey !== event.eventKey) {
      const error = new Error("recovery candidate event key does not match its source event");
      error.code = "SOURCE_EVENT_KEY_MISMATCH";
      error.terminal = true;
      throw error;
    }
    const envelope = sourceEnvelope(event);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      // The envelope/audience batch is immutable, but lifecycle state is not.
      // Serialize with completion/retention before creating a missing receipt;
      // otherwise the terminal bridge can run before there is a row to update.
      const [currentSource] = await tx.$queryRawUnsafe(`
        SELECT event_key AS "eventKey",status,completed_at AS "completedAt"
        FROM domain_event_outbox WHERE id=$1::uuid FOR UPDATE`, event.id);
      if (!currentSource) {
        const error = new Error("domain event source was deleted");
        error.code = "SOURCE_DELETED";
        error.terminal = true;
        throw error;
      }
      if (currentSource.eventKey !== candidate.eventKey) {
        const error = new Error("recovery candidate event key does not match its source event");
        error.code = "SOURCE_EVENT_KEY_MISMATCH";
        error.terminal = true;
        throw error;
      }
      const terminalStatus = ["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"].includes(currentSource.status)
        ? currentSource.status : null;
      const existing = await tx.domainEventReceipt.findUnique({ where: { eventKey: candidate.eventKey } });
      if (existing?.receiptState === "FINAL") {
        receiptModel.assertEnvelope(existing, envelope);
        receiptModel.assertIdentity(existing, {
          domainEventId: event.id,
          replaySourceType: event.aggregateType,
          replaySourceId: event.aggregateId,
        });
      } else if (existing) {
        await receiptModel.finalize({
          envelope,
          domainEventId: event.id,
          replaySourceType: event.aggregateType,
          replaySourceId: event.aggregateId,
          terminalStatus,
          completedAt: currentSource.completedAt,
        }, tx);
      } else {
        await receiptModel.reserve({
          envelope,
          domainEventId: event.id,
          replaySourceType: event.aggregateType,
          replaySourceId: event.aggregateId,
          terminalStatus,
          completedAt: currentSource.completedAt,
        }, tx);
      }
      return recovery.completeSuccess({ id: candidate.id, leaseToken: candidate.leaseToken, now: now() }, tx);
    }, { timeout: 5_000, maxWait: 2_000 });
    if (result) {
      metrics.increment("domain_event_receipt_repaired_total", { reason: candidate.reason });
      const ageSeconds = Math.max(0, (now().getTime() - new Date(candidate.createdAt || now()).getTime()) / 1000);
      metrics.observe("domain_event_receipt_recovery_age_seconds", ageSeconds, { reason: candidate.reason });
    }
    return result;
  }

  async function fail(candidate, error) {
    const outcome = await recovery.completeFailure({
      id: candidate.id,
      leaseToken: candidate.leaseToken,
      errorCode: error.code || "RECOVERY_ERROR",
      now: now(),
      retryable: error.terminal !== true,
    }, prisma);
    if (!outcome.applied) return false;
    metrics.increment("domain_event_receipt_failed_total", { reason: candidate.reason });
    if (outcome.terminal) {
      metrics.increment("domain_event_receipt_quarantined_total", { reason: error.code || "RECOVERY_ERROR" });
    }
    return true;
  }

  async function drain({ batchSize = DEFAULT_BATCH_SIZE, now: requestedNow } = {}) {
    const current = requestedNow || now();
    const claimed = await recovery.claimPage({ now: current, limit: Math.min(DEFAULT_BATCH_SIZE, batchSize), leaseMs: RECOVERY_LEASE_MS }, prisma);
    for (const candidate of claimed.rows) {
      metrics.increment("domain_event_receipt_recovery_claim_total", { reason: candidate.reason });
    }
    if (claimed.terminalized > 0) {
      metrics.increment("domain_event_receipt_quarantined_total", { reason: "MAX_ATTEMPTS" }, claimed.terminalized);
    }
    if (!claimed.rows.length) return { claimed: 0, succeeded: 0, failed: 0, terminalized: claimed.terminalized };
    const contexts = new Map(await loadContexts(claimed.rows.map((row) => row.domainEventId)));
    let succeeded = 0;
    let failed = 0;
    for (const candidate of claimed.rows) {
      try {
        if (await repair(candidate, contexts.get(candidate.domainEventId))) succeeded += 1;
      } catch (error) {
        if (await fail(candidate, error)) failed += 1;
      }
    }
    return { claimed: claimed.rows.length, succeeded, failed, terminalized: claimed.terminalized };
  }

  return { drain };
}

function scheduleDomainEventReceiptRecovery(dependencies = {}) {
  const worker = buildDomainEventReceiptRecoveryWorker(dependencies);
  const prisma = dependencies.prisma || defaultPrisma;
  const recovery = dependencies.recovery || defaultRecovery;
  const logger = dependencies.logger || console;
  async function tick() {
    // Fresh repair always runs first. A discovery lock/error cannot roll back
    // repairs already committed or prevent them on the next paced attempt.
    const repaired = await worker.drain({ batchSize: dependencies.batchSize || DEFAULT_BATCH_SIZE });
    const discovery = await recovery.discoverAutomaticPage();
    return { ...repaired, discovery };
  }
  const coordinator = createPostgresWakeCoordinator({
    queue: "domain-event-receipt-recovery",
    fallbackIntervalMs: dependencies.fallbackIntervalMs || DEFAULT_FALLBACK_INTERVAL_MS,
    drain: tick,
    nextDueAt: async () => {
      const [row] = await prisma.$queryRawUnsafe(
        `SELECT LEAST(
          (SELECT MIN(available_at) FROM domain_event_receipt_recovery WHERE status IN ('QUEUED','RETRY')),
          (SELECT MIN(lease_until) FROM domain_event_receipt_recovery WHERE status='PROCESSING')
        ) AS "dueAt"`,
      );
      const current = dependencies.now?.() || new Date();
      const discoveryDue = await recovery.automaticDiscoveryDueAt({ now: current });
      const dueTimes = [row?.dueAt, discoveryDue].filter(Boolean).map((value) => new Date(value).getTime());
      // A FINAL-only source page still needs a follow-up tick. Discovery's
      // durable checkpoint and admission budget decide whether it is due.
      return dueTimes.length ? new Date(Math.max(Math.min(...dueTimes), current.getTime() + 1000)) : null;
    },
    subscribeWake: dependencies.subscribeWake || subscribeDurableQueueWakeup,
    logger,
    now: dependencies.now,
  });
  const ready = coordinator.start().catch((error) => logger.error("[CRON] domain receipt recovery start failed", {
    errorCode: error?.code || "DOMAIN_EVENT_RECEIPT_RECOVERY_START_ERROR",
  }));
  logger.log("[CRON] Domain-event receipt recovery scheduled");
  return { ...coordinator, ready, tick };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FALLBACK_INTERVAL_MS,
  MAX_RECOVERY_ATTEMPTS,
  buildDomainEventReceiptRecoveryWorker,
  scheduleDomainEventReceiptRecovery,
};
