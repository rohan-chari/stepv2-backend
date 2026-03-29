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

  async create({ creatorId, name, targetSteps, maxDurationDays }) {
    return prisma.race.create({
      data: { creatorId, name, targetSteps, maxDurationDays },
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
