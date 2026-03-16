const { prisma } = require("../db");

const ChallengeInstance = {
  async findById(id) {
    return prisma.challengeInstance.findUnique({
      where: { id },
      include: {
        challenge: true,
        stake: true,
        proposedStake: true,
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
    });
  },

  async findByPairAndWeek(userAId, userBId, weekOf) {
    return prisma.challengeInstance.findFirst({
      where: {
        weekOf: new Date(weekOf),
        OR: [
          { userAId, userBId },
          { userAId: userBId, userBId: userAId },
        ],
      },
    });
  },

  async create({ challengeId, weekOf, userAId, userBId }) {
    return prisma.challengeInstance.create({
      data: {
        challengeId,
        weekOf: new Date(weekOf),
        userAId,
        userBId,
      },
    });
  },

  async update(id, fields) {
    return prisma.challengeInstance.update({
      where: { id },
      data: fields,
    });
  },

  async findForUser(userId, weekOf) {
    return prisma.challengeInstance.findMany({
      where: {
        weekOf: new Date(weekOf),
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      include: {
        challenge: true,
        stake: true,
        proposedStake: true,
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
    });
  },

  async findByWeek(weekOf) {
    return prisma.challengeInstance.findMany({
      where: {
        weekOf: new Date(weekOf),
      },
      include: {
        challenge: true,
        stake: true,
        proposedStake: true,
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  },

  async deleteByWeek(weekOf) {
    const result = await prisma.challengeInstance.deleteMany({
      where: {
        weekOf: new Date(weekOf),
      },
    });

    return result.count;
  },

  async findHistoryForUser(userId, { page, limit }) {
    const skip = (page - 1) * limit;

    const [instances, total] = await Promise.all([
      prisma.challengeInstance.findMany({
        where: {
          status: "COMPLETED",
          OR: [{ userAId: userId }, { userBId: userId }],
        },
        include: {
          challenge: true,
          stake: true,
          userA: { select: { id: true, displayName: true } },
          userB: { select: { id: true, displayName: true } },
        },
        orderBy: { weekOf: "desc" },
        skip,
        take: limit,
      }),
      prisma.challengeInstance.count({
        where: {
          status: "COMPLETED",
          OR: [{ userAId: userId }, { userBId: userId }],
        },
      }),
    ]);

    return { instances, total };
  },

  async findActiveAndPending(weekOf) {
    return prisma.challengeInstance.findMany({
      where: {
        weekOf: new Date(weekOf),
        status: { in: ["PENDING_STAKE", "ACTIVE"] },
      },
      include: { challenge: true },
    });
  },
};

module.exports = { ChallengeInstance };
