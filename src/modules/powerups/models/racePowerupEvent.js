const { prisma: defaultPrisma } = require("../../../db");
const prisma = defaultPrisma;

async function invalidateCreatedEvent(row) {
  const raceMessagesCache = require("../../social/services/raceMessagesCache");
  await raceMessagesCache.invalidateKind(row.raceId, "SYSTEM", row);
}

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
    await invalidateCreatedEvent(row);
    return row;
  },

  // Direct active-impact sources are inserted inside the same transaction as
  // their durable recipient work. Cache invalidation must happen only after
  // that transaction commits, so the command calls this hook with the returned
  // row rather than publishing an uncommitted event from inside the model.
  invalidateCreated: invalidateCreatedEvent,

  async findByRace(raceId, {
    cursor,
    limit = 50,
    excludeEventTypes,
    excludeWelcomeMysteryBoxEvents = false,
    excludeHiddenFromFeedEvents = false,
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
    const exclusions = [];
    if (excludeWelcomeMysteryBoxEvents) {
      exclusions.push({
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: { in: ["Welcome gift. A mystery box!", "Welcome gift — a mystery box!"] },
      });
    }
    if (excludeHiddenFromFeedEvents) {
      // This description shape covers both new marked rows and historical
      // plant rows. Trigger/expiry copy never contains "planted a".
      exclusions.push({
        eventType: "POWERUP_USED",
        powerupType: "TRAIL_MINE",
        description: { contains: " planted a " },
      });
    }
    if (exclusions.length > 0) {
      where.NOT = exclusions;
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

  // When did `actorUserId` last USE `powerupType` in `raceId`? Returns the Date
  // or null. Backs the Quick Rinse once-per-hour-per-race cooldown (2026-08-17):
  // that powerup is instantaneous and writes no effect row, so its POWERUP_USED
  // feed event is the only durable record of a use.
  //
  // Served by race_powerup_events(race_id, created_at) — one race's event list is
  // small, and the extra predicates filter inside it.
  async findLastPowerupUseAt({ raceId, actorUserId, powerupType, prisma: client = defaultPrisma } = {}) {
    if (!raceId || !actorUserId || !powerupType) return null;
    const row = await client.racePowerupEvent.findFirst({
      where: { raceId, actorUserId, eventType: "POWERUP_USED", powerupType },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return row ? row.createdAt : null;
  },

  async findByRaceAsc(raceId) {
    return prisma.racePowerupEvent.findMany({
      where: { raceId },
      orderBy: { createdAt: "asc" },
    });
  },

  // Active-defense attribution needs only hidden Umbrella interception
  // intents. Keeping this projection narrow avoids hydrating every feed event
  // in large, long-running races; metadata is still validated defensively by
  // the resolver because historical rows predate the typed intent contract.
  async findActiveDefenseCandidates(raceId) {
    return prisma.$queryRawUnsafe(
      `SELECT id, metadata, created_at AS "createdAt"
         FROM race_powerup_events
        WHERE race_id = $1
          AND event_type = 'POWERUP_USED'
          AND metadata @> '{
            "activeImpactDefenseCalculationVersion": 1,
            "activeImpactDefenseType": "UMBRELLA"
          }'::jsonb
        ORDER BY created_at ASC, id ASC`,
      raceId,
    );
  },
};

module.exports = { RacePowerupEvent };
