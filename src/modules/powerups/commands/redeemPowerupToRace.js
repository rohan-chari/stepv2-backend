const { Race } = require("../../races/models/race");
const { RacePowerup } = require("../models/racePowerup");
const { UserPowerupItem } = require("../models/userPowerupItem");
const { POWERUP_NAMES } = require("./rollPowerup");

class RedeemPowerupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "RedeemPowerupError";
    this.statusCode = statusCode;
  }
}

// Redeem step: spend ONE powerup from the user's GLOBAL inventory into an ACTIVE
// race they're in, creating a HELD RacePowerup so it shows up in the normal
// in-race tray. The normal usePowerup flow then applies it (target picker etc.).
//
// The inventory decrement is atomic+conditional (decrementIfAvailable returns
// count 0 if the user owns 0), so we never mint a RacePowerup the user didn't
// pay for. We validate race/participant BEFORE spending so a closed race or a
// non-participant never burns inventory.
function buildRedeemPowerupToRace(deps = {}) {
  const raceModel = deps.Race || Race;
  const powerupModel = deps.RacePowerup || RacePowerup;
  const userPowerupItemModel = deps.UserPowerupItem || UserPowerupItem;

  return async function redeemPowerupToRace({ userId, raceId, powerupType }) {
    if (!powerupType || typeof powerupType !== "string") {
      throw new RedeemPowerupError("powerupType is required", 400);
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new RedeemPowerupError("Race is not active", 400);
    }

    const myParticipant = (race.participants || []).find(
      (p) => p.userId === userId && p.status === "ACCEPTED"
    );
    if (!myParticipant) {
      throw new RedeemPowerupError("You are not an active participant", 403);
    }

    // Atomic conditional decrement: only succeeds if the user owns >= 1.
    const decremented = await userPowerupItemModel.decrementIfAvailable(
      userId,
      powerupType
    );
    if (!decremented || decremented.count === 0) {
      const name = POWERUP_NAMES[powerupType] || powerupType;
      throw new RedeemPowerupError(`You don't own any ${name}`, 400);
    }

    const powerup = await powerupModel.create({
      raceId,
      participantId: myParticipant.id,
      userId,
      type: powerupType,
      rarity: null,
      status: "HELD",
      // Redeemed powerups are not milestone-bound; leave earnedAtSteps null so
      // they don't collide with the (participant, earnedAtSteps) unique index.
      earnedAtSteps: null,
    });

    return { powerup };
  };
}

const redeemPowerupToRace = buildRedeemPowerupToRace();

module.exports = {
  buildRedeemPowerupToRace,
  redeemPowerupToRace,
  RedeemPowerupError,
};
