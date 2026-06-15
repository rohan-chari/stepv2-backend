const { prisma } = require("../db");

const User = {
  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByAppleId(appleId) {
    return prisma.user.findUnique({ where: { appleId } });
  },

  async findByGoogleSub(googleSub) {
    return prisma.user.findUnique({ where: { googleSub } });
  },

  async findByEmail(email) {
    return prisma.user.findFirst({ where: { email } });
  },

  async create({ appleId, googleSub, email, name, displayName, isReviewAccount }) {
    // A user is keyed on exactly one provider id (appleId for iOS, googleSub for
    // Android). Only set the one that was supplied so the other stays null.
    const data = { email, name };
    if (appleId !== undefined) {
      data.appleId = appleId;
    }
    if (googleSub !== undefined) {
      data.googleSub = googleSub;
    }
    if (displayName !== undefined) {
      data.displayName = displayName;
    }
    if (isReviewAccount !== undefined) {
      data.isReviewAccount = isReviewAccount;
    }
    return prisma.user.create({ data });
  },

  async update(id, fields) {
    return prisma.user.update({
      where: { id },
      data: fields,
    });
  },

  async findCoins(id) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { coins: true },
    });
    return user?.coins ?? 0;
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
