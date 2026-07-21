const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../../steps/models/steps");
const { User } = require("../../users");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");

const {
  isTeamSideFull,
  pickAutoAssignTeam,
  clientSupportsTeamRaces,
} = require("../teamRaces");

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
  // Holds use the balance-guarded atomic debit (ensureUserCanAfford is only a
  // fast-fail pre-check); an injected awardCoins fake still takes both roles.
  const holdCoinsFn =
    dependencies.awardCoins ||
    buildAtomicHoldFn({
      ErrorClass: RaceInviteResponseError,
      code: "INSUFFICIENT_COINS",
    });
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
      throw new RaceInviteResponseError("Race not found", 404, "RACE_NOT_FOUND");
    }
    if (race.tournamentId) {
      throw new RaceInviteResponseError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceInviteResponseError(
        "This race is no longer accepting responses",
        400,
        "RACE_NOT_ACCEPTING"
      );
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new RaceInviteResponseError(
        "You are not invited to this race",
        403,
        "NOT_INVITED"
      );
    }
    if (participant.status !== "INVITED") {
      throw new RaceInviteResponseError(
        "You have already responded to this invite",
        400,
        "ALREADY_RESPONDED"
      );
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
        // Issue 3a: no explicit side (old homepage ACCEPT sends none) ->
        // auto-assign the smaller side (tie -> TEAM_A). Both sides full ->
        // TEAM_FULL, the invite row stays INVITED (we throw before any update).
        const auto = pickAutoAssignTeam(race);
        if (!auto) {
          throw new RaceInviteResponseError("That team is full", 409, "TEAM_FULL");
        }
        acceptTeam = auto;
      } else {
        // TR-202/207: chosen side at cap -> TEAM_FULL; the invite row stays
        // INVITED (we throw before any update), so it becomes acceptable again
        // if a slot frees up.
        if (isTeamSideFull(race, team)) {
          throw new RaceInviteResponseError("That team is full", 409, "TEAM_FULL");
        }
        acceptTeam = team;
      }
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
          400,
          "PAID_RACE_LOCKED"
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
        code: "INSUFFICIENT_COINS",
      });
      updateFields.buyInAmount = buyInAmount;
      updateFields.buyInStatus = race.status === "ACTIVE" ? "COMMITTED" : "HELD";
    }

    const updated = await participantModel.update(participant.id, updateFields);

    if (accept && buyInAmount > 0) {
      await reserveRaceBuyIn({
        awardCoinsFn: holdCoinsFn,
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
