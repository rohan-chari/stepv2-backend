const { prisma } = require("../db");

const Friendship = {
  async findById(id) {
    return prisma.friendship.findUnique({ where: { id } });
  },

  async findBetweenUsers(userId1, userId2) {
    return prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userId1, addresseeId: userId2 },
          { requesterId: userId2, addresseeId: userId1 },
        ],
      },
    });
  },

  async create({ requesterId, addresseeId }) {
    return prisma.friendship.create({
      data: { requesterId, addresseeId },
    });
  },

  async updateStatus(id, status) {
    return prisma.friendship.update({
      where: { id },
      data: { status },
    });
  },

  async findFriends(userId) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: { id: true, displayName: true } },
        addressee: { select: { id: true, displayName: true } },
      },
    });
  },

  async findFriendsWithStepGoals(userId) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: { id: true, displayName: true, stepGoal: true } },
        addressee: { select: { id: true, displayName: true, stepGoal: true } },
      },
    });
  },

  async findPendingIncoming(userId) {
    return prisma.friendship.findMany({
      where: { addresseeId: userId, status: "PENDING" },
      include: {
        requester: { select: { id: true, displayName: true } },
      },
    });
  },

  async countPendingIncoming(userId) {
    return prisma.friendship.count({
      where: { addresseeId: userId, status: "PENDING" },
    });
  },

  async updateRelationshipType(id, relationshipType) {
    const typeMap = { partner: "PARTNER", friend: "FRIEND", family: "FAMILY" };
    return prisma.friendship.update({
      where: { id },
      data: { relationshipType: typeMap[relationshipType] },
    });
  },

  async findPendingOutgoing(userId) {
    return prisma.friendship.findMany({
      where: { requesterId: userId, status: "PENDING" },
      include: {
        addressee: { select: { id: true, displayName: true } },
      },
    });
  },
};

module.exports = { Friendship };
