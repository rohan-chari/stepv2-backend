const { prisma } = require("../../../db");

const RaceActiveEffect = {
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

  async findActiveByTypeForParticipant(participantId, type) {
    return prisma.raceActiveEffect.findFirst({
      where: { targetParticipantId: participantId, type, status: "ACTIVE" },
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

module.exports = { RaceActiveEffect };
