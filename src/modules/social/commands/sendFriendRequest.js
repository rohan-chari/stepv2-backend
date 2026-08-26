const { User } = require("../../users");
const { prisma: defaultPrisma } = require("../../../db");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const {
  withFriendshipPairLock,
} = require("../services/friendshipPairLock");

class FriendRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "FriendRequestError";
  }
}

function buildSendFriendRequest(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const userModel = dependencies.User || User;
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const beforeWrite = dependencies.beforeFriendshipWrite || (async () => {});

  return async function sendFriendRequest({ userId, addresseeId }) {
    if (userId === addresseeId) {
      throw new FriendRequestError("You cannot send a friend request to yourself");
    }

    const addressee = await userModel.findById(addresseeId);
    if (!addressee) {
      throw new FriendRequestError("User not found");
    }

    const result = await withFriendshipPairLock(
      userId,
      addresseeId,
      async (tx) => {
        const existingRows = await tx.friendship.findMany({
          where: {
            OR: [
              { requesterId: userId, addresseeId },
              { requesterId: addresseeId, addresseeId: userId },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        // Pair locking prevents any new reverse duplicate. If historical rows
        // already exist, prefer the strongest state instead of reopening a
        // second row based on whichever direction findFirst happened to pick.
        const existing =
          existingRows.find((row) => row.status === "ACCEPTED") ||
          existingRows.find((row) => row.status === "PENDING") ||
          existingRows.find((row) => row.status === "DECLINED") ||
          null;

        if (existing?.status === "ACCEPTED") {
          throw new FriendRequestError("You are already friends");
        }
        if (existing?.status === "PENDING") {
          if (existing.requesterId === addresseeId) {
            await beforeWrite({ existing, status: "ACCEPTED", prisma: tx });
            const friendship = await tx.friendship.update({
                where: { id: existing.id },
                data: { status: "ACCEPTED" },
              });
            await appendDomainEvent(tx, {
              eventKey: `FRIEND_REQUEST_ACCEPTED_V1:${existing.id}`,
              eventType: "FRIEND_REQUEST_ACCEPTED_V1", schemaVersion: 1,
              aggregateType: "FRIENDSHIP", aggregateId: existing.id,
              occurredAt: friendship.updatedAt || new Date(),
              payload: { friendshipId: existing.id, accepterId: userId, requesterId: addresseeId },
              audience: [{ recipientId: addresseeId, facts: {} }],
            });
            return { friendship };
          }
          throw new FriendRequestError("A friend request already exists");
        }
        if (existing?.status === "DECLINED") {
          await beforeWrite({ existing, status: "PENDING", prisma: tx });
          const friendship = await tx.friendship.update({
              where: { id: existing.id },
              data: { status: "PENDING" },
            });
          // A friendship row can be declined and opened again. The initial
          // occurrence owns the base V1 key, so a later legitimate request
          // needs an occurrence identity rather than reusing and conflicting
          // with that immutable event. `updatedAt` is committed with this
          // transition and therefore also keeps transaction retries stable.
          const reopenedOccurrenceId = friendship.updatedAt.toISOString();
          await appendDomainEvent(tx, {
            eventKey: `FRIEND_REQUEST_SENT_V1:${existing.id}:reopened:${reopenedOccurrenceId}`,
            eventType: "FRIEND_REQUEST_SENT_V1", schemaVersion: 1,
            aggregateType: "FRIENDSHIP", aggregateId: existing.id,
            occurredAt: friendship.updatedAt || new Date(),
            payload: { friendshipId: existing.id, requesterId: userId, addresseeId },
            audience: [{ recipientId: addresseeId, facts: {} }],
          });
          return { friendship };
        }

        await beforeWrite({ existing: null, status: "PENDING", prisma: tx });
        const friendship = await tx.friendship.create({
            data: { requesterId: userId, addresseeId },
          });
        await appendDomainEvent(tx, {
          eventKey: `FRIEND_REQUEST_SENT_V1:${friendship.id}`,
          eventType: "FRIEND_REQUEST_SENT_V1", schemaVersion: 1,
          aggregateType: "FRIENDSHIP", aggregateId: friendship.id,
          occurredAt: friendship.createdAt || new Date(),
          payload: { friendshipId: friendship.id, requesterId: userId, addresseeId },
          audience: [{ recipientId: addresseeId, facts: {} }],
        });
        return { friendship };
      },
      { prisma: db }
    );

    await require("../../users/services/authMeCache").invalidatePairSafe(
      userId,
      addresseeId
    );
    await require("../services/friendsTopologyCache").invalidatePairSafe(
      userId,
      addresseeId
    );
    return result.friendship;
  };
}

const sendFriendRequest = buildSendFriendRequest();

module.exports = {
  buildSendFriendRequest,
  sendFriendRequest,
  FriendRequestError,
};
