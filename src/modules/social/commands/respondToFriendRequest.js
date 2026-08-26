const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const {
  buildFriendshipAutoLinkSuppression,
} = require("../models/friendshipAutoLinkSuppression");
const {
  withFriendshipPairLock,
} = require("../services/friendshipPairLock");

class FriendResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FriendResponseError";
  }
}

function buildRespondToFriendRequest(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const suppressionModel =
    dependencies.FriendshipAutoLinkSuppression ||
    buildFriendshipAutoLinkSuppression({ prisma: db });
  const beforeSuppressionWrite =
    dependencies.beforeAutoLinkSuppressionWrite || (async () => {});
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);

  return async function respondToFriendRequest({
    userId,
    friendshipId,
    accept,
  }) {
    const friendship = await db.friendship.findUnique({
      where: { id: friendshipId },
    });

    if (!friendship) {
      throw new FriendResponseError("Friend request not found");
    }

    const status = accept ? "ACCEPTED" : "DECLINED";
    const updated = await withFriendshipPairLock(
      friendship.requesterId,
      friendship.addresseeId,
      async (tx) => {
        const current = await tx.friendship.findUnique({
          where: { id: friendshipId },
        });
        if (!current) {
          throw new FriendResponseError("Friend request not found");
        }
        if (current.addresseeId !== userId) {
          throw new FriendResponseError("You are not the recipient of this request");
        }
        if (current.status !== "PENDING") {
          throw new FriendResponseError("This request has already been responded to");
        }

        const result = await tx.friendship.update({
          where: { id: friendshipId },
          data: { status },
        });
        if (!accept) {
          await beforeSuppressionWrite({ friendship: result, prisma: tx });
          await suppressionModel.upsert(
            current.requesterId,
            current.addresseeId,
            "DECLINED",
            tx
          );
        } else {
          await appendDomainEvent(tx, {
            eventKey: `FRIEND_REQUEST_ACCEPTED_V1:${result.id}`,
            eventType: "FRIEND_REQUEST_ACCEPTED_V1", schemaVersion: 1,
            aggregateType: "FRIENDSHIP", aggregateId: result.id,
            occurredAt: result.updatedAt || new Date(),
            payload: { friendshipId: result.id, accepterId: userId, requesterId: current.requesterId },
            audience: [{ recipientId: current.requesterId, facts: {} }],
          });
        }
        return result;
      },
      { prisma: db }
    );

    await require("../../users/services/authMeCache").invalidatePairSafe(
      updated.requesterId,
      updated.addresseeId
    );
    await require("../services/friendsTopologyCache").invalidatePairSafe(
      updated.requesterId,
      updated.addresseeId
    );

    if (!accept || dependencies.eventBus) {
      const event = accept ? "FRIEND_REQUEST_ACCEPTED" : "FRIEND_REQUEST_DECLINED";
      (dependencies.eventBus || eventBus).emit(event, {
        userId,
        friendshipId,
        requesterId: friendship.requesterId,
      });
    }

    return updated;
  };
}

const respondToFriendRequest = buildRespondToFriendRequest();

module.exports = {
  buildRespondToFriendRequest,
  respondToFriendRequest,
  FriendResponseError,
};
