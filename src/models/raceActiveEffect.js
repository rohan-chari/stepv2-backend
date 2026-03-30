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
