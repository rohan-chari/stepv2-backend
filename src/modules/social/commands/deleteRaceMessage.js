const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");
const raceMessagesCache = require("../services/raceMessagesCache");

class DeleteRaceMessageError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "DeleteRaceMessageError";
    this.statusCode = statusCode;
  }
}

async function deleteRaceMessage({ userId, raceId, messageId }) {
  const message = await RaceMessage.findById(messageId);
  if (!message || message.deletedAt) {
    throw new DeleteRaceMessageError("Message not found", 404);
  }
  if (message.raceId !== raceId) {
    throw new DeleteRaceMessageError("Message not in this race", 404);
  }

  const race = await Race.findById(raceId);
  if (!race) throw new DeleteRaceMessageError("Race not found", 404);

  const isSender = message.senderId && message.senderId === userId;
  const isCreator = race.creatorId === userId;
  if (!isSender && (!isCreator || message.audience === "TEAM")) {
    throw new DeleteRaceMessageError("Not authorized to delete", 403);
  }

  await RaceMessage.softDelete(messageId);
  // C2 invalidation: a soft-deleted row must disappear from the cached list.
  // The marker advances off the deletion instant, which is strictly newer than
  // any row already in the list.
  await raceMessagesCache.invalidateKind(
    raceId,
    "USER",
    { id: messageId, createdAt: new Date() },
    message.audience || "ALL",
    message.audience === "TEAM" ? message.team : null,
  );
  return { success: true };
}

module.exports = { deleteRaceMessage, DeleteRaceMessageError };
