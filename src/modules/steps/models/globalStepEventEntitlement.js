const { prisma } = require("../../../db");
const {
  LOCAL_ENTITLEMENTS,
  LEGACY_GLOBAL,
} = require("../globalStepEvent");
const {
  normalizedEntitlementEvent,
} = require("../services/globalStepEventEntitlement");

const ELIGIBLE_OUTCOMES = ["ACTIVATED_ON_TIME", "ACTIVATED_LATE_JOIN"];

async function findEligibleByRace({
  raceId,
  userIds,
  rangeStart,
  rangeEnd,
  client = prisma,
  allowMissingImpactEventUserKeys = null,
}) {
  const queryStartedAt = Date.now();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;

  const [legacyEvents, impacts, memberships] = await Promise.all([
    client.globalStepEvent.findMany({
      where: {
        scheduleMode: LEGACY_GLOBAL,
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      orderBy: { startsAt: "asc" },
    }),
    client.globalEventRaceImpact.findMany({
      where: { raceId, userId: { in: ids } },
      select: { id: true, eventId: true, userId: true, status: true },
    }),
    typeof client.raceParticipant?.findMany === "function"
      ? client.raceParticipant.findMany({
          where: { raceId, userId: { in: ids }, status: "ACCEPTED" },
          select: { userId: true, joinedAt: true },
        })
      : Promise.resolve([]),
  ]);
  for (const id of ids) map.get(id).push(...legacyEvents);

  const impactByEventUser = new Map(
    impacts.map((impact) => [`${impact.eventId}:${impact.userId}`, impact])
  );
  const joinedAtByUser = new Map(
    memberships.map((row) => [row.userId, row.joinedAt])
  );
  const entitlements = await client.globalStepEventEntitlement.findMany({
    where: {
      userId: { in: ids },
      startsAt: { lt: new Date(rangeEnd) },
      endsAt: { gt: new Date(rangeStart) },
      startOutcome: { in: ELIGIBLE_OUTCOMES },
      event: { scheduleMode: LOCAL_ENTITLEMENTS },
    },
    include: { event: true },
    orderBy: { startsAt: "asc" },
  });
  for (const entitlement of entitlements) {
    const eventUserKey = `${entitlement.eventId}:${entitlement.userId}`;
    const impact = impactByEventUser.get(eventUserKey);
    if (!impact && !allowMissingImpactEventUserKeys?.has(eventUserKey)) continue;
    const normalized = normalizedEntitlementEvent(entitlement.event, entitlement, impact);
    normalized.startsAt = new Date(Math.max(
      new Date(normalized.startsAt).getTime(),
      new Date(rangeStart).getTime(),
      joinedAtByUser.has(entitlement.userId)
        ? new Date(joinedAtByUser.get(entitlement.userId)).getTime()
        : new Date(rangeStart).getTime()
    ));
    if (normalized.startsAt < new Date(normalized.endsAt)) {
      map.get(entitlement.userId)?.push(normalized);
    }
  }
  if (entitlements.length > 0) {
    try {
      const { recordOperationalCounters } = require("../services/globalStepEventObservability");
      await recordOperationalCounters(client, {
        scoringQueries: 1,
        scoringLatencyMs: Date.now() - queryStartedAt,
      });
    } catch {}
  }
  return map;
}

async function findViewerActive({ userId, raceId = null, now = new Date(), client = prisma }) {
  if (client === prisma) {
    return require("../services/viewerActiveEventReadBatch")
      .viewerActiveEventReadBatch.load({ prisma: client, userId, raceId, now });
  }
  const at = new Date(now);
  const entitlement = await client.globalStepEventEntitlement.findFirst({
    where: {
      userId,
      startsAt: { lte: at },
      endsAt: { gt: at },
      startOutcome: { in: ELIGIBLE_OUTCOMES },
      event: { scheduleMode: LOCAL_ENTITLEMENTS },
    },
    include: { event: true },
    orderBy: { startsAt: "desc" },
  });
  if (!entitlement) return null;
  const impact = await client.globalEventRaceImpact.findFirst({
    where: {
      eventId: entitlement.eventId,
      userId,
      ...(raceId ? { raceId } : {}),
      race: {
        status: "ACTIVE",
        participants: {
          some: {
            userId,
            status: "ACCEPTED",
            forfeitedAt: null,
            finishedAt: null,
          },
        },
      },
    },
    select: { id: true },
  });
  if (!impact) return null;
  return {
    eventId: entitlement.eventId,
    multiplier: Number(entitlement.event.multiplier),
    endsAt: entitlement.endsAt,
  };
}

async function findViewerActiveHomeCached({ userId, now = new Date() }) {
  const derivedCache = require("../../../shared/cache/derivedCache");
  const cacheKeys = require("../../../shared/cache/cacheKeys");
  const { appSettings } = require("../../../shared/config/appSettings");
  let enabled = false;
  try {
    enabled = (await appSettings.getFlag("redisCacheHomeActiveGlobalEventEnabled")) === true;
  } catch {
    enabled = false;
  }
  const value = await derivedCache.cachedRead({
    key: cacheKeys.homeActiveGlobalEvent(userId),
    prefix: cacheKeys.PREFIX.HOME_ACTIVE_GLOBAL_EVENT,
    ttlSeconds: 30,
    enabled,
    load: async () => {
      const active = await findViewerActive({ userId, now });
      return active
        ? {
            eventId: active.eventId,
            multiplier: Number(active.multiplier),
            endsAt: active.endsAt,
          }
        : null;
    },
  });
  if (!value) return null;
  const end = new Date(value.endsAt);
  if (Number.isNaN(end.getTime()) || new Date(now) >= end) return null;
  return {
    eventId: value.eventId,
    multiplier: Number(value.multiplier),
    endsAt: end,
  };
}

const GlobalStepEventEntitlement = {
  findEligibleByRace, findViewerActive, findViewerActiveHomeCached,
};

module.exports = {
  GlobalStepEventEntitlement,
  findEligibleByRace,
  findViewerActive,
  findViewerActiveHomeCached,
};
