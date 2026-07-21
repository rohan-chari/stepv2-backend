const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

class RaceCancelError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceCancelError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildCancelRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function cancelRace({ userId, raceId }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceCancelError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceCancelError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    assertCreator(
      race,
      userId,
      () => new RaceCancelError("Only the race creator can cancel the race", 403)
    );
    // Two gate calls to keep the distinct already-completed / already-cancelled
    // errors (COMPLETED checked first, as before).
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE", "CANCELLED"],
      () => new RaceCancelError("Cannot cancel a completed race", 400)
    );
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE"],
      () => new RaceCancelError("Race is already cancelled", 400)
    );

    // ACTIVE races are cancellable, so charged rows may be COMMITTED, not just
    // HELD (findChargedByRace returns both) — widen the refundable window.
    const chargedParticipants = await participantModel.findChargedByRace(raceId);
    for (const participant of chargedParticipants) {
      await refundHeldBuyIn({
        participant,
        awardCoinsFn,
        refundableStatuses: ["HELD", "COMMITTED"],
        refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
          refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
        onRefunded: (p) =>
          participantModel.update(p.id, { buyInStatus: "REFUNDED" }),
      });
    }

    const updated = await raceModel.update(raceId, {
      status: "CANCELLED",
      potCoins: 0,
    });

    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const participantUserIds = acceptedParticipants
      .map((p) => p.userId)
      .filter((id) => id !== userId);

    events.emit("RACE_CANCELLED", {
      raceId,
      raceName: race.name,
      creatorUserId: userId,
      participantUserIds,
    });

    return updated;
  };
}

const cancelRace = buildCancelRace();

module.exports = { buildCancelRace, cancelRace, RaceCancelError };
