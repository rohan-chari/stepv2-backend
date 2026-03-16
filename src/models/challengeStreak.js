const { prisma } = require("../db");

const ChallengeStreak = {
  async findByPair(userAId, userBId) {
    return prisma.challengeStreak.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
    });
  },

  async create(data) {
    return prisma.challengeStreak.create({ data });
  },

  async save(streak) {
    return prisma.challengeStreak.update({
      where: { id: streak.id },
      data: {
        currentWinnerUserId: streak.currentWinnerUserId,
        currentStreak: streak.currentStreak,
        userALifetimeWins: streak.userALifetimeWins,
        userBLifetimeWins: streak.userBLifetimeWins,
        lastResolvedAt: new Date(),
      },
    });
  },

  async findForUser(userId) {
    return prisma.challengeStreak.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      include: {
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
    });
  },

  async findForPair(userId, friendUserId) {
    const [userAId, userBId] = [userId, friendUserId].sort();
    return prisma.challengeStreak.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      include: {
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
    });
  },
};

module.exports = { ChallengeStreak };
