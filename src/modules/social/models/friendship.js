const { prisma } = require("../../../db");

// C5 (spec §5 Phase E2): `/auth/me` carries `incomingFriendRequests`, a COUNT
// over this table, and the client refreshes `/auth/me` IMMEDIATELY after every
// friend accept / decline / send / remove (FriendsTab.onFriendsChanged ->
// main_shell.dart:2601). So every mutation here invalidates BOTH sides'
// assembled payload — the requester's and the addressee's — because either
// side's pending count can change.
//
// Lazy require + swallow: cache bookkeeping must never fail a friendship write.
async function invalidateAuthMePair(a, b) {
  try {
    await require("../../users/services/authMeCache").invalidatePairSafe(a, b);
  } catch {}
}

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
    const created = await prisma.friendship.create({
      data: { requesterId, addresseeId },
    });
    await invalidateAuthMePair(requesterId, addresseeId);
    return created;
  },

  async updateStatus(id, status) {
    const updated = await prisma.friendship.update({
      where: { id },
      data: { status },
    });
    await invalidateAuthMePair(updated.requesterId, updated.addresseeId);
    return updated;
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
    const removed = await prisma.friendship.delete({ where: { id } });
    await invalidateAuthMePair(removed.requesterId, removed.addresseeId);
    return removed;
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
