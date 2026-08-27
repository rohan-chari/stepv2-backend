const { prisma: defaultPrisma } = require("../../../db");
const { isGenerationUsable } = require("../../steps/models/globalStepEventGeneration");
const { MAX_ACTIVE_INSTALLATIONS } = require("../models/deviceRegistration");

const DAY_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 500;
const NONTERMINAL_TARGETS = ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"];

function buildDeviceTokenCleanup(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const batchSize = Math.min(BATCH_SIZE, Math.max(1, Number(dependencies.batchSize) || BATCH_SIZE));
  return async function cleanupDeviceTokens() {
    const current = now();
    if (!(await isGenerationUsable({ client: prisma, now: current }))) {
      return { generationReady: false, activated: 0, quarantined: 0, deleted: 0 };
    }
    const legacy = await prisma.deviceToken.findMany({
      where: { status: null },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: batchSize,
      select: { id: true },
    });
    if (legacy.length) await prisma.deviceToken.updateMany({
      where: { id: { in: legacy.map((row) => row.id) }, status: null },
      data: { status: "ACTIVE", statusChangedAt: current },
    });
    const duplicateGroups = await prisma.$queryRawUnsafe(
      `SELECT platform, token, array_agg(id ORDER BY
          last_registered_at DESC NULLS LAST, updated_at DESC, id DESC) AS ids
         FROM device_tokens WHERE status='ACTIVE'
        GROUP BY platform, token HAVING count(*) > 1
        ORDER BY platform, token LIMIT $1`,
      batchSize,
    );
    let quarantined = 0;
    for (const group of duplicateGroups) {
      const ids = group.ids.slice(1);
      if (!ids.length) continue;
      quarantined += (await prisma.deviceToken.updateMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        data: { status: "QUARANTINED", statusReason: "QUARANTINED_DUPLICATE_OWNER", statusChangedAt: current },
      })).count;
    }
    const duplicateInstallationGroups = await prisma.$queryRawUnsafe(
      `SELECT platform, installation_id, array_agg(id ORDER BY
          last_registered_at DESC NULLS LAST, updated_at DESC, id DESC) AS ids
         FROM device_tokens
        WHERE status='ACTIVE' AND installation_id IS NOT NULL
        GROUP BY platform, installation_id HAVING count(*) > 1
        ORDER BY platform, installation_id LIMIT $1`,
      batchSize,
    );
    for (const group of duplicateInstallationGroups) {
      const ids = group.ids.slice(1);
      if (!ids.length) continue;
      quarantined += (await prisma.deviceToken.updateMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        data: {
          installationId: null,
          status: "QUARANTINED",
          statusReason: "QUARANTINED_DUPLICATE_INSTALLATION",
          statusChangedAt: current,
        },
      })).count;
    }
    const overCapUsers = await prisma.$queryRawUnsafe(
      `SELECT user_id AS "userId" FROM device_tokens WHERE status='ACTIVE'
        GROUP BY user_id HAVING count(*) > $1 ORDER BY user_id LIMIT $2`,
      MAX_ACTIVE_INSTALLATIONS,
      batchSize,
    );
    for (const { userId } of overCapUsers) {
      const rows = await prisma.deviceToken.findMany({
        where: { userId, status: "ACTIVE" },
        orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        skip: MAX_ACTIVE_INSTALLATIONS,
        select: { id: true },
      });
      if (rows.length) quarantined += (await prisma.deviceToken.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: "ACTIVE" },
        data: { status: "QUARANTINED", statusReason: "QUARANTINED_CAP", statusChangedAt: current },
      })).count;
    }
    const stale = await prisma.deviceToken.findMany({
      where: {
        status: "ACTIVE",
        installationId: { not: null },
        lastRegisteredAt: { lt: new Date(current.getTime() - 90 * DAY_MS) },
      },
      orderBy: [{ lastRegisteredAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    });
    if (stale.length) quarantined += (await prisma.deviceToken.updateMany({
      where: { id: { in: stale.map((row) => row.id) }, status: "ACTIVE" },
      data: { status: "QUARANTINED", statusReason: "QUARANTINED_STALE", statusChangedAt: current },
    })).count;
    const deletable = await prisma.deviceToken.findMany({
      where: {
        OR: [
          { status: { in: ["INVALIDATED", "SUPERSEDED"] }, statusChangedAt: { lt: new Date(current.getTime() - 30 * DAY_MS) } },
          { status: "QUARANTINED", statusChangedAt: { lt: new Date(current.getTime() - 180 * DAY_MS) } },
        ],
        deliveryAttempts: { none: { disposition: { in: NONTERMINAL_TARGETS } } },
      },
      orderBy: [{ statusChangedAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    });
    const deleted = deletable.length
      ? (await prisma.deviceToken.deleteMany({ where: { id: { in: deletable.map((row) => row.id) } } })).count
      : 0;
    const quarantineStarted = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT
           (SELECT count(*) FROM device_tokens WHERE status IS NULL)::int AS "nullStatuses",
           (SELECT count(*) FROM (
              SELECT 1 FROM device_tokens WHERE status='ACTIVE'
               GROUP BY platform,token HAVING count(*) > 1
            ) conflicts)::int AS "tokenConflicts",
           (SELECT count(*) FROM (
              SELECT 1 FROM device_tokens
               WHERE status='ACTIVE' AND installation_id IS NOT NULL
               GROUP BY platform,installation_id HAVING count(*) > 1
            ) conflicts)::int AS "installationConflicts",
           (SELECT count(*) FROM (
              SELECT 1 FROM device_tokens WHERE status='ACTIVE'
               GROUP BY user_id HAVING count(*) > $1
            ) violations)::int AS "capViolations"`,
        MAX_ACTIVE_INSTALLATIONS,
      );
      const census = rows[0] || {};
      const clean = Number(census.nullStatuses) === 0 &&
        Number(census.tokenConflicts) === 0 &&
        Number(census.installationConflicts) === 0 &&
        Number(census.capViolations) === 0;
      if (!clean) return false;
      await tx.globalStepEventGenerationState.update({
        where: { id: 1 },
        data: { quarantineStartedAt: current },
      });
      return true;
    });
    return {
      generationReady: true,
      activated: legacy.length,
      quarantined,
      deleted,
      quarantineStarted,
      fullPage: !quarantineStarted || legacy.length === batchSize ||
        duplicateGroups.length === batchSize || duplicateInstallationGroups.length === batchSize ||
        stale.length === batchSize || deletable.length === batchSize,
    };
  };
}

function scheduleDeviceTokenCleanup(dependencies = {}) {
  const run = dependencies.run || buildDeviceTokenCleanup(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  let running = null;
  let timer = null;
  const tick = () => {
    if (stopped || running) return running;
    running = run().catch((error) => logger.error?.("[NOTIFICATION] device-token cleanup failed", {
      errorCode: error?.code || "DEVICE_TOKEN_CLEANUP_FAILED",
    })).finally(() => { running = null; });
    return running;
  };
  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await tick();
      arm(result?.fullPage ? 0 : (dependencies.intervalMs || 60 * 60_000));
    }, delay);
    timer.unref?.();
  };
  tick();
  arm(dependencies.intervalMs || 60 * 60_000);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}

module.exports = { DAY_MS, BATCH_SIZE, buildDeviceTokenCleanup, scheduleDeviceTokenCleanup };
