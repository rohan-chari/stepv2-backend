const { prisma } = require("../db");

const User = {
  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByAppleId(appleId) {
    return prisma.user.findUnique({ where: { appleId } });
  },

  async findByEmail(email) {
    return prisma.user.findFirst({ where: { email } });
  },

  async create({ appleId, email, name }) {
    return prisma.user.create({
      data: { appleId, email, name },
    });
  },

  async update(id, fields) {
    return prisma.user.update({
      where: { id },
      data: fields,
    });
  },

  async getHeldCoins(userId) {
    const result = await prisma.raceParticipant.aggregate({
      where: {
        userId,
        buyInStatus: "HELD",
      },
      _sum: {
        buyInAmount: true,
      },
    });

    return result._sum.buyInAmount || 0;
  },

  async findByDisplayNameInsensitive(displayName, excludeUserId) {
    return prisma.user.findFirst({
      where: {
        displayName: { equals: displayName, mode: "insensitive" },
        id: { not: excludeUserId },
      },
    });
  },

  async searchByDisplayName(query, excludeUserId) {
    return prisma.user.findMany({
      where: {
        displayName: { contains: query, mode: "insensitive" },
        id: { not: excludeUserId },
        NOT: { displayName: null },
        // Hide review/demo accounts from real users' friend search.
        isReviewAccount: false,
      },
      select: { id: true, displayName: true, profilePhotoUrl: true },
      take: 20,
    });
  },
};

module.exports = { User };
