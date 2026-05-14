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

  async countOccupiedSlots(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: { in: ["HELD", "MYSTERY_BOX"] } },
    });
  },

  async findSlotPowerups(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: { in: ["HELD", "MYSTERY_BOX"] } },
      orderBy: { createdAt: "asc" },
    });
  },

  async countQueuedByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "QUEUED" },
    });
  },

  async findQueuedByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
    });
  },

  async findUsedTypesByParticipant(participantId) {
    const results = await prisma.racePowerup.findMany({
      where: { participantId, status: "USED", type: { not: null } },
      select: { type: true },
      distinct: ["type"],
    });
    return results.map((r) => r.type);
  },

  async swapHeldPowerups(sourcePowerupId, targetPowerupId) {
    return prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.racePowerup.findUnique({ where: { id: sourcePowerupId } }),
        tx.racePowerup.findUnique({ where: { id: targetPowerupId } }),
      ]);

      if (!source || !target) {
        throw new Error("Powerup not found");
      }

      const sourcePatch = {
        participantId: target.participantId,
        userId: target.userId,
      };
      const targetPatch = {
        participantId: source.participantId,
        userId: source.userId,
      };

      const updatedSource = await tx.racePowerup.update({
        where: { id: sourcePowerupId },
        data: sourcePatch,
      });
      const updatedTarget = await tx.racePowerup.update({
        where: { id: targetPowerupId },
        data: targetPatch,
      });

      return { source: updatedSource, target: updatedTarget };
    });
  },

  async expireAllForRace(raceId) {
    return prisma.racePowerup.updateMany({
      where: { raceId, status: { in: ["HELD", "MYSTERY_BOX", "QUEUED"] } },
      data: { status: "EXPIRED" },
    });
  },
};

module.exports = { RacePowerup };
