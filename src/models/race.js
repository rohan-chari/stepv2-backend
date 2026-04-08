const { prisma } = require("../db");

const participantInclude = {
  participants: {
    include: {
      user: { select: { id: true, displayName: true } },
    },
    orderBy: { joinedAt: "asc" },
  },
};

const Race = {
  async findById(id) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, displayName: true } },
        winner: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
    });
  },

  async create({
    creatorId,
    name,
    targetSteps,
    maxDurationDays,
    powerupsEnabled = false,
    powerupStepInterval = null,
    buyInAmount = 0,
    payoutPreset = "WINNER_TAKES_ALL",
    potCoins = 0,
  }) {
    return prisma.race.create({
      data: {
        creatorId,
        name,
        targetSteps,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        potCoins,
      },
      include: {
        creator: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
    });
  },

  async update(id, fields) {
    return prisma.race.update({
      where: { id },
      data: fields,
      include: {
        creator: { select: { id: true, displayName: true } },
        winner: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
    });
  },

  async addToPot(id, amount) {
    return prisma.race.update({
      where: { id },
      data: { potCoins: { increment: amount } },
      include: {
        creator: { select: { id: true, displayName: true } },
        winner: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
    });
  },

  async updateIfActive(id, fields) {
    return prisma.race.updateMany({
      where: { id, status: "ACTIVE" },
      data: fields,
    });
  },

  async findForUser(userId) {
    return prisma.race.findMany({
      where: {
        participants: { some: { userId } },
      },
      include: {
        creator: { select: { id: true, displayName: true } },
        winner: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
      orderBy: { updatedAt: "desc" },
    });
  },

  async findActiveForUser(userId) {
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        participants: { some: { userId, status: "ACCEPTED" } },
      },
      include: {
        creator: { select: { id: true, displayName: true } },
        winner: { select: { id: true, displayName: true } },
        ...participantInclude,
      },
      orderBy: { updatedAt: "desc" },
    });
  },

  async findActiveExpired(now) {
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        endsAt: { lte: now },
      },
      include: {
        ...participantInclude,
      },
    });
  },
};

module.exports = { Race };
