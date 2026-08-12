const { prisma: defaultPrisma } = require("../../../db");

function canonicalUserPair(left, right) {
  if (!left || !right || left === right) return null;
  return left < right
    ? { userAId: left, userBId: right }
    : { userAId: right, userBId: left };
}

function buildFriendshipAutoLinkSuppression(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  return {
    async find(left, right, client = db) {
      const pair = canonicalUserPair(left, right);
      if (!pair) return null;
      return client.friendshipAutoLinkSuppression.findUnique({
        where: { userAId_userBId: pair },
      });
    },
    async upsert(left, right, reason, client = db) {
      const pair = canonicalUserPair(left, right);
      if (!pair) return null;
      return client.friendshipAutoLinkSuppression.upsert({
        where: { userAId_userBId: pair },
        update: {},
        create: { ...pair, reason },
      });
    },
  };
}

const FriendshipAutoLinkSuppression =
  buildFriendshipAutoLinkSuppression();

module.exports = {
  canonicalUserPair,
  buildFriendshipAutoLinkSuppression,
  FriendshipAutoLinkSuppression,
};
