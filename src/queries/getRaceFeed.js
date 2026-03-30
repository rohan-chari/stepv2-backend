const { Race } = require("../models/race");
const { RacePowerupEvent } = require("../models/racePowerupEvent");

async function getRaceFeed(userId, raceId, { cursor, limit = 50 } = {}) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    const error = new Error("You are not a participant in this race");
    error.statusCode = 403;
    throw error;
  }

  const events = await RacePowerupEvent.findByRace(raceId, { cursor, limit });

  return {
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      powerupType: e.powerupType,
      description: e.description,
      actorUserId: e.actorUserId,
      targetUserId: e.targetUserId,
      metadata: e.metadata,
      createdAt: e.createdAt,
    })),
    nextCursor: events.length === limit ? events[events.length - 1].createdAt.toISOString() : null,
  };
}

module.exports = { getRaceFeed };
