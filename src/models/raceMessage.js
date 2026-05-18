const { prisma } = require("../db");

const senderInclude = {
  sender: { select: { id: true, displayName: true, profilePhotoUrl: true } },
};

function applyCursor(where, cursor) {
  if (!cursor) return;

  if (typeof cursor === "object" && cursor.createdAt) {
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) return;

    if (cursor.kind === "USER" && cursor.id) {
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: cursor.id } },
      ];
      return;
    }

    where.createdAt = { lt: createdAt };
    return;
  }

  const createdAt = new Date(cursor);
  if (!Number.isNaN(createdAt.getTime())) {
    where.createdAt = { lt: createdAt };
  }
}

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
    applyCursor(where, cursor);
    return prisma.raceMessage.findMany({
      where,
      include: senderInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
