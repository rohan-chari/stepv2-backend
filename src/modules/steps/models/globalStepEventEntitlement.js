const { prisma } = require("../../../db");
const {
  LOCAL_ENTITLEMENTS,
  LEGACY_GLOBAL,
} = require("../globalStepEvent");
const {
  normalizedEntitlementEvent,
} = require("../services/globalStepEventEntitlement");

// Each bounded round evaluates the active membership cohort once. User rows
// are joined only after the per-parent anti-join and candidate LIMIT.
async function discoverEnrollmentPages(parents, { client = prisma, pageSize = 500 } = {}) {
  if (!Array.isArray(parents) || parents.length > 8) throw new TypeError('at most eight enrollment parents required');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new TypeError('enrollment page size must be 1..500');
  if (!parents.length) return [];
  const ids = new Set();
  for (const parent of parents) {
    if (!parent?.eventId || typeof parent.eventId !== 'string' || ids.has(parent.eventId) ||
        (parent.afterUserId != null && typeof parent.afterUserId !== 'string')) throw new TypeError('invalid enrollment parent');
    ids.add(parent.eventId);
  }
  const values = parents.flatMap(parent => [parent.eventId, pageSize, parent.afterUserId ?? null]);
  const relation = parents.map((_, i) => `($${i * 3 + 1}::text,$${i * 3 + 2}::int,$${i * 3 + 3}::text,${i})`).join(',');
  const rows = await client.$queryRawUnsafe(`WITH active_users AS MATERIALIZED (
    SELECT DISTINCT participant.user_id FROM races race
    JOIN race_participants participant ON participant.race_id = race.id
    WHERE race.status = 'active' AND participant.status = 'accepted'
      AND participant.forfeited_at IS NULL AND participant.finished_at IS NULL
  ), parent_inputs(event_id,page_size,after_user_id,ordinal) AS (VALUES ${relation}),
  enrollment_candidates AS MATERIALIZED (
    SELECT parent.event_id,parent.ordinal,candidate.user_id FROM parent_inputs parent
    LEFT JOIN LATERAL (
      SELECT active.user_id FROM active_users active
      WHERE (parent.after_user_id IS NULL OR active.user_id > parent.after_user_id)
        AND EXISTS (SELECT 1 FROM global_step_events existing WHERE existing.id = parent.event_id)
        AND NOT EXISTS (SELECT 1 FROM global_step_event_entitlements entitlement
          WHERE entitlement.event_id = parent.event_id AND entitlement.user_id = active.user_id)
      ORDER BY active.user_id LIMIT parent.page_size
    ) candidate ON true
  )
  SELECT candidate.event_id AS "eventId",person.id,person.timezone,
    person.global_event_timezone AS "globalEventTimezone"
  FROM enrollment_candidates candidate LEFT JOIN users person ON person.id = candidate.user_id
  ORDER BY candidate.ordinal,person.id`, ...values);
  const groups = new Map(parents.map(parent => [parent.eventId, []]));
  for (const row of rows) {
    // Single-parent injected old model doubles return the original user shape.
    const id = row.eventId ?? (parents.length === 1 ? parents[0].eventId : null);
    if (!groups.has(id)) throw new Error('unknown parent in enrollment discovery');
    if (row.id != null) groups.get(id).push({ id: row.id, timezone: row.timezone, globalEventTimezone: row.globalEventTimezone });
  }
  return parents.map(parent => {
    const candidates = groups.get(parent.eventId);
    if (candidates.length > pageSize) throw new Error('enrollment discovery exceeded page bound');
    return { eventId: parent.eventId, candidates,
      nextCursor: candidates.at(-1)?.id ?? parent.afterUserId ?? null,
      exhausted: candidates.length < pageSize };
  });
}

const ELIGIBLE_OUTCOMES = ["ACTIVATED_ON_TIME", "ACTIVATED_LATE_JOIN"];

async function findEligibleByRace({
  raceId,
  userIds,
  rangeStart,
  rangeEnd,
  client = prisma,
  allowMissingImpactEventUserKeys = null,
  participantMemberships = null,
}) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;

  const suppliedMemberships = Array.isArray(participantMemberships)
    ? participantMemberships.filter((row) => ids.includes(row?.userId))
    : null;
  const suppliedMembershipIds = new Set((suppliedMemberships || []).map((row) => row.userId));
  const hasCompleteSuppliedMemberships = suppliedMemberships !== null &&
    suppliedMembershipIds.size === ids.length &&
    ids.every((id) => suppliedMembershipIds.has(id));
  const [legacyEvents, entitlements] = await Promise.all([
    client.globalStepEvent.findMany({
      where: {
        scheduleMode: LEGACY_GLOBAL,
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      orderBy: { startsAt: "asc" },
    }),
    client.globalStepEventEntitlement.findMany({
      where: {
        userId: { in: ids },
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
        startOutcome: { in: ELIGIBLE_OUTCOMES },
        event: { scheduleMode: LOCAL_ENTITLEMENTS },
      },
      include: { event: true },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  for (const id of ids) map.get(id).push(...legacyEvents);

  const eventIds = [...new Set(entitlements.map((row) => row.eventId))];
  const [impacts, memberships] = await Promise.all([
    eventIds.length === 0 ? [] : client.globalEventRaceImpact.findMany({
      where: { raceId, userId: { in: ids }, eventId: { in: eventIds } },
      select: { id: true, eventId: true, userId: true },
    }),
    // Membership clipping is consumed only by local entitlements below.
    // An empty entitlement result needs no roster query at all; legacy global
    // events are independent of each participant's join timestamp.
    entitlements.length === 0 ? [] : (
      hasCompleteSuppliedMemberships
        ? Promise.resolve(suppliedMemberships)
        : typeof client.raceParticipant?.findMany === "function"
          ? client.raceParticipant.findMany({
              where: { raceId, userId: { in: ids }, status: "ACCEPTED" },
              select: { userId: true, joinedAt: true },
            })
          : Promise.resolve([])
    ),
  ]);
  const impactByEventUser = new Map(
    impacts.map((impact) => [`${impact.eventId}:${impact.userId}`, impact])
  );
  const joinedAtByUser = new Map(
    memberships.map((row) => [row.userId, row.joinedAt])
  );
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
  discoverEnrollmentPages, findEligibleByRace, findViewerActive, findViewerActiveHomeCached,
};

module.exports = {
  discoverEnrollmentPages,
  GlobalStepEventEntitlement,
  findEligibleByRace,
  findViewerActive,
  findViewerActiveHomeCached,
};
