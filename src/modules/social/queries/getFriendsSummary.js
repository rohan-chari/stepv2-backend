const { prisma: defaultPrisma } = require("../../../db");
const { TEAM_RACES_FEATURE } = require("../../races/teamRaces");

const summaryUserSelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  clientFeatures: true,
};

const pendingUserSelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
};

function buildGetFriendsSummary(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  return async function getFriendsSummary(userId) {
    const [accepted, incoming, outgoing] = await Promise.all([
      prisma.friendship.findMany({
        where: {
          status: "ACCEPTED",
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: {
          id: true,
          requesterId: true,
          requester: { select: summaryUserSelect },
          addressee: { select: summaryUserSelect },
        },
      }),
      prisma.friendship.findMany({
        where: { addresseeId: userId, status: "PENDING" },
        select: {
          id: true,
          requester: { select: pendingUserSelect },
        },
      }),
      prisma.friendship.findMany({
        where: { requesterId: userId, status: "PENDING" },
        select: {
          id: true,
          addressee: { select: pendingUserSelect },
        },
      }),
    ]);
    const friends = accepted
      .map((friendship) => {
        const user =
          friendship.requesterId === userId
            ? friendship.addressee
            : friendship.requester;
        return {
          id: user.id,
          displayName: user.displayName,
          profilePhotoUrl: user.profilePhotoUrl,
          friendshipId: friendship.id,
          teamRaceEligible:
            Array.isArray(user.clientFeatures) &&
            user.clientFeatures.includes(TEAM_RACES_FEATURE),
        };
      })
      .sort((left, right) =>
        (left.displayName ?? "").localeCompare(
          right.displayName ?? "",
          undefined,
          { sensitivity: "base" }
        )
      );
    const pending = {
      incoming: incoming.map((friendship) => ({
        friendshipId: friendship.id,
        user: friendship.requester,
      })),
      outgoing: outgoing.map((friendship) => ({
        friendshipId: friendship.id,
        user: friendship.addressee,
      })),
    };
    return {
      contract: "friends-summary-v1",
      incomingFriendRequests: pending.incoming.length,
      friends,
      pending,
    };
  };
}

const getFriendsSummary = buildGetFriendsSummary();

module.exports = { buildGetFriendsSummary, getFriendsSummary };
