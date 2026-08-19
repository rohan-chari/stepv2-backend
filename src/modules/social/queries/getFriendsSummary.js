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
    // One relationship read is enough for all three buckets. The previous
    // implementation issued three concurrent queries over the same indexed
    // user/status predicates on every Home refresh. Keep the response shape
    // unchanged by projecting pending users back to their narrower contract.
    const relationships = await prisma.friendship.findMany({
      where: {
        OR: [
          { status: "ACCEPTED", requesterId: userId },
          { status: "ACCEPTED", addresseeId: userId },
          { status: "PENDING", requesterId: userId },
          { status: "PENDING", addresseeId: userId },
        ],
      },
      select: {
        id: true,
        status: true,
        requesterId: true,
        addresseeId: true,
        requester: { select: summaryUserSelect },
        addressee: { select: summaryUserSelect },
      },
    });
    const accepted = relationships.filter((row) => row.status === "ACCEPTED");
    const incoming = relationships.filter(
      (row) => row.status === "PENDING" && row.addresseeId === userId
    );
    const outgoing = relationships.filter(
      (row) => row.status === "PENDING" && row.requesterId === userId
    );
    const pendingUser = (user) => {
      const out = {};
      for (const key of Object.keys(pendingUserSelect)) out[key] = user?.[key] ?? null;
      return out;
    };
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
        user: pendingUser(friendship.requester),
      })),
      outgoing: outgoing.map((friendship) => ({
        friendshipId: friendship.id,
        user: pendingUser(friendship.addressee),
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
