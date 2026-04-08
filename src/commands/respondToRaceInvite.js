const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const {
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");

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
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
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
    const buyInAmount = race.buyInAmount || 0;

    // Late joiner: snapshot current steps so only post-join steps count
    if (accept && race.status === "ACTIVE") {
      if (
        buyInAmount > 0 &&
        race.participants.some((existingParticipant) => existingParticipant.finishedAt)
      ) {
        throw new RaceInviteResponseError(
          "You cannot join a paid race after someone has finished",
          400
        );
      }

      const today = new Date().toISOString().slice(0, 10);
      const todaySteps = await stepsModel.findByUserIdAndDate(userId, today);
      updateFields.baselineSteps = todaySteps?.steps ?? 0;
      updateFields.joinedAt = new Date();

      // Initialize powerup thresholds for late joiners
      if (race.powerupsEnabled && race.powerupStepInterval) {
        updateFields.nextBoxAtSteps = race.powerupStepInterval;
      }
    }

    if (accept && buyInAmount > 0) {
      await ensureUserCanAfford({
        userModel,
        userId,
        amount: buyInAmount,
        ErrorClass: RaceInviteResponseError,
      });
      updateFields.buyInAmount = buyInAmount;
      updateFields.buyInStatus = race.status === "ACTIVE" ? "COMMITTED" : "HELD";
    }

    const updated = await participantModel.update(participant.id, updateFields);

    if (accept && buyInAmount > 0) {
      await reserveRaceBuyIn({
        awardCoinsFn,
        userId,
        raceId,
        amount: buyInAmount,
      });

      if (race.status === "ACTIVE") {
        await raceModel.update(raceId, {
          potCoins: (race.potCoins || 0) + buyInAmount,
        });
      }
    }

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
