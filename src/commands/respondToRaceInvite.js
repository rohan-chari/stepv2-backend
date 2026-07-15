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

const {
  isTeamSideFull,
  clientSupportsTeamRaces,
} = require("../utils/teamRaces");

class RaceInviteResponseError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceInviteResponseError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (TEAM_FULL, RACE_ALREADY_STARTED,
    // UPDATE_REQUIRED). Additive — routes serialize it alongside `error`.
    if (code) this.code = code;
  }
}

function buildRespondToRaceInvite(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  // Team races (TR-200s): accepting requires a `team` side, only while the race
  // is still PENDING, and only from a client declaring team_races support.
  // Declining needs none of that (an old client never sees the invite anyway —
  // TR-703 list filtering — but declining is always safe).
  return async function respondToRaceInvite({
    userId,
    raceId,
    accept,
    team = null,
    clientFeatures = null,
  }) {
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

    let acceptTeam = null;
    if (accept && race.isTeamRace) {
      // TR-703: defense-in-depth against old clients.
      if (!clientSupportsTeamRaces(clientFeatures)) {
        throw new RaceInviteResponseError(
          "Update the app to join team races",
          400,
          "UPDATE_REQUIRED"
        );
      }
      // TR-204: no joining once ACTIVE, on any channel.
      if (race.status !== "PENDING") {
        throw new RaceInviteResponseError(
          "This race has already started",
          409,
          "RACE_ALREADY_STARTED"
        );
      }
      if (team !== "TEAM_A" && team !== "TEAM_B") {
        throw new RaceInviteResponseError(
          "Pick a team (TEAM_A or TEAM_B) to accept this invite",
          400
        );
      }
      // TR-202/207: chosen side at cap -> TEAM_FULL; the invite row stays
      // INVITED (we throw before any update), so it becomes acceptable again
      // if a slot frees up.
      if (isTeamSideFull(race, team)) {
        throw new RaceInviteResponseError(
          "That team is full",
          409,
          "TEAM_FULL"
        );
      }
      acceptTeam = team;
    }

    const newStatus = accept ? "ACCEPTED" : "DECLINED";
    const updateFields = { status: newStatus };
    if (acceptTeam) {
      updateFields.team = acceptTeam;
    }
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
