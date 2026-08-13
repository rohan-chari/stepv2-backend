const { prisma: defaultPrisma } = require("../../../db");
const prisma = defaultPrisma;

function applyCursor(where, cursor) {
  if (!cursor) return;

  if (typeof cursor === "object" && cursor.createdAt) {
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) return;

    if (cursor.kind === "USER") {
      where.OR = [{ createdAt: { lt: createdAt } }, { createdAt }];
      return;
    }

    if (cursor.kind === "SYSTEM" && cursor.id) {
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: cursor.id } },
      ];
      return;
    }

    where.createdAt = { lt: createdAt };
    return;
  }

  const createdAt = new Date(cursor);
  if (!Number.isNaN(createdAt.getTime())) {
    where.createdAt = { lt: createdAt };
  }
}

const RacePowerupEvent = {
  async create({ raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata }) {
    const row = await prisma.racePowerupEvent.create({
      data: { raceId, actorUserId, eventType, powerupType, targetUserId, description, metadata },
    });
    // C2 invalidation (spec §5 Phase C): these rows ARE the SYSTEM feed, so a
    // new one must advance `msgver` and drop the cached SYSTEM list, exactly
    // like a USER post does. Required at the model rather than at each of the
    // many powerup call sites, so a new emitter cannot forget it.
    const raceMessagesCache = require("../../social/services/raceMessagesCache");
    await raceMessagesCache.invalidateKind(raceId, "SYSTEM", row);
    return row;
  },

  async findByRace(raceId, {
    cursor,
    limit = 50,
    excludeEventTypes,
    excludeWelcomeMysteryBoxEvents = false,
  } = {}) {
    const where = { raceId };
    applyCursor(where, cursor);
    // DB-level exclusion (Prisma notIn) so filtered rows don't consume page
    // slots. This is what keeps pagination full when the feed is dense with
    // hidden events (e.g. MYSTERY_BOX_OPENED); a post-fetch JS filter would
    // under-fill a page and prematurely null the cursor.
    if (Array.isArray(excludeEventTypes) && excludeEventTypes.length > 0) {
      where.eventType = { notIn: excludeEventTypes };
    }
    if (excludeWelcomeMysteryBoxEvents) {
      where.NOT = {
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: { in: ["Welcome gift. A mystery box!", "Welcome gift — a mystery box!"] },
      };
    }
    return prisma.racePowerupEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
  },

  // Which of `userIds` produced at least one `eventType` event at or after
  // `since` (batch 2026-08-10 item 1: "did this account still open a mystery
  // box?"). Returns a Set. Cross-race by design — engagement is engagement,
  // whichever race the box came from. `prisma` is injectable because the
  // callers (the seeded-inactivity service and its hooks) are already
  // prisma-injected end to end.
  //
  // Backed by race_powerup_events(actor_user_id, event_type, created_at); the
  // table is dominated by other event types, so the eventType column earns its
  // place in the index.
  async findActorIdsWithEventSince({
    userIds,
    eventType,
    since,
    prisma: client = defaultPrisma,
  } = {}) {
    const ids = [...new Set(userIds || [])];
    if (ids.length === 0 || !eventType || !since) return new Set();
    const rows = await client.racePowerupEvent.findMany({
      where: {
        actorUserId: { in: ids },
        eventType,
        createdAt: { gte: new Date(since) },
      },
      select: { actorUserId: true },
      distinct: ["actorUserId"],
    });
    return new Set(rows.map((row) => row.actorUserId));
  },

  async findByRaceAsc(raceId) {
    return prisma.racePowerupEvent.findMany({
      where: { raceId },
      orderBy: { createdAt: "asc" },
    });
  },
};

module.exports = { RacePowerupEvent };
