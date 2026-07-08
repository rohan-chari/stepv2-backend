const { prisma } = require("../db");

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
