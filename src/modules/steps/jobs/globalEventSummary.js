const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { invalidate } = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const {
  createSummaryWorkForEntitlement,
  legacyGlobalSummaryEntitlement,
} = require("../services/globalEventSummaryLifecycle");
const {
  canonicalize,
} = require("../services/globalEventSummaryCapture");
const {
  RaceResolutionJobV2,
} = require("../../races/models/raceResolutionJobV2");

const ACTIVE_WORK_STATES = ["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"];
const RACE_RECONCILE_STATES = ["WAITING_RACES", "UNSCORABLE", "EXPIRED_UNDELIVERED"];
const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_TICK_BUDGET_MS = 750;

async function invalidateUser(userId) {
  await invalidate({
    keys: [cacheKeys.homeImpactSummary(userId)],
    prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
  });
}

async function writeJobFence(tx, work, outcome) {
  try {
    await tx.jobRun.create({
      data: {
        jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`,
        lastRanFor: outcome,
      },
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }
}

async function pendingWorkRaceIds(client, work) {
  const impacts = await client.globalEventRaceImpact.findMany({
    where: {
      eventId: work.eventId,
      userId: work.userId,
      status: "PENDING",
    },
    select: { raceId: true },
    orderBy: { raceId: "asc" },
  });
  return [...new Set(impacts.map((row) => row.raceId))].sort();
}

async function enqueueWorkRaceIds(client, work, raceIds, current) {
  if (raceIds.length === 0) return [];
  return RaceResolutionJobV2.enqueueMany({
    raceIds,
    now: current,
    triggeredUserIdsByRaceId: new Map(raceIds.map((raceId) => [raceId, [work.userId]])),
    dirtyEnvelopeByRaceId: new Map(raceIds.map((raceId) => [raceId, {
      reason: "GLOBAL_EVENT_BOUNDARY",
      dirtyUserIds: [work.userId],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "IMMEDIATE",
    }])),
    queuePriority: "MAINTENANCE",
  }, client);
}

async function reconcileWorkRaceQueues(prisma, current, batchSize, options = {}) {
  const candidates = await prisma.globalEventSummaryWork.findMany({
    where: {
      status: { in: RACE_RECONCILE_STATES },
      raceReconciledAt: null,
    },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  let reconciled = 0;
  for (const work of candidates) {
    try {
      // No summary-work transaction is open here. The sorted C0 queue upsert
      // commits first; only then is the durable handoff stamped. A crash in
      // between retries the idempotent enqueue from the still-null stamp.
      const raceIds = await pendingWorkRaceIds(prisma, work);
      await enqueueWorkRaceIds(prisma, work, raceIds, current);
      await options.afterSummaryRaceEnqueue?.(work, raceIds);
      const stamped = await prisma.globalEventSummaryWork.updateMany({
        where: {
          id: work.id,
          status: work.status,
          raceReconciledAt: null,
        },
        data: { raceReconciledAt: current },
      });
      reconciled += stamped.count;
    } catch (error) {
      options.logger?.error?.("[CRON] global event summary race reconciliation retryable error", {
        workId: work.id,
        errorCode: error?.code || "RETRYABLE_ERROR",
      });
    }
  }
  return reconciled;
}

async function expireWork(prisma, work, current, options = {}) {
  let expired = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.globalEventSummaryWork.updateMany({
      where: {
        id: work.id,
        status: { in: ACTIVE_WORK_STATES },
        leaseToken: work.leaseToken,
      },
      data: {
        status: "EXPIRED_UNDELIVERED",
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: "DEADLINE_PASSED",
        raceReconciledAt: null,
      },
    });
    if (claimed.count !== 1) return;
    expired = true;
    await writeJobFence(tx, work, "EXPIRED_UNDELIVERED");
  });
  if (expired) {
    await options.afterSummaryWorkTransition?.({
      ...work,
      status: "EXPIRED_UNDELIVERED",
    });
    await invalidateUser(work.userId);
  }
  return expired;
}

async function terminalizeUnscorable(prisma, work, current, reason, options = {}) {
  let terminalized = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.globalEventSummaryWork.updateMany({
      where: {
        id: work.id,
        status: { in: ACTIVE_WORK_STATES },
        leaseToken: work.leaseToken,
      },
      data: {
        status: "UNSCORABLE",
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: reason,
        raceReconciledAt: null,
      },
    });
    if (claimed.count !== 1) return;
    terminalized = true;
    await writeJobFence(tx, work, "UNSCORABLE");
  });
  if (terminalized) {
    await options.afterSummaryWorkTransition?.({ ...work, status: "UNSCORABLE" });
    await invalidateUser(work.userId);
  }
  return terminalized;
}

async function resolveArtifacts(prisma, work, current, options = {}) {
  const impactVector = await prisma.globalEventRaceImpact.findMany({
    where: { eventId: work.eventId, userId: work.userId },
    select: { attributionVersion: true },
  });
  if (impactVector.length !== work.requiredRaceCount ||
      impactVector.some((impact) => impact.attributionVersion !== 2)) {
    await terminalizeUnscorable(
      prisma,
      work,
      current,
      "DEPENDENCY_INPUT_UNREPLAYABLE",
      options,
    );
    return;
  }
  const artifacts = await prisma.globalEventCaptureArtifact.findMany({
    where: { workId: work.id },
    orderBy: { raceId: "asc" },
  });
  if (artifacts.length !== work.requiredRaceCount) {
    await terminalizeUnscorable(prisma, work, current, "INPUTS_NOT_RETAINED", options);
    return;
  }
  for (const artifact of artifacts) {
    const digest = crypto.createHash("sha256")
      .update(Buffer.from(canonicalize(artifact.payload), "utf8"))
      .digest("hex");
    if (digest !== artifact.payloadDigest || artifact.schemaVersion !== 1) {
      await terminalizeUnscorable(prisma, work, current, "INPUTS_NOT_RETAINED", options);
      return;
    }
  }
  let transitioned = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.globalEventSummaryWork.updateMany({
      where: {
        id: work.id,
        status: { in: ["QUEUED", "PROCESSING"] },
        leaseToken: work.leaseToken,
      },
      data: {
        status: "WAITING_RACES",
        finalRaceCount: 0,
        leaseUntil: null,
        leaseToken: null,
        raceReconciledAt: null,
      },
    });
    if (claimed.count !== 1) return;
    transitioned = true;
  });
  if (transitioned) {
    await options.afterSummaryWorkTransition?.({ ...work, status: "WAITING_RACES" });
    await invalidateUser(work.userId);
  }
  return transitioned;
}

async function aggregateReadyWork(prisma, work, current, options = {}) {
  let result = { committed: false, nonzero: false, terminalized: false };
  try {
    result = await prisma.$transaction(async (tx) => {
      // The database impact trigger takes this same group row for every old or
      // new impact INSERT/UPDATE. Lock it before reading the vector so no
      // impact can cross the readiness decision and terminal summary commit.
      const locked = await tx.$queryRawUnsafe(
        `SELECT id
           FROM global_event_summary_work
          WHERE id = $1
            AND status = 'WAITING_RACES'
            AND expires_at > $2::timestamp
            AND lease_token = $3
          FOR UPDATE`,
        work.id,
        current,
        work.leaseToken,
      );
      if (locked.length !== 1) {
        return { committed: false, nonzero: false, terminalized: false };
      }
      await options.afterSummaryWorkLock?.(work, tx);
      const impacts = await tx.globalEventRaceImpact.findMany({
        where: { eventId: work.eventId, userId: work.userId },
        select: { status: true, deltaSteps: true, attributionVersion: true },
        orderBy: { raceId: "asc" },
      });
      const incompatible = impacts.length !== work.requiredRaceCount ||
        impacts.some((impact) =>
          impact.attributionVersion !== 2 ||
          !["PENDING", "FINAL"].includes(impact.status));
      if (incompatible) {
        await tx.globalEventSummaryWork.update({
          where: { id: work.id },
          data: {
            status: "UNSCORABLE",
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: "DEPENDENCY_INPUT_UNREPLAYABLE",
            raceReconciledAt: null,
          },
        });
        await tx.jobRun.upsert({
          where: {
            jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`,
          },
          update: {},
          create: {
            jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`,
            lastRanFor: "UNSCORABLE",
          },
        });
        return { committed: false, nonzero: false, terminalized: true };
      }
      if (impacts.length !== work.requiredRaceCount ||
          impacts.some((impact) => impact.status !== "FINAL")) {
        return { committed: false, nonzero: false, terminalized: false };
      }
      const nonzero = impacts.some((impact) => Number(impact.deltaSteps) !== 0);
      const outcome = nonzero ? "CREATED" : "ALL_ZERO";
      await tx.globalEventSummaryWork.update({
        where: { id: work.id },
        data: {
          status: outcome,
          finalRaceCount: impacts.length,
          leaseUntil: null,
          leaseToken: null,
        },
      });
      await tx.jobRun.create({
        data: {
          jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`,
          lastRanFor: outcome,
        },
      });
      if (nonzero) {
        await tx.globalEventUserSummary.upsert({
          where: { eventId_userId: { eventId: work.eventId, userId: work.userId } },
          update: {},
          create: {
            eventId: work.eventId,
            userId: work.userId,
            extraRaceSteps: impacts.reduce(
              (sum, impact) => sum + Number(impact.deltaSteps || 0),
              0,
            ),
            raceCount: impacts.length,
            attributionVersion: 2,
            settledAt: current,
            expiresAt: work.expiresAt,
          },
        });
      }
      return { committed: true, nonzero, terminalized: false };
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }
  if (result.terminalized) {
    await options.afterSummaryWorkTransition?.({ ...work, status: "UNSCORABLE" });
  }
  if (result.committed || result.terminalized) await invalidateUser(work.userId);
  return result.committed && result.nonzero;
}

