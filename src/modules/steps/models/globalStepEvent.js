const { prisma } = require("../../../db");
const {
  createPendingEnrollments,
  uniqueUserIds,
  acquireGlobalEnrollmentLock,
} = require("../services/globalEventEnrollment");

async function invalidateGlobalEventCache() {
  const derivedCache = require("../../../shared/cache/derivedCache");
  const cacheKeys = require("../../../shared/cache/cacheKeys");
  await derivedCache.invalidate({
    keys: [cacheKeys.globalEventsKey],
    prefix: cacheKeys.PREFIX.GLOBAL_EVENTS,
  });
}

const GlobalStepEvent = {
  async create({ startsAt, endsAt, multiplier, label }) {
    const row = await prisma.globalStepEvent.create({
      data: { startsAt, endsAt, multiplier, label: label ?? null },
    });
    // C1 invalidation (spec §5 Phase B): the scheduler that mints a new event
    // must drop the cached not-yet-ended row set, or the "2x STEPS" home banner
    // appears up to 60s after the event actually starts.
    await invalidateGlobalEventCache();
    return row;
  },

  // The daily start anchor is deterministic, but read-then-create alone is not
  // sufficient across pm2 processes. Lock the anchor inside the transaction,
  // re-read it, and return the winner's row without emitting/fanning out from
  // losing ticks. This avoids an unsafe unique migration over historical rows.
  async createIfAbsent({ startsAt, endsAt, multiplier, label }) {
    const start = new Date(startsAt);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `global-step-event:${start.toISOString()}`
      );
      await acquireGlobalEnrollmentLock(tx);
      const existing = await tx.globalStepEvent.findFirst({ where: { startsAt: start } });
      if (existing) return { event: existing, created: false };
      const event = await tx.globalStepEvent.create({
        data: { startsAt: start, endsAt, multiplier, label: label ?? null },
      });
      return { event, created: true };
    });
    if (result.created) await invalidateGlobalEventCache();
    return result;
  },

  // The event row and its initial PENDING race/user enrollment set are one
  // transaction. A created event can therefore never be visible to settlement
  // without the snapshot of everyone already racing at its start instant.
  async createIfAbsentWithEnrollments({ startsAt, endsAt, multiplier, label }) {
    const start = new Date(startsAt);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `global-step-event:${start.toISOString()}`
      );
      await acquireGlobalEnrollmentLock(tx);
      const existing = await tx.globalStepEvent.findFirst({ where: { startsAt: start } });
      if (existing) return { event: existing, created: false, participantUserIds: [] };

      const event = await tx.globalStepEvent.create({
        data: { startsAt: start, endsAt, multiplier, label: label ?? null },
      });
      const participants = await tx.raceParticipant.findMany({
        where: {
          status: "ACCEPTED",
          race: {
            status: "ACTIVE",
            startedAt: { lte: start },
            OR: [{ endsAt: null }, { endsAt: { gt: start } }],
          },
        },
        select: { raceId: true, userId: true },
      });
      const byRace = new Map();
      for (const participant of participants) {
        const userIds = byRace.get(participant.raceId) || [];
        userIds.push(participant.userId);
        byRace.set(participant.raceId, userIds);
      }
      for (const [raceId, userIds] of byRace) {
        await createPendingEnrollments(tx, { eventId: event.id, raceId, userIds });
      }
      return {
        event,
        created: true,
        participantUserIds: uniqueUserIds(participants.map((participant) => participant.userId)),
      };
    });
    if (result.created) await invalidateGlobalEventCache();
    return result;
  },

  // Events whose window overlaps [rangeStart, rangeEnd]. Used by getRaceProgress
  // (rangeStart = race start, rangeEnd = now) and raceExpiry (rangeEnd = end) to
  // fetch the windows relevant to a participant's step samples.
  async findActiveInRange(rangeStart, rangeEnd) {
    return prisma.globalStepEvent.findMany({
      where: {
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      orderBy: { startsAt: "asc" },
    });
  },

  // The single event currently active at `now` (startsAt <= now < endsAt), or
  // null. Used by the home card to surface a "2x STEPS" banner. Akin to
  // findActiveInRange but returns just the one in-progress row.
  async findActiveAt(now) {
    const at = new Date(now);
    return prisma.globalStepEvent.findFirst({
      where: {
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      orderBy: { startsAt: "desc" },
    });
  },

  // C1 (spec §5 Phase B) — the CACHED variant of findActiveAt, for DISPLAY
  // surfaces only.
  //
  // Deliberately a separate method rather than caching inside `findActiveAt`
  // or wrapping this model object: `findActiveInRange` is called by
  // `raceExpiry` and `raceStateResolution`, and spec §2 non-goals state
  // "Settlement and coins never read Redis". Adding the cache to the shared
  // model would silently put a Redis read on the settlement path. Only the home
  // banner (`/home/race-card`) calls this.
  //
  // What is cached is the small set of not-yet-ended events, NOT the answer for
  // a particular `now` — otherwise a 60s-old entry would answer a question
  // asked about a different instant. The "active at now" predicate is then
  // evaluated in JS against the caller's own clock, so the only staleness is
  // "an event created in the last 60s may not appear yet".
  async findActiveAtCached(now) {
    const derivedCache = require("../../../shared/cache/derivedCache");
    const cacheKeys = require("../../../shared/cache/cacheKeys");

    let enabled = false;
    try {
      const { appSettings } = require("../../../shared/config/appSettings");
      enabled =
        (await appSettings.getFlag("redisCacheCatalogsEnabled")) === true;
    } catch {
      enabled = false;
    }
    if (!enabled) return GlobalStepEvent.findActiveAt(now);

    const rows = await derivedCache.cachedRead({
      key: cacheKeys.globalEventsKey,
      prefix: cacheKeys.PREFIX.GLOBAL_EVENTS,
      ttlSeconds: 60,
      enabled: true,
      load: async () =>
        prisma.globalStepEvent.findMany({
          where: { endsAt: { gt: new Date() } },
          orderBy: { startsAt: "desc" },
          take: 20,
        }),
    });

    const at = new Date(now).getTime();
    // Same ordering + predicate as findActiveAt (startsAt desc, first match).
    for (const row of rows || []) {
      if (
        new Date(row.startsAt).getTime() <= at &&
        new Date(row.endsAt).getTime() > at
      ) {
        return row;
      }
    }
    return null;
  },

  // Events started at/after `since`. Used by the scheduler for idempotency: it
  // must not re-create an event for a chosen time that already fired. A rolling
  // lookback (not calendar-day bucketing) because the ET-anchored start and the
  // next tick can straddle UTC midnight, which UTC-day buckets would split.
  async findStartedSince(since) {
    return prisma.globalStepEvent.findMany({
      where: { startsAt: { gte: new Date(since) } },
      orderBy: { startsAt: "asc" },
    });
  },
};

module.exports = { GlobalStepEvent };
