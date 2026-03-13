const { Friendship } = require("../models/friendship");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");

class FriendRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "FriendRequestError";
  }
}

async function sendFriendRequest({ userId, addresseeId }) {
  if (userId === addresseeId) {
    throw new FriendRequestError("You cannot send a friend request to yourself");
  }

  const addressee = await User.findById(addresseeId);

  if (!addressee) {
    throw new FriendRequestError("User not found");
  }

  if (!addressee.displayName) {
    throw new FriendRequestError(
      "Cannot send a friend request to a user without a display name"
    );
  }

  const existing = await Friendship.findBetweenUsers(userId, addresseeId);

  if (existing) {
    if (existing.status === "ACCEPTED") {
      throw new FriendRequestError("You are already friends");
    }

    if (existing.status === "PENDING") {
      // If the other person sent the request, auto-accept
      if (existing.requesterId === addresseeId) {
        const updated = await Friendship.updateStatus(existing.id, "ACCEPTED");
        eventBus.emit("FRIEND_REQUEST_ACCEPTED", {
          userId,
          friendshipId: existing.id,
          requesterId: addresseeId,
        });
        return updated;
      }
      throw new FriendRequestError("A friend request already exists");
    }

    if (existing.status === "DECLINED") {
      const updated = await Friendship.updateStatus(existing.id, "PENDING");
      eventBus.emit("FRIEND_REQUEST_SENT", { userId, addresseeId });
      return updated;
    }
  }

  const friendship = await Friendship.create({ requesterId: userId, addresseeId });
  eventBus.emit("FRIEND_REQUEST_SENT", { userId, addresseeId });
  return friendship;
}

module.exports = { sendFriendRequest, FriendRequestError };
