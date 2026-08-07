const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

// TR-205: leaving a PENDING team race is free — the HELD buy-in is released and
// the participant row is deleted, so a later re-join is a fresh join (either
// side). TR-208: the creator can never leave their own lobby (their exits are
// cancel/delete while PENDING or forfeit while ACTIVE). Team races only: the
// individual-race lobby has never had a leave affordance, and adding one would
// change shipped-client behavior.
class RaceLeaveError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceLeaveError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");

function buildLeaveRace(dependencies = {}) {
  // C0 (spec §5a item 4): after this command's own small writes, mark the race
  // dirty so the race-keyed worker re-converges its standings. Best-effort and
  // stubbed out for injected fakes so unit tests stay DB-free.
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function leaveRace({ userId, raceId }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceLeaveError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceLeaveError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (!race.isTeamRace) {
      throw new RaceLeaveError("This race does not support leaving", 400);
    }
    if (race.creatorId === userId) {
      throw new RaceLeaveError(
        "The race creator can't leave — cancel the race instead",
        400
      );
    }
    if (race.status === "ACTIVE") {
      throw new RaceLeaveError(
        "The race has already started — you can forfeit instead",
        409,
        "RACE_ALREADY_STARTED"
      );
    }
    assertStatusIn(
      race,
      ["PENDING"],
      () => new RaceLeaveError("This race is no longer running", 400)
    );

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new RaceLeaveError("You are not in this race", 403);
    }

    // Release a HELD buy-in before dropping the row (mirrors kickRaceParticipant).
    await refundHeldBuyIn({
      participant,
      awardCoinsFn,
      refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
        refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
    });

    await participantModel.delete(participant.id);

    events.emit("RACE_PARTICIPANT_LEFT", {
      raceId,
      userId,
      creatorUserId: race.creatorId,
      raceName: race.name,
    });

    await invalidateRaceProgress(raceId);

    await enqueueRaceResolution({ raceId, userId });


    // C2 invalidation (spec §5 Phase C item 6): a membership change alters the

    // chat's access context (who may read it, who appears in it), so the cached

    // lists must never survive it. Same atomic `SET msgver` + `DEL list` as a

    // post, for BOTH kinds, keyed off this change's own timestamp.

    await invalidateRaceMessagesCache(raceId);
    return { success: true };
  };
}

const leaveRace = buildLeaveRace();


// Best-effort: a cache DEL must never fail a membership change.
async function invalidateRaceMessagesCache(raceId) {
  try {
    const {
      invalidateRace,
    } = require("../../social/services/raceMessagesCache");
    await invalidateRace(raceId);
  } catch {}
}

module.exports = { buildLeaveRace, leaveRace, RaceLeaveError };
