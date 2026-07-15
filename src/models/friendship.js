const { prisma } = require("../db");

const userDisplaySelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  // TR-708: last-seen client feature tokens, so the friends list can compute
  // the per-friend teamRaceEligible flag. Never serialized raw — the queries
  // map it into the boolean before responding.
  clientFeatures: true,
  equippedAccessories: {
    include: {
      shopItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          slot: true,
          assetKey: true,
          renderMetadata: true,
          bobble: true,
          testOnly: true,
        },
      },
    },
  },
};

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

  async findAcceptedFriendIds(prisma, userId) {
    const friendships = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const ids = new Set();
    for (const f of friendships) {
      ids.add(f.requesterId === userId ? f.addresseeId : f.requesterId);
    }
    return [...ids];
  },

  async findFriends(userId) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: userDisplaySelect },
        addressee: { select: userDisplaySelect },
      },
    });
  },

  async findAcceptedFriendsWithDisplay(userId) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: userDisplaySelect },
        addressee: { select: userDisplaySelect },
      },
    });
  },

  async findPendingIncoming(userId) {
    return prisma.friendship.findMany({
      where: { addresseeId: userId, status: "PENDING" },
      include: {
        requester: { select: { id: true, displayName: true, profilePhotoUrl: true } },
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

  async delete(id) {
    return prisma.friendship.delete({ where: { id } });
  },

  async findPendingOutgoing(userId) {
    return prisma.friendship.findMany({
      where: { requesterId: userId, status: "PENDING" },
      include: {
        addressee: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
    });
  },
};

module.exports = { Friendship };
