const { prisma } = require("../db");

const RacePowerup = {
  async create({ raceId, participantId, userId, type = null, rarity = null, status = "HELD", earnedAtSteps }) {
    return prisma.racePowerup.create({
      data: { raceId, participantId, userId, type, rarity, status, earnedAtSteps },
    });
  },

  async findById(id) {
    return prisma.racePowerup.findUnique({ where: { id } });
  },

  async findHeldByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "HELD" },
      orderBy: { createdAt: "asc" },
    });
  },

  async countHeldByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "HELD" },
    });
  },

  async update(id, fields) {
    return prisma.racePowerup.update({
      where: { id },
      data: fields,
    });
  },

  async findMysteryBoxesByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "MYSTERY_BOX" },
      orderBy: { createdAt: "asc" },
    });
  },

  async countMysteryBoxesByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "MYSTERY_BOX" },
    });
  },

  async expireAllForRace(raceId) {
    return prisma.racePowerup.updateMany({
      where: { raceId, status: { in: ["HELD", "MYSTERY_BOX"] } },
      data: { status: "EXPIRED" },
    });
  },
};

module.exports = { RacePowerup };