async function claimActiveWork(prisma, current, batchSize, leaseMs) {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM global_event_summary_work
        WHERE status = ANY($1::text[])
          AND available_at <= $2::timestamp
          AND (lease_until IS NULL OR lease_until <= $2::timestamp)
          AND (status <> 'WAITING_SYNC' OR expires_at <= $2::timestamp)
        ORDER BY available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3`,
      ACTIVE_WORK_STATES,
      current,
      batchSize,
    );
    const claimed = [];
    for (const candidate of candidates) {
      const leaseToken = crypto.randomUUID();
      const updated = await tx.globalEventSummaryWork.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: current } }],
        },
        data: {
          status: candidate.status === "QUEUED" ? "PROCESSING" : candidate.status,
          leaseToken,
          leaseUntil: new Date(current.getTime() + leaseMs),
          attemptCount: { increment: 1 },
        },
      });
      if (updated.count !== 1) continue;
      const work = await tx.globalEventSummaryWork.findUnique({
        where: { id: candidate.id },
      });
      if (work) claimed.push(work);
    }
    return claimed;
  });
}

async function releaseWorkLease(prisma, work, current, retryMs, errorCode = null) {
  await prisma.globalEventSummaryWork.updateMany({
    where: {
      id: work.id,
      status: { in: ACTIVE_WORK_STATES },
      leaseToken: work.leaseToken,
    },
    data: {
      leaseUntil: null,
      leaseToken: null,
      availableAt: new Date(current.getTime() + retryMs),
      ...(errorCode ? { lastErrorCode: String(errorCode).slice(0, 128) } : {}),
    },
  });
}

async function runV2(prisma, current, batchSize = 100, options = {}) {
  if (!prisma.globalEventSummaryWork || !prisma.globalEventCaptureArtifact) {
    return { created: 0, expired: 0 };
  }
  const candidateIds = await prisma.$queryRawUnsafe(
    `SELECT e.id
       FROM global_step_event_entitlements e
       JOIN global_step_events event ON event.id = e.event_id
      WHERE e.ends_at <= $1::timestamp
        AND event.summary_attribution_version = 2
        AND NOT EXISTS (
          SELECT 1 FROM global_event_summary_work work
           WHERE work.event_id = e.event_id AND work.user_id = e.user_id
        )
      ORDER BY e.ends_at ASC, e.id ASC
      LIMIT $2`,
    current.toISOString(),
    batchSize,
  ).catch(() => []);
  const ended = candidateIds.length
    ? await prisma.globalStepEventEntitlement.findMany({
        where: { id: { in: candidateIds.map((row) => row.id) } },
        include: { event: true },
      })
    : [];
  for (const entitlement of ended) {
    await createSummaryWorkForEntitlement(prisma, entitlement, current);
  }
  const legacyGroups = await prisma.$queryRawUnsafe(
    `SELECT impact.event_id AS "eventId", impact.user_id AS "userId"
       FROM global_event_race_impacts impact
       JOIN global_step_events event ON event.id = impact.event_id
      WHERE event.ends_at <= $1::timestamp
        AND event.schedule_mode = 'LEGACY_GLOBAL'
        AND event.summary_attribution_version = 2
        AND NOT EXISTS (
          SELECT 1 FROM global_event_summary_work work
           WHERE work.event_id = impact.event_id AND work.user_id = impact.user_id
        )
      GROUP BY impact.event_id, impact.user_id
      ORDER BY MIN(event.ends_at) ASC, impact.event_id ASC, impact.user_id ASC
      LIMIT $2`,
    current.toISOString(),
    batchSize,
  ).catch(() => []);
  for (const group of legacyGroups) {
    const event = await prisma.globalStepEvent.findUnique({
      where: { id: group.eventId },
    });
    const entitlement = legacyGlobalSummaryEntitlement({
      event,
      userId: group.userId,
    });
    if (entitlement) {
      await createSummaryWorkForEntitlement(prisma, entitlement, current);
    }
  }

  // Reconcile durable handoffs from a previous tick before claiming summary
  // work. This phase never holds a summary-work row lock while it acquires C0.
  await reconcileWorkRaceQueues(prisma, current, batchSize, options);

  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const retryMs = options.retryMs || DEFAULT_RETRY_MS;
  const tickBudgetMs = options.tickBudgetMs || DEFAULT_TICK_BUDGET_MS;
  const startedAtMs = Date.now();
  const works = await claimActiveWork(prisma, current, batchSize, leaseMs);
  const result = { created: 0, expired: 0 };
  for (let work of works) {
    if (Date.now() - startedAtMs >= tickBudgetMs) {
      await releaseWorkLease(prisma, work, current, retryMs);
      continue;
    }
    try {
      if (new Date(work.expiresAt).getTime() <= current.getTime()) {
        if (await expireWork(prisma, work, current, options)) result.expired += 1;
        continue;
      }
      if (work.status === "PROCESSING") {
        await resolveArtifacts(prisma, work, current, options);
        continue;
      }
      if (work.status === "WAITING_RACES" &&
          await aggregateReadyWork(prisma, work, current, options)) {
        result.created += 1;
        continue;
      }
      await releaseWorkLease(prisma, work, current, retryMs);
    } catch (error) {
      await releaseWorkLease(prisma, work, current, retryMs, error?.code || "RETRYABLE_ERROR");
      options.logger?.error?.("[CRON] global event summary work retryable error", {
        workId: work.id,
        errorCode: error?.code || "RETRYABLE_ERROR",
      });
    }
  }
  // Transitions made above are committed before C0 acquisition. A crash after
  // enqueue but before the stamp is harmless because enqueueMany is idempotent.
  await reconcileWorkRaceQueues(prisma, current, batchSize, options);
  return result;
}

async function runV1(prisma, current) {
  const groups = await prisma.globalEventRaceImpact.groupBy({
    by: ["eventId", "userId"],
    _sum: { deltaSteps: true },
    _count: { _all: true },
    where: { status: "FINAL", attributionVersion: 1 },
  });
  let upserts = 0;
  for (const group of groups) {
    const jobName = `global_event_summary:${group.eventId}:${group.userId}:v1`;
    const alreadyProcessed = typeof prisma.jobRun?.findUnique === "function"
      ? await prisma.jobRun.findUnique({ where: { jobName }, select: { jobName: true } })
      : null;
    if (alreadyProcessed) continue;
    const event = await prisma.globalStepEvent.findUnique({
      where: { id: group.eventId },
      select: { endsAt: true, scheduleMode: true, summaryAttributionVersion: true },
    });
    if (!event) continue;
    if (event.summaryAttributionVersion === 2) continue;
    let enrollmentEnd = event.endsAt;
    if (event.scheduleMode === "LOCAL_ENTITLEMENTS") {
      const entitlement = await prisma.globalStepEventEntitlement.findUnique({
        where: { eventId_userId: { eventId: group.eventId, userId: group.userId } },
        select: { endsAt: true, startOutcome: true },
      });
      if (!entitlement || entitlement.startOutcome === "PENDING") continue;
      enrollmentEnd = entitlement.endsAt;
    }
    if (new Date(enrollmentEnd).getTime() > current.getTime()) continue;
    const pending = await prisma.globalEventRaceImpact.count({
      where: {
        eventId: group.eventId,
        userId: group.userId,
        attributionVersion: 1,
        status: { not: "FINAL" },
      },
    });
    if (pending) continue;
    const nonzero = await prisma.globalEventRaceImpact.count({
      where: {
        eventId: group.eventId,
        userId: group.userId,
        attributionVersion: 1,
        status: "FINAL",
        deltaSteps: { not: 0 },
      },
    });
    let committed = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.jobRun.create({
          data: { jobName, lastRanFor: nonzero > 0 ? "FINAL" : "ALL_ZERO" },
        });
        if (nonzero > 0) {
          await tx.globalEventUserSummary.upsert({
            where: { eventId_userId: { eventId: group.eventId, userId: group.userId } },
            update: {},
            create: {
              eventId: group.eventId,
              userId: group.userId,
              extraRaceSteps: group._sum.deltaSteps || 0,
              raceCount: group._count._all,
              settledAt: current,
            },
          });
        }
      });
      committed = true;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
    if (committed) {
      await invalidateUser(group.userId);
      if (nonzero > 0) upserts += 1;
    }
  }
  return upserts;
}

function buildGlobalEventSummaryTick(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  return async function globalEventSummaryTick() {
    const current = new Date(now());
    const v2 = await runV2(prisma, current, dependencies.batchSize || 100, {
      leaseMs: dependencies.leaseMs,
      retryMs: dependencies.retryMs,
      tickBudgetMs: dependencies.tickBudgetMs,
      logger: dependencies.logger,
      afterSummaryWorkLock: dependencies.afterSummaryWorkLock,
      afterSummaryWorkTransition: dependencies.afterSummaryWorkTransition,
      afterSummaryRaceEnqueue: dependencies.afterSummaryRaceEnqueue,
    });
    const v1 = await runV1(prisma, current);
    return { upserts: v1 + v2.created };
  };
}

function scheduleGlobalEventSummaryTick(dependencies = {}) {
  const run = buildGlobalEventSummaryTick(dependencies);
  const logger = dependencies.logger || console;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] globalEventSummary tick error:", error);
    } finally {
      running = false;
    }
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || 1000);
  interval.unref?.();
  logger.log("[CRON] Global event summary scheduled");
  return { stop: () => clearInterval(interval) };
}

module.exports = {
  buildGlobalEventSummaryTick,
  scheduleGlobalEventSummaryTick,
  runV2,
};
