const { Friendship } = require("../models/friendship");
const { eventBus } = require("../events/eventBus");

class RemoveFriendError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoveFriendError";
  }
}

async function removeFriend({ userId, friendshipId }) {
  const friendship = await Friendship.findById(friendshipId);

  if (!friendship) {
    throw new RemoveFriendError("Friendship not found");
  }

  const isParticipant =
    friendship.requesterId === userId || friendship.addresseeId === userId;
  if (!isParticipant) {
    throw new RemoveFriendError("You are not part of this friendship");
  }

  const otherUserId =
    friendship.requesterId === userId
      ? friendship.addresseeId
      : friendship.requesterId;

  await Friendship.delete(friendshipId);

  eventBus.emit("FRIENDSHIP_REMOVED", {
    userId,
    otherUserId,
    friendshipId,
  });

  return {};
}

module.exports = { removeFriend, RemoveFriendError };
