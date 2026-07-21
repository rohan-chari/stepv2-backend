const { Friendship } = require("../models/friendship");

class RelationshipTypeError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RelationshipTypeError";
    if (statusCode) this.statusCode = statusCode;
  }
}

async function updateRelationshipType({
  userId,
  friendshipId,
  relationshipType,
}) {
  const friendship = await Friendship.findById(friendshipId);

  if (!friendship) {
    throw new RelationshipTypeError("Friendship not found", 404);
  }

  if (
    friendship.requesterId !== userId &&
    friendship.addresseeId !== userId
  ) {
    throw new RelationshipTypeError(
      "You are not a participant in this friendship",
      403
    );
  }

  if (friendship.status !== "ACCEPTED") {
    throw new RelationshipTypeError(
      "Can only set relationship type on accepted friendships"
    );
  }

  return Friendship.updateRelationshipType(friendshipId, relationshipType);
}

module.exports = { updateRelationshipType, RelationshipTypeError };
