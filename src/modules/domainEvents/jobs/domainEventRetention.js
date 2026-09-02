const { prisma: defaultPrisma } = require("../../../db");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const defaultRepository = require("../models/domainEventOutbox");
const { DomainEventReceipt: defaultEventReceipts } = require("../models/domainEventReceipt");
const {
  NotificationScheduleReceipt: defaultScheduleReceipts,
} = require("../../notifications/models/notificationScheduleReceipt");
const {
  coordinatedOptimizationMetrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");
const {
  isReceiptCleanupCutoffAccepted: defaultIsReceiptCleanupCutoffAccepted,
} = require("../../../shared/queues/receiptCleanupCutoff");
const { createReceiptCleanupBudget } = require("../../../shared/queues/receiptCleanupBudget");

const JOB_NAME = "domain_event_retention";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
function buildDomainEventRetention(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const repository = dependencies.repository || defaultRepository;
  const JobRun = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const eventReceipts = dependencies.eventReceipts || defaultEventReceipts;
  const scheduleReceipts = dependencies.scheduleReceipts || defaultScheduleReceipts;
  const isReceiptCleanupCutoffAccepted =
    dependencies.isReceiptCleanupCutoffAccepted || defaultIsReceiptCleanupCutoffAccepted;
  return async function retainDomainEvents() {
    const current = now();
    const lastRanFor = await JobRun.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({
      now: current,
      targetHour: dependencies.targetHour ?? 2,
      lastRanFor,
    });
    if (!runKey || !(await JobRun.claimRun(JOB_NAME, runKey))) return null;
    let eventReceiptsBackfilled = 0;
    let scheduleReceiptsBackfilled = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const count = await eventReceipts.backfillPage({ limit: 500 });
      eventReceiptsBackfilled += count;
      if (count < 500) break;
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const count = await scheduleReceipts.backfillPage({ limit: 500 });
      scheduleReceiptsBackfilled += Number(count) || 0;
      if (Number(count) < 500) break;
    }
    const cutoffAccepted = await isReceiptCleanupCutoffAccepted();
    const payloadRetentionMs = cutoffAccepted ? 7 * 24 * 60 * 60 * 1000 : RETENTION_MS;
    const cutoff = new Date(current.getTime() - payloadRetentionMs);
    const cleanupBudget = dependencies.cleanupBudget || createReceiptCleanupBudget({ prisma });
    let cleanupPagesUsed = 0;
    const runCleanupPage = async (operation) => {
      if (cleanupPagesUsed >= MAX_PAGES) return null;
      cleanupPagesUsed += 1;
      return cleanupBudget.runPage(operation);
    };
    let deleted = 0;
    if (typeof repository.deleteRetentionPage === "function") {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const page = await runCleanupPage(() =>
          repository.deleteRetentionPage(prisma, { cutoff, pageSize: 500 }));
        if (!page) break;
        const pageDeleted = page.rows;
        deleted += pageDeleted;
        coordinatedOptimizationMetrics.increment(
          "durable_queue_cleanup_rows_total", { table: "domain_event_outbox" }, pageDeleted,
        );
        const pageDurationSeconds = Number(page.durationMs || 0) / 1000;
        coordinatedOptimizationMetrics.observe(
          "durable_queue_cleanup_seconds",
          pageDurationSeconds,
          { table: "domain_event_outbox" },
        );
        if (!page.allowedContinue) {
          logger.error("[CRON] Domain-event retention stopped by cleanup evidence gate", {
            durationMs: page.durationMs,
            walBytes: page.walBytes,
            totalWalBytes: page.totalWalBytes,
            replicaLagSeconds: page.replicaLagSeconds,
            evidenceUnavailable: page.evidenceUnavailable === true,
          });
          break;
        }
        if (pageDeleted < 500) break;
      }
    } else for (;;) {
      const candidates = await repository.findRetentionCandidates(prisma, {
        cutoff,
        pageSize: PAGE_SIZE,
      });
      if (!candidates.length) break;
      let pageDeleted = 0;
      for (const event of candidates) {
        const keys = event.projections.map((row) => row.deliveryKey);
        const active = await repository.countActiveDownstream(prisma, keys);
        if (active.schedules || active.inboxOutbox || active.deviceAttempts) continue;
        const removed = await repository.deleteRetainedEvent(prisma, {
          id: event.id,
          cutoff,
        });
        pageDeleted += removed.count;
      }
      deleted += pageDeleted;
      if (candidates.length < PAGE_SIZE || pageDeleted === 0) break;
    }
    let eventReceiptsDeleted = 0;
    let scheduleReceiptsDeleted = 0;
    let schedulePayloadsDeleted = 0;
    if (cutoffAccepted && typeof scheduleReceipts.cleanupTerminalPayloads === "function") {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const pageResult = await runCleanupPage(() =>
          scheduleReceipts.cleanupTerminalPayloads({ limit: 500 }));
        if (!pageResult) break;
        const count = pageResult.rows;
        schedulePayloadsDeleted += count;
        coordinatedOptimizationMetrics.increment(
          "durable_queue_cleanup_rows_total", { table: "notification_schedules" }, count,
        );
        if (!pageResult.allowedContinue || count < 500) break;
      }
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageResult = await runCleanupPage(() =>
        eventReceipts.cleanupDeletedSources({ limit: 500 }));
      if (!pageResult) break;
      const count = pageResult.rows;
      eventReceiptsDeleted += count;
      coordinatedOptimizationMetrics.increment(
        "durable_queue_cleanup_rows_total", { table: "domain_event_receipts" }, count,
      );
      if (!pageResult.allowedContinue || count < 500) break;
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageResult = await runCleanupPage(() =>
        scheduleReceipts.cleanupEligible({ now: current, limit: 500 }));
      if (!pageResult) break;
      const count = pageResult.rows;
      scheduleReceiptsDeleted += count;
      coordinatedOptimizationMetrics.increment(
        "durable_queue_cleanup_rows_total", { table: "notification_schedule_receipts" }, count,
      );
      if (!pageResult.allowedContinue || count < 500) break;
    }
    const result = {
      deleted,
      eventReceiptsBackfilled,
      scheduleReceiptsBackfilled,
      eventReceiptsDeleted,
      schedulePayloadsDeleted,
      scheduleReceiptsDeleted,
      cleanupPagesUsed,
    };
    logger.log("[CRON] Domain-event retention complete", { runKey, ...result });
    return result;
  };
}

function scheduleDomainEventRetention(dependencies = {}) {
  const run = buildDomainEventRetention(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] domainEventRetention tick error", {
    errorCode: error?.code || "DOMAIN_EVENT_RETENTION_ERROR",
  }));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Domain-event retention scheduled (30d)");
  return { tick, stop: () => clearInterval(interval) };
}

module.exports = {
  JOB_NAME,
  RETENTION_MS,
  PAGE_SIZE,
  MAX_PAGES,
  buildDomainEventRetention,
  scheduleDomainEventRetention,
};
