const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");
const { censor } = require("../../../shared/lib/profanity");
const { eventBus } = require("../../../shared/events/eventBus");

const MAX_BODY_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 5;

class RaceMessageError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "RaceMessageError";
    this.statusCode = statusCode;
  }
}

function buildSendRaceMessage(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const raceMessageModel = dependencies.RaceMessage || RaceMessage;
  const censorFn = dependencies.censor || censor;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || Date.now;

  return async function sendRaceMessage({ userId, raceId, body }) {
    if (typeof body !== "string") {
      throw new RaceMessageError("Message body is required");
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new RaceMessageError("Message cannot be empty");
    }
    if (trimmed.length > MAX_BODY_LENGTH) {
      throw new RaceMessageError(`Message too long (max ${MAX_BODY_LENGTH})`);
    }

    const race = await raceModel.findById(raceId);
    if (!race) throw new RaceMessageError("Race not found", 404);

    if (race.status === "COMPLETED" || race.status === "CANCELLED") {
      throw new RaceMessageError("Chat is closed for this race", 403);
    }

    const participant = race.participants.find((p) => p.userId === userId);
    if (!participant) {
      throw new RaceMessageError("You are not a participant in this race", 403);
    }
    if (participant.status !== "ACCEPTED") {
      throw new RaceMessageError("Only accepted participants can post", 403);
    }

    const since = new Date(now() - RATE_LIMIT_WINDOW_MS);
    const recentCount = await raceMessageModel.countSentBySenderSince(
      userId,
      raceId,
      since
    );
    if (recentCount >= RATE_LIMIT_MAX) {
      throw new RaceMessageError("Slow down — too many messages", 429);
    }

    const cleaned = censorFn(trimmed);

    const message = await raceMessageModel.create({
      raceId,
      senderId: userId,
      body: cleaned,
      kind: "USER",
    });

    events.emit("RACE_MESSAGE_SENT", {
      raceId,
      messageId: message.id,
      senderId: userId,
      body: cleaned,
      senderName: message.sender?.displayName ?? null,
      raceName: race.name,
    });

    return message;
  };
}

const sendRaceMessage = buildSendRaceMessage();

module.exports = { buildSendRaceMessage, sendRaceMessage, RaceMessageError };
