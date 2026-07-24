const { Race } = require("../../races/models/race");
const { RacePowerup } = require("../models/racePowerup");
const { UserPowerupItem } = require("../models/userPowerupItem");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { POWERUP_NAMES } = require("./rollPowerup");

class RedeemPowerupError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = "RedeemPowerupError";
    this.statusCode = statusCode;
    if (code) this.code = code;
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
  const effectModel = deps.RaceActiveEffect || RaceActiveEffect;

  return async function redeemPowerupToRace({ userId, raceId, powerupType }) {
    if (!powerupType || typeof powerupType !== "string") {
      throw new RedeemPowerupError("powerupType is required", 400);
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new RedeemPowerupError("Race is not active", 400);
    }

    // §3.7 hard gate: NO powerup — including a shop-redeemed one — may enter a
    // race whose creator disabled powerups. Rejected BEFORE any inventory
    // decrement, so nothing the buyer owns is spent.
    if (race.powerupsEnabled === false) {
      throw new RedeemPowerupError(
        "Powerups are disabled in this race.",
        400,
        "POWERUPS_DISABLED"
      );
    }

    const myParticipant = (race.participants || []).find(
      (p) => p.userId === userId && p.status === "ACCEPTED"
    );
    if (!myParticipant) {
      throw new RedeemPowerupError("You are not an active participant", 403);
    }

    // B3 pre-flight: run the same cheap doom pre-checks the subsequent use would
    // run, BEFORE spending global inventory. There is no un-redeem path, so a
    // use that's guaranteed to be rejected must fail here instead of stranding a
    // HELD race-scoped powerup the buyer can't use anywhere. TOCTOU-imperfect (a
    // storm/jam could start between redeem and use) but shrinks the stranding
    // window from "always" to a race-condition sliver.

    // (1) Caster jammed — mirrors the usePowerup jam guard's copy/status.
    const activeJam = await effectModel.findActiveByTypeForParticipant(
      myParticipant.id,
      "SIGNAL_JAMMER"
    );
    if (activeJam && activeJam.expiresAt && new Date(activeJam.expiresAt) > new Date()) {
      const remainingMs = new Date(activeJam.expiresAt).getTime() - Date.now();
      const remainingMin = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
      throw new RedeemPowerupError(
        `Your powerups are jammed for another ${remainingMin}m!`,
        409,
        "SIGNAL_JAMMED"
      );
    }

    // (2) Rainstorm-specific pre-checks — mirror usePowerup, using the SAME
    //     per-caster rule as B4 (only the redeeming user's own active storm
    //     blocks them; other players' storms do not).
    if (powerupType === "RAINSTORM") {
      const raceEffects = await effectModel.findActiveForRace(raceId);
      const ownStorm = raceEffects.find(
        (e) => e.type === "RAINSTORM" && e.sourceUserId === userId
      );
      if (ownStorm) {
        throw new RedeemPowerupError(
          "Your Rainstorm is already active in this race",
          409,
          "RAINSTORM_ACTIVE"
        );
      }
      const isTeamRace = race.isTeamRace === true;
      const isEnemy = (p) =>
        !isTeamRace || (p.team != null && p.team !== myParticipant.team);
      const isAliveTarget = (p) => !p.finishedAt && !p.forfeitedAt;
      const otherRunners = (race.participants || []).filter(
        (p) =>
          p.status === "ACCEPTED" &&
          p.userId !== userId &&
          isAliveTarget(p) &&
          isEnemy(p)
      );
      if (otherRunners.length === 0) {
        throw new RedeemPowerupError(
          "No other active runners to rain on",
          400,
          "NO_ELIGIBLE_TARGETS"
        );
      }
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
