const { prisma } = require("../../../db");
const { RacePowerup } = require("../models/racePowerup");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../../../shared/events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");
const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");
const {
  computeDiscardAward: defaultComputeDiscardAward,
  DISCARD_REASON,
} = require("../services/discardRewards");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");

class PowerupDiscardError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "PowerupDiscardError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildDiscardPowerup(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;
  const awardCoins = dependencies.awardCoins || defaultAwardCoins;
  const computeDiscardAward =
    dependencies.computeDiscardAward || defaultComputeDiscardAward;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;

  // Discarding a HELD in-race powerup pays coins by rarity, capped per user per
  // LOCAL day (batch 2026-08-08 item 1). An UNOPENED MYSTERY_BOX stays
  // discardable but pays 0.
  //
  // `timezone` is the user's stored zone, used only for the cap's day boundary;
  // it is optional and falls back to ET inside the reward service.
  return async function discardPowerup({
    userId,
    raceId,
    powerupId,
    displayName,
    timezone = null,
  }) {
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new PowerupDiscardError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new PowerupDiscardError("This powerup does not belong to you", 403);
    }
    if (!["HELD", "MYSTERY_BOX"].includes(powerup.status)) {
      throw new PowerupDiscardError("This powerup cannot be discarded", 400);
    }

    // CONDITIONAL claim, not a plain update. The status read above is a TOCTOU:
    // two concurrent taps both pass it. Only the caller that actually flips a
    // still-discardable row proceeds to pay coins and write the feed event.
    const claimed = await powerupModel.claimForDiscard(powerupId);
    if (!claimed || claimed.count !== 1) {
      throw new PowerupDiscardError("This powerup cannot be discarded", 400);
    }

    const isMysteryBox = powerup.status === "MYSTERY_BOX";

    const { coinsAwarded, capRemaining } = await computeDiscardAward({
      userId,
      status: powerup.status,
      rarity: powerup.rarity,
      timezone,
    });

    // Defense in depth behind the CAS: reason + refId make the mint idempotent
    // at the DATABASE level via coin_transactions' @@unique([userId, reason,
    // refId]), so even if the claim above were ever bypassed the coins can only
    // be minted once for this powerup.
    let coins = null;
    // What the LEDGER actually paid. `awardCoins` returns awarded:false when the
    // unique (userId, reason, refId) triple already exists, i.e. this powerup was
    // already paid for — in that case the correct answer on the wire is 0, not
    // the price we would have paid. Reporting the intended price there would let
    // a retry show the user coins they never received.
    let paidCoins = 0;
    if (coinsAwarded > 0) {
      const result = await awardCoins({
        userId,
        amount: coinsAwarded,
        reason: DISCARD_REASON,
        refId: powerupId,
      });
      paidCoins = result?.awarded ? coinsAwarded : 0;
      coins = result?.coins ?? null;
    }
    if (coins == null) {
      // No mint happened (box, or cap exhausted) — still report the live
      // balance so the client can reconcile its badge from one response.
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      coins = user?.coins ?? 0;
    }

    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "POWERUP_DISCARDED",
      powerupType: isMysteryBox ? null : powerup.type,
      description: isMysteryBox
        ? `${displayName || "A runner"} discarded a mystery box.`
        : `${displayName || "A runner"} discarded a ${POWERUP_NAMES[powerup.type]}.`,
    });

    events.emit("POWERUP_DISCARDED", {
      raceId,
      userId,
      type: powerup.type,
    });

    await syncRacePowerupState({ raceId, userId });

    // `success` is the PRE-EXISTING wire field and is deliberately kept: the
    // shipped App Store build ignores the body, but nothing is gained by
    // renaming it and a removed field is the one thing an old client can trip
    // on. `ok` plus the three coin fields are purely ADDITIVE (spec item 1).
    return {
      success: true,
      ok: true,
      coinsAwarded: paidCoins,
      coins,
      capRemaining,
    };
  };
}

const discardPowerup = buildDiscardPowerup();

module.exports = { buildDiscardPowerup, discardPowerup, PowerupDiscardError };
