const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");

const RaceParticipant = {
  async findById(id) {
    return prisma.raceParticipant.findUnique({ where: { id } });
  },

  async findByRaceAndUser(raceId, userId) {
    return prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId } },
    });
  },

  async create({ raceId, userId, status, buyInAmount = 0, buyInStatus = "NONE" }) {
    return prisma.raceParticipant.create({
      data: { raceId, userId, status, buyInAmount, buyInStatus },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
    });
  },

  async createMany(records) {
    return prisma.raceParticipant.createMany({
      data: records,
      skipDuplicates: true,
    });
  },

  async update(id, fields) {
    return prisma.raceParticipant.update({
      where: { id },
      data: fields,
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
    });
  },

  async findByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async findAcceptedByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async findChargedByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: {
        raceId,
        buyInAmount: { gt: 0 },
        buyInStatus: { in: ["HELD", "COMMITTED"] },
      },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async countAccepted(raceId) {
    return prisma.raceParticipant.count({
      where: { raceId, status: "ACCEPTED" },
    });
  },

  async updateTotalSteps(id, totalSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { totalSteps },
    });
  },

  async markFinished(id, finishedAt, finishTotalSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { finishedAt, finishTotalSteps, totalSteps: finishTotalSteps, status: "ACCEPTED" },
    });
  },

  async setPlacement(id, placement) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { placement },
    });
  },

  async addBonusSteps(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { bonusSteps: { increment: amount } },
    });
  },

  async subtractBonusSteps(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { bonusSteps: { decrement: amount } },
    });
  },

  async updatePowerupSlots(id, powerupSlots) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { powerupSlots },
    });
  },

  async updateNextBoxAtSteps(id, nextBoxAtSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { nextBoxAtSteps },
    });
  },

  async updateMaxBonusSteps(id, maxBonusSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { maxBonusSteps },
    });
  },

  async updateMaxBoxProgressSteps(id, maxBoxProgressSteps) {
    // Monotonic high-water write: never lower the anchor. Guards against any
    // caller passing a lean/stale participant whose maxBoxProgressSteps wasn't
    // selected (which would compute a too-low high-water and clobber the stored
    // value). GREATEST makes the write idempotent and order-independent. Raw SQL
    // via Prisma.sql + $executeRaw (same adapter-pg-safe pattern as rollPowerup).
    return prisma.$executeRaw(
      Prisma.sql`UPDATE race_participants
                 SET max_box_progress_steps = GREATEST(COALESCE(max_box_progress_steps, 0), ${maxBoxProgressSteps})
                 WHERE id = ${id}`
    );
  },

  async delete(id) {
    return prisma.raceParticipant.delete({ where: { id } });
  },

  async incrementPayoutCoins(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { payoutCoins: { increment: amount } },
    });
  },
};

module.exports = { RaceParticipant };
