const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  buildFriendshipAutoLinkSuppression,
} = require("../models/friendshipAutoLinkSuppression");
const {
  withFriendshipPairLock,
} = require("../services/friendshipPairLock");

class RemoveFriendError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoveFriendError";
  }
}

function buildRemoveFriend(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const suppressionModel =
    dependencies.FriendshipAutoLinkSuppression ||
    buildFriendshipAutoLinkSuppression({ prisma: db });
  const beforeSuppressionWrite =
    dependencies.beforeAutoLinkSuppressionWrite || (async () => {});

  return async function removeFriend({ userId, friendshipId }) {
    const friendship = await db.friendship.findUnique({
      where: { id: friendshipId },
    });

    if (!friendship) {
      throw new RemoveFriendError("Friendship not found");
    }

    const removed = await withFriendshipPairLock(
      friendship.requesterId,
      friendship.addresseeId,
      async (tx) => {
        const current = await tx.friendship.findUnique({
          where: { id: friendshipId },
        });
        if (!current) throw new RemoveFriendError("Friendship not found");
        const isParticipant =
          current.requesterId === userId || current.addresseeId === userId;
        if (!isParticipant) {
          throw new RemoveFriendError("You are not part of this friendship");
        }

        const result = await tx.friendship.delete({ where: { id: friendshipId } });
        await beforeSuppressionWrite({ friendship: result, prisma: tx });
        await suppressionModel.upsert(
          result.requesterId,
          result.addresseeId,
          "REMOVED",
          tx
        );
        return result;
      },
      { prisma: db }
    );

    const otherUserId =
      removed.requesterId === userId ? removed.addresseeId : removed.requesterId;

    await require("../../users/services/authMeCache").invalidatePairSafe(
      removed.requesterId,
      removed.addresseeId
    );
    await require("../services/friendsTopologyCache").invalidatePairSafe(
      removed.requesterId,
      removed.addresseeId
    );

    eventBus.emit("FRIENDSHIP_REMOVED", {
      userId,
      otherUserId,
      friendshipId,
    });

    return {};
  };
}

const removeFriend = buildRemoveFriend();

module.exports = { buildRemoveFriend, removeFriend, RemoveFriendError };
