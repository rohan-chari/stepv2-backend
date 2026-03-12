const { Friendship } = require("../models/friendship");
const { eventBus } = require("../events/eventBus");

class FriendResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FriendResponseError";
  }
}

async function respondToFriendRequest({ userId, friendshipId, accept }) {
  const friendship = await Friendship.findById(friendshipId);

  if (!friendship) {
    throw new FriendResponseError("Friend request not found");
  }

  if (friendship.addresseeId !== userId) {
    throw new FriendResponseError("You are not the recipient of this request");
  }

  if (friendship.status !== "PENDING") {
    throw new FriendResponseError("This request has already been responded to");
  }

  const status = accept ? "ACCEPTED" : "DECLINED";
  const updated = await Friendship.updateStatus(friendshipId, status);

  const event = accept ? "FRIEND_REQUEST_ACCEPTED" : "FRIEND_REQUEST_DECLINED";
  eventBus.emit(event, {
    userId,
    friendshipId,
    requesterId: friendship.requesterId,
  });

  return updated;
}

module.exports = { respondToFriendRequest, FriendResponseError };
