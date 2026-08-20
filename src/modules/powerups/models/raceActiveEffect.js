const { prisma } = require("../../../db");

function buildActiveImpactDueReader(client = prisma) {
  return {
    async findDueActiveImpactSourcesForRace({ raceId, now, types, limit = 8 }) {
      return client.raceActiveEffect.findMany({
        where: {
          raceId,
          status: "ACTIVE",
          expiresAt: { not: null, lte: now },
          type: { in: types },
        },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: Math.max(1, Number(limit) || 8) + 1,
      });
    },

    async findActiveImpactSourcesByIds({ raceId, sourceIds, types }) {
      const ids = [...new Set(sourceIds || [])].filter(Boolean);
      if (ids.length === 0) return [];
      return client.raceActiveEffect.findMany({
        where: {
          raceId,
          id: { in: ids },
          status: "ACTIVE",
          type: { in: types },
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });
    },

    async findActiveImpactPrefixEffects({
      raceId,
      participantIds,
      sourceUserIds = [],
      types,
      through,
    }) {
      const targets = [...new Set(participantIds || [])].filter(Boolean);
      const sources = [...new Set(sourceUserIds || [])].filter(Boolean);
      if (targets.length === 0 && sources.length === 0) return [];
      return client.raceActiveEffect.findMany({
        where: {
          raceId,
          status: { in: ["ACTIVE", "EXPIRED"] },
          type: { in: types },
          startsAt: { lte: through },
          OR: [
            ...(targets.length > 0
              ? [{ targetParticipantId: { in: targets } }]
              : []),
            ...(sources.length > 0
              ? [{ type: "HITCHHIKE", sourceUserId: { in: sources } }]
              : []),
          ],
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });
    },
  };
}

const RaceActiveEffect = {
  ...buildActiveImpactDueReader(),
  async create({ raceId, targetParticipantId, targetUserId, sourceUserId, powerupId, type, startsAt, expiresAt, metadata }) {
    return prisma.raceActiveEffect.create({
      data: { raceId, targetParticipantId, targetUserId, sourceUserId, powerupId, type, status: "ACTIVE", startsAt, expiresAt, metadata },
    });
  },

  async findActiveForParticipant(participantId) {
    return prisma.raceActiveEffect.findMany({
      where: { targetParticipantId: participantId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
  },

  async findActiveByTypeForParticipant(participantId, type, { expiresAfter } = {}) {
    return prisma.raceActiveEffect.findFirst({
      where: {
        targetParticipantId: participantId,
        type,
        status: "ACTIVE",
        ...(expiresAfter ? { expiresAt: { gt: expiresAfter } } : {}),
      },
    });
  },

  // Bulk variant of findActiveByTypeForParticipant across many participants
  // (Phase B2): one query for a single effect type over a set of participant ids,
  // for the GET /races Detour-masking prefetch. Returns the matching ACTIVE
  // effect rows; the caller groups by targetParticipantId. Participant ids are
  // globally unique so no race scoping is needed.
  async findActiveByTypeForParticipants(participantIds, type) {
    if (!participantIds || participantIds.length === 0) return [];
    return prisma.raceActiveEffect.findMany({
      where: {
        targetParticipantId: { in: participantIds },
        type,
        status: "ACTIVE",
      },
    });
  },

  // Bulk all-types variant across many participants (GET /races prefetch). One
  // query for every ACTIVE effect targeting any of the given participants, in
  // createdAt-asc order; the caller groups by targetParticipantId and derives
  // both the Detour mask (type === "DETOUR_SIGN") and the myActiveEffects list
  // from this single result set. Participant ids are globally unique, so no race
  // scoping is needed. Supersedes the per-type findActiveByTypeForParticipants
  // Detour prefetch (whose work is now a filter over these rows).
  async findActiveForParticipants(participantIds) {
    if (!participantIds || participantIds.length === 0) return [];
    return prisma.raceActiveEffect.findMany({
      where: {
        targetParticipantId: { in: participantIds },
        status: "ACTIVE",
      },
      orderBy: { createdAt: "asc" },
    });
  },

  async findActiveForRace(raceId) {
    return prisma.raceActiveEffect.findMany({
      where: { raceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
  },

  async findExpired(now) {
    return prisma.raceActiveEffect.findMany({
      where: {
        status: "ACTIVE",
        expiresAt: { not: null, lte: now },
      },
    });
  },

  // One row per race whose time-driven effect transition is due. The placement
  // cron uses this to preserve the historical five-minute expiry bound without
  // replaying every active race merely because time passed somewhere else.
  async findDueRaceIds(now, activeRaceIds) {
    const raceIds = [...new Set(activeRaceIds || [])].filter(Boolean);
    if (raceIds.length === 0) return [];
    const rows = await prisma.raceActiveEffect.findMany({
      where: {
        // Scoping to the already-loaded ACTIVE races lets Postgres use the
        // existing (raceId,status) index and avoids a global historical scan.
        raceId: { in: raceIds },
        status: "ACTIVE",
        expiresAt: { not: null, lte: now },
      },
      select: { raceId: true },
      distinct: ["raceId"],
    });
    return rows.map((row) => row.raceId);
  },

  // Scoped expiry read for the worker post-commit hook. The old implementation
  // loaded every due effect globally once per resolved race and filtered in JS;
  // this uses the existing (raceId,status) index and only returns relevant rows.
  async findExpiredForRace(raceId, now) {
    if (!raceId) return this.findExpired(now);
    return prisma.raceActiveEffect.findMany({
      where: {
        raceId,
        status: "ACTIVE",
        expiresAt: { not: null, lte: now },
      },
    });
  },

  async findEffectsForRaceByType(raceId, targetParticipantId, type) {
    return prisma.raceActiveEffect.findMany({
      where: { raceId, targetParticipantId, type, status: { in: ["ACTIVE", "EXPIRED"] } },
      orderBy: { createdAt: "asc" },
    });
  },

  // Batched variant of findEffectsForRaceByType: one query for several types,
  // returned as { [type]: effects[] } with each list in the same createdAt-asc
  // order the per-type query produces. Types with no effects map to [].
  async findEffectsForRaceByTypes(raceId, targetParticipantId, types) {
    const effects = await prisma.raceActiveEffect.findMany({
      where: {
        raceId,
        targetParticipantId,
        type: { in: types },
        status: { in: ["ACTIVE", "EXPIRED"] },
      },
      orderBy: { createdAt: "asc" },
    });

    const byType = {};
    for (const type of types) byType[type] = [];
    for (const effect of effects) {
      (byType[effect.type] ||= []).push(effect);
    }
    return byType;
  },

  // Bulk variant of findEffectsForRaceByTypes across many races' participants
  // (cross-participant prefetch in getHomeRaceCard). One query, returned as
  // { [participantId]: { [type]: effects[] } } with each list in the same
  // createdAt-asc order the per-participant query produces. Participant ids
  // are globally unique, so keying by participant alone is unambiguous.
  async findEffectsForRaceParticipantsByTypes(raceIds, participantIds, types) {
    const byParticipant = {};
    if (!participantIds || participantIds.length === 0) return byParticipant;

    const effects = await prisma.raceActiveEffect.findMany({
      where: {
        raceId: { in: raceIds },
        targetParticipantId: { in: participantIds },
        type: { in: types },
        status: { in: ["ACTIVE", "EXPIRED"] },
      },
      orderBy: { createdAt: "asc" },
    });

    for (const effect of effects) {
      const forParticipant = (byParticipant[effect.targetParticipantId] ||= {});
      (forParticipant[effect.type] ||= []).push(effect);
    }
    return byParticipant;
  },

  // Every effect row of one TYPE across a whole race, in one query. Used by the
  // Hitchhike scorer (§7.3), which — unlike the per-participant helpers above —
  // must also see links whose TARGET has finished or forfeited: their window is
  // clamped at the exit instant, but the copy accrued before it still belongs to
  // the caster. Bounded by (raceId, type), so query count stays independent of
  // participant count.
  async findRaceEffectsByType(raceId, type) {
    return prisma.raceActiveEffect.findMany({
      where: { raceId, type, status: { in: ["ACTIVE", "EXPIRED"] } },
      orderBy: { createdAt: "asc" },
    });
  },

  async findById(id) {
    return prisma.raceActiveEffect.findUnique({ where: { id } });
  },

  async update(id, fields) {
    return prisma.raceActiveEffect.update({
      where: { id },
      data: fields,
    });
  },

  async expireAllForRace(raceId) {
    return prisma.raceActiveEffect.updateMany({
      where: { raceId, status: "ACTIVE" },
      data: { status: "EXPIRED" },
    });
  },
};

module.exports = { buildActiveImpactDueReader, RaceActiveEffect };
