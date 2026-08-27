// Durable lifecycle entries for a global event's race impact. These helpers
// only establish membership; settlement remains the sole score authority.
const {
  ensureEntitlementForUser,
  START_OUTCOMES,
} = require("./globalStepEventEntitlement");

function uniqueUserIds(userIds = []) {
  return [...new Set(userIds.filter(Boolean))].sort();
}

// Serializes the two membership decisions that would otherwise write-skew:
// event creation scans ACTIVE races while a race start/late join checks for an
// ACTIVE event. It is intentionally a transaction-scoped advisory lock; both
// callers already own their domain transaction and neither needs a process
// local mutex.
async function acquireGlobalEnrollmentLock(tx) {
  if (typeof tx?.$executeRawUnsafe === "function") {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "global-event-enrollment"
    );
    return;
  }
  // Small injected transaction fakes in unit tests may expose only queryRaw.
  // Production Prisma uses executeRaw because pg_advisory_xact_lock returns
  // Postgres void, which queryRaw cannot deserialize with the pg adapter.
  if (typeof tx?.$queryRawUnsafe !== "function") return;
  await tx.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    "global-event-enrollment"
  );
}

async function createPendingEnrollments(tx, {
  eventId, raceId, userIds, attributionVersion = 1,
}) {
  const unique = uniqueUserIds(userIds);
  if (!eventId || !raceId || unique.length === 0) return 0;
  const rows = unique.map((userId) => ({
      eventId,
      raceId,
      userId,
      status: "PENDING",
      ...(Number(attributionVersion) === 2 ? { attributionVersion: 2 } : {}),
    }));
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  const duplicates = unique.length - (result.count || 0);
  if (duplicates > 0) {
    try {
      const { recordOperationalCounters } = require("./globalStepEventObservability");
      await recordOperationalCounters(tx, { duplicateClaimsSuppressed: duplicates });
    } catch {}
  }
  return result.count || 0;
}

async function createPendingEnrollmentsBatch(tx, { raceId, enrollments }) {
  const rows = (enrollments || []).flatMap(({
    eventId, userIds, attributionVersion = 1,
  }) =>
    uniqueUserIds(userIds).map((userId) => ({
      eventId,
      raceId,
      userId,
      status: "PENDING",
      ...(Number(attributionVersion) === 2 ? { attributionVersion: 2 } : {}),
    }))
  ).filter((row) => row.eventId && row.raceId && row.userId);
  if (rows.length === 0) return 0;
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  const duplicates = rows.length - (result.count || 0);
  if (duplicates > 0) {
    try {
      const { recordOperationalCounters } = require("./globalStepEventObservability");
      await recordOperationalCounters(tx, { duplicateClaimsSuppressed: duplicates });
    } catch {}
  }
  return result.count || 0;
}

// Boundary processing commonly has one user and several active races. Keep
// that fan-out in one INSERT so the boundary transaction does not pay one
// round trip per race.
async function createPendingEnrollmentsForRaces(tx, {
  eventId, raceIds, userId, attributionVersion = 1,
}) {
  const uniqueRaceIds = [...new Set((raceIds || []).filter(Boolean))].sort();
  if (!eventId || !userId || uniqueRaceIds.length === 0) return 0;
  const rows = uniqueRaceIds.map((raceId) => ({
      eventId,
      raceId,
      userId,
      status: "PENDING",
      ...(Number(attributionVersion) === 2 ? { attributionVersion: 2 } : {}),
    }));
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  const duplicates = uniqueRaceIds.length - (result.count || 0);
  if (duplicates > 0) {
    try {
      const { recordOperationalCounters } = require("./globalStepEventObservability");
      await recordOperationalCounters(tx, { duplicateClaimsSuppressed: duplicates });
    } catch {}
  }
  return result.count || 0;
}

// Call inside the transaction that makes a participant/race ACTIVE. Doing this
// in the same commit closes the race-start/late-join gap without making a
// second best-effort write part of a user-visible response.
async function enrollIfGlobalEventActive(tx, { raceId, userIds, at }) {
  if (!tx?.globalStepEvent || !tx?.globalEventRaceImpact) return null;
  await acquireGlobalEnrollmentLock(tx);
  const current = new Date(at);
  const event = await tx.globalStepEvent.findFirst({
    where: {
      scheduleMode: "LEGACY_GLOBAL",
      startsAt: { lte: current },
      endsAt: { gt: current },
    },
    orderBy: { startsAt: "desc" },
  });
  if (event) {
    await createPendingEnrollments(tx, {
      eventId: event.id,
      raceId,
      userIds,
      attributionVersion: event.summaryAttributionVersion,
    });
  }

  if (!tx.globalStepEventEntitlement || !tx.user) return event;
  const localParents = await tx.globalStepEvent.findMany({
    where: {
      scheduleMode: "LOCAL_ENTITLEMENTS",
      endsAt: { gt: current },
    },
    orderBy: { eventDay: "asc" },
  });
  let activeLocalEvent = null;
  for (const userId of uniqueUserIds(userIds)) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, timezone: true, globalEventTimezone: true },
    });
    if (!user) continue;
    for (const parent of localParents) {
      const before = await tx.globalStepEventEntitlement.findUnique({
        where: { eventId_userId: { eventId: parent.id, userId } },
      });
      const entitlement = before || await ensureEntitlementForUser(tx, {
        event: parent, user, now: current, allowActive: true,
      });
      if (!entitlement) continue;
      const active = new Date(entitlement.startsAt) <= current &&
        current < new Date(entitlement.endsAt);
      if (
        !active ||
        entitlement.startOutcome === START_OUTCOMES.SKIPPED_STALE
      ) continue;

      let outcome = entitlement.startOutcome;
      if (!before || outcome === START_OUTCOMES.NO_ACTIVE_RACES) {
        outcome = START_OUTCOMES.ACTIVATED_LATE_JOIN;
      } else if (outcome === START_OUTCOMES.PENDING) {
        outcome = START_OUTCOMES.ACTIVATED_LATE_JOIN;
      }
      await createPendingEnrollments(tx, {
        eventId: parent.id,
        raceId,
        userIds: [userId],
        attributionVersion: parent.summaryAttributionVersion,
      });
      if (outcome !== entitlement.startOutcome) {
        await tx.globalStepEventEntitlement.updateMany({
          where: { id: entitlement.id },
          data: { startOutcome: outcome, startProcessedAt: entitlement.startProcessedAt || current },
        });
        if (outcome === START_OUTCOMES.ACTIVATED_LATE_JOIN) {
          const { appendLateActivationEvent } = require("./globalStepEventEntitlement");
          await appendLateActivationEvent(tx, {
            event: parent,
            entitlement,
            occurredAt: current,
          });
        }
      }
      if (!activeLocalEvent) activeLocalEvent = parent;
    }
  }
  return event || activeLocalEvent;
}

module.exports = {
  uniqueUserIds,
  acquireGlobalEnrollmentLock,
  createPendingEnrollments,
  createPendingEnrollmentsBatch,
  createPendingEnrollmentsForRaces,
  enrollIfGlobalEventActive,
};
