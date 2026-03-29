const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { eventBus } = require("../events/eventBus");

class RaceInviteResponseError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceInviteResponseError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildRespondToRaceInvite(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const events = dependencies.eventBus || eventBus;

  return async function respondToRaceInvite({ userId, raceId, accept }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceInviteResponseError("Race not found", 404);
    }
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceInviteResponseError("This race is no longer accepting responses", 400);
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new RaceInviteResponseError("You are not invited to this race", 403);
    }
    if (participant.status !== "INVITED") {
      throw new RaceInviteResponseError("You have already responded to this invite", 400);
    }

    const newStatus = accept ? "ACCEPTED" : "DECLINED";
    const updateFields = { status: newStatus };

    // Late joiner: snapshot current steps so only post-join steps count
    if (accept && race.status === "ACTIVE") {
      const today = new Date().toISOString().slice(0, 10);
      const todaySteps = await stepsModel.findByUserIdAndDate(userId, today);
      updateFields.baselineSteps = todaySteps?.steps ?? 0;
      updateFields.joinedAt = new Date();
    }

    const updated = await participantModel.update(participant.id, updateFields);

    if (accept) {
      events.emit("RACE_INVITE_ACCEPTED", {
        raceId,
        userId,
        creatorUserId: race.creatorId,
        raceName: race.name,
      });
    } else {
      events.emit("RACE_INVITE_DECLINED", {
        raceId,
        userId,
        creatorUserId: race.creatorId,
      });
    }

    return updated;
  };
}

const respondToRaceInvite = buildRespondToRaceInvite();

module.exports = { buildRespondToRaceInvite, respondToRaceInvite, RaceInviteResponseError };
