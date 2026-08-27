const { prisma: defaultPrisma } = require("../../../db");
const { isGenerationUsable } = require("../models/globalStepEventGeneration");
const {
  appendScheduledEntitlementEventsBatch,
} = require("../services/globalStepEventEntitlement");

function buildGlobalEventEntitlementEventReconciler(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const pageSize = Math.min(500, Math.max(1, Number(dependencies.pageSize) || 500));
  const generationUsable = dependencies.generationUsable || isGenerationUsable;
  const appendBatch = dependencies.appendBatch || appendScheduledEntitlementEventsBatch;
  return async function reconcileEntitlementEvents() {
    const current = now();
    if (!(await generationUsable({ client: prisma, now: current }))) {
      return { published: 0, generationReady: false };
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT entitlement.id
         FROM global_step_event_entitlements entitlement
        WHERE entitlement.ends_at > $1
          AND NOT EXISTS (
            SELECT 1 FROM domain_event_outbox event
             WHERE event.event_key =
               'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:' || entitlement.id || ':' || entitlement.schedule_revision::text
          )
        ORDER BY entitlement.created_at, entitlement.id
        LIMIT $2`,
      current,
      pageSize,
    );
    const published = rows.length > 0
      ? await prisma.$transaction(async (tx) => {
        const entitlements = await tx.globalStepEventEntitlement.findMany({
          where: { id: { in: rows.map((row) => row.id) }, endsAt: { gt: current } },
          include: { event: true },
        });
        await appendBatch(tx, { entitlements, occurredAt: current });
        return entitlements.length;
      }, { timeout: 15_000, maxWait: 10_000 })
      : 0;
    return { published, generationReady: true, fullPage: rows.length === pageSize };
  };
}

function scheduleGlobalEventEntitlementEventReconciler(dependencies = {}) {
  const run = dependencies.run || buildGlobalEventEntitlementEventReconciler(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  let running = null;
  let timer = null;
  const tick = () => {
    if (stopped || running) return running;
    running = run().catch((error) => logger.error?.("[GLOBAL_EVENT] entitlement event reconciliation failed", {
      errorCode: error?.code || "ENTITLEMENT_EVENT_RECONCILE_FAILED",
    })).finally(() => { running = null; });
    return running;
  };
  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await tick();
      arm(result?.fullPage ? 0 : (dependencies.intervalMs || 60_000));
    }, delay);
    timer.unref?.();
  };
  tick();
  arm(dependencies.intervalMs || 60_000);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}

module.exports = {
  buildGlobalEventEntitlementEventReconciler,
  scheduleGlobalEventEntitlementEventReconciler,
};
