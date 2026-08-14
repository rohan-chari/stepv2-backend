const { User } = require("../../users");
const { prisma: defaultPrisma } = require("../../../db");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
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
  const events = dependencies.eventBus || defaultEventBus;
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
            return {
              friendship: await tx.friendship.update({
                where: { id: existing.id },
                data: { status: "ACCEPTED" },
              }),
              event: "FRIEND_REQUEST_ACCEPTED",
              eventPayload: {
                userId,
                friendshipId: existing.id,
                requesterId: addresseeId,
              },
            };
          }
          throw new FriendRequestError("A friend request already exists");
        }
        if (existing?.status === "DECLINED") {
          await beforeWrite({ existing, status: "PENDING", prisma: tx });
          return {
            friendship: await tx.friendship.update({
              where: { id: existing.id },
              data: { status: "PENDING" },
            }),
            event: "FRIEND_REQUEST_SENT",
            eventPayload: { userId, addresseeId },
          };
        }

        await beforeWrite({ existing: null, status: "PENDING", prisma: tx });
        return {
          friendship: await tx.friendship.create({
            data: { requesterId: userId, addresseeId },
          }),
          event: "FRIEND_REQUEST_SENT",
          eventPayload: { userId, addresseeId },
        };
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
    events.emit(result.event, result.eventPayload);
    return result.friendship;
  };
}

const sendFriendRequest = buildSendFriendRequest();

module.exports = {
  buildSendFriendRequest,
  sendFriendRequest,
  FriendRequestError,
};
