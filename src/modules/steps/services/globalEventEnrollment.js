const { entitlementsChanged, raceEventDisplayChanged } = require('./eventDisplayCacheInvalidation');
const {
  FALLBACK_EVENT_TIMEZONE,
  LOCAL_ENTITLEMENTS,
  localEventWindowForZone,
} = require('../globalStepEvent');
const { isValidIanaTimeZone } = require('../../users/services/globalEventTimezone');
const { isGenerationUsable } = require('../models/globalStepEventGeneration');
// Durable lifecycle entries for a global event's race impact. These helpers
// only establish membership; settlement remains the sole score authority.
const {
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
    }));
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  if (result.count) await raceEventDisplayChanged(rows.map(row => row.raceId));
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
    }))
  ).filter((row) => row.eventId && row.raceId && row.userId);
  if (rows.length === 0) return 0;
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  if (result.count) await raceEventDisplayChanged(rows.map(row => row.raceId));
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
    }));
  const result = await tx.globalEventRaceImpact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  if (result.count) await raceEventDisplayChanged(rows.map(row => row.raceId));
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
  const unique = uniqueUserIds(userIds);
  if (event) {
    const existing = await tx.globalEventRaceImpact.findMany({
      where: { eventId: event.id, raceId, userId: { in: unique } },
      select: { userId: true },
    });
    await tx.globalEventRaceImpact.createMany({
      data: unique.map((userId) => ({ eventId: event.id, raceId, userId })),
      skipDuplicates: true,
    });
    if (existing.length < unique.length) await raceEventDisplayChanged([raceId]);
  }

  if (!tx.globalStepEventEntitlement || !tx.user || unique.length === 0) return event;
  const localParents = await tx.globalStepEvent.findMany({
    where: {
      scheduleMode: "LOCAL_ENTITLEMENTS",
      endsAt: { gt: current },
    },
    orderBy: { eventDay: "asc" },
  });
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, timezone: true, globalEventTimezone: true },
  });
  const userById = new Map(users.map((user) => [user.id, {
    ...user,
    globalEventTimezone: user.timezone,
  }]));
  const parentIds = localParents.map((parent) => parent.id);
  const existing = parentIds.length
    ? await tx.globalStepEventEntitlement.findMany({
      where: { eventId: { in: parentIds }, userId: { in: unique } },
    })
    : [];
  const byKey = new Map(existing.map((row) => [`${row.eventId}:${row.userId}`, row]));
  const prepared = [];
  for (const userId of unique) {
    const user = userById.get(userId);
    if (!user) continue;
    const timezone = isValidIanaTimeZone(user.globalEventTimezone)
      ? user.globalEventTimezone : FALLBACK_EVENT_TIMEZONE;
    for (const parent of localParents) {
      const key = `${parent.id}:${userId}`;
      if (byKey.has(key)) continue;
      const window = localEventWindowForZone({
        eventDay: parent.eventDay,
        localStartMinute: parent.localStartMinute,
        durationMinutes: parent.durationMinutes,
        timeZone: timezone,
      });
      if (window.endsAt <= current) continue;
      prepared.push({
        eventId: parent.id, userId, timezone, localDate: window.localDate,
        startsAt: window.startsAt, endsAt: window.endsAt,
        startOutcome: START_OUTCOMES.PENDING,
      });
    }
  }
  if (prepared.length) {
    const generationReady = await isGenerationUsable({ client: tx, now: current });
    await tx.globalStepEventEntitlement.createMany({ data: prepared, skipDuplicates: true });
    const persisted = await tx.globalStepEventEntitlement.findMany({
      where: { eventId: { in: parentIds }, userId: { in: unique } },
    });
    const parentById = new Map(localParents.map((parent) => [parent.id, parent]));
    const authoritativePrepared = prepared.map((row) => {
      const entitlement = persisted.find((candidate) =>
        candidate.eventId === row.eventId && candidate.userId === row.userId);
      return entitlement ? { ...entitlement, event: parentById.get(entitlement.eventId) } : null;
    }).filter(Boolean);
    if (generationReady && authoritativePrepared.length) {
      const { appendScheduledEntitlementEventsBatch } = require("./globalStepEventEntitlement");
      await appendScheduledEntitlementEventsBatch(tx, {
        entitlements: authoritativePrepared,
        occurredAt: current,
      });
    }
    for (const row of persisted) byKey.set(`${row.eventId}:${row.userId}`, row);
    for (const row of prepared) await entitlementsChanged([row.userId]);
  }

  const localRows = [];
  const late = [];
  let activeLocalEvent = null;
  for (const userId of unique) for (const parent of localParents) {
    const entitlement = byKey.get(`${parent.id}:${userId}`);
    if (!entitlement) continue;
    const active = new Date(entitlement.startsAt) <= current &&
      current < new Date(entitlement.endsAt);
    if (!active || entitlement.startOutcome === START_OUTCOMES.SKIPPED_STALE) continue;
    localRows.push({ eventId: parent.id, raceId, userId });
    if (entitlement.startOutcome === START_OUTCOMES.NO_ACTIVE_RACES ||
        entitlement.startOutcome === START_OUTCOMES.PENDING) {
      late.push({ event: parent, entitlement });
    }
    if (!activeLocalEvent) activeLocalEvent = parent;
  }
  const existingLocalImpacts = localRows.length
    ? await tx.globalEventRaceImpact.findMany({
      where: { raceId, eventId: { in: localParents.map((parent) => parent.id) }, userId: { in: unique } },
      select: { eventId: true, userId: true },
    }) : [];
  await tx.globalEventRaceImpact.createMany({ data: localRows, skipDuplicates: true });
  if (localRows.length) {
    const old = new Set(existingLocalImpacts.map((row) => `${row.eventId}:${row.userId}`));
    for (const row of localRows) if (!old.has(`${row.eventId}:${row.userId}`)) {
      await raceEventDisplayChanged([raceId]);
    }
  }
  if (late.length) {
    await tx.globalStepEventEntitlement.updateMany({
      where: { id: { in: late.map(({ entitlement }) => entitlement.id) } },
      data: { startOutcome: START_OUTCOMES.ACTIVATED_LATE_JOIN, startProcessedAt: current },
    });
    for (const { event: parent, entitlement } of late) {
      await entitlementsChanged([entitlement.userId]);
      const { appendLateActivationEvent } = require("./globalStepEventEntitlement");
      await appendLateActivationEvent(tx, { event: parent, entitlement, occurredAt: current });
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
