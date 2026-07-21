const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");

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
  if (!isSender && !isCreator) {
    throw new DeleteRaceMessageError("Not authorized to delete", 403);
  }

  await RaceMessage.softDelete(messageId);
  return { success: true };
}

module.exports = { deleteRaceMessage, DeleteRaceMessageError };
