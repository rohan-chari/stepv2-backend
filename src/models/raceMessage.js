const { prisma } = require("../db");

const senderInclude = {
  sender: { select: { id: true, displayName: true, profilePhotoUrl: true } },
};

const RaceMessage = {
  async create({ raceId, senderId, body, kind = "USER" }) {
    return prisma.raceMessage.create({
      data: { raceId, senderId, body, kind },
      include: senderInclude,
    });
  },

  async findById(id) {
    return prisma.raceMessage.findUnique({
      where: { id },
      include: senderInclude,
    });
  },

  async findByRace(raceId, { cursor, limit = 50 } = {}) {
    const where = { raceId, deletedAt: null };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }
    return prisma.raceMessage.findMany({
      where,
      include: senderInclude,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  async countSentBySenderSince(senderId, raceId, sinceDate) {
    return prisma.raceMessage.count({
      where: {
        senderId,
        raceId,
        createdAt: { gt: sinceDate },
      },
    });
  },

  async softDelete(id) {
    return prisma.raceMessage.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  },
};

module.exports = { RaceMessage };
