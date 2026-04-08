const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const { payoutRaceCoins } = require("../services/raceBuyIns");

function buildCompleteRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function completeRace({ raceId, winnerUserId, participantUserIds }) {
    const result = await raceModel.updateIfActive(raceId, {
      status: "COMPLETED",
      completedAt: now(),
      winnerUserId,
    });

    if (result.count === 0) {
      return null;
    }

    // Expire all remaining active effects and held powerups
    await effectModel.expireAllForRace(raceId);
    await powerupModel.expireAllForRace(raceId);

    const race = await raceModel.findById(raceId);
    if (race?.potCoins > 0) {
      const payouts = computeRacePayouts({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        potCoins: race.potCoins,
      });
      const placements = [1, 2, 3];

      for (let index = 0; index < placements.length; index++) {
        const placement = placements[index];
        const amount = payouts[index] || 0;
        if (amount <= 0) continue;

        const recipient =
          race.participants.find((participant) => participant.placement === placement) ||
          (placement === 1
            ? race.participants.find((participant) => participant.userId === winnerUserId)
            : null);

        if (!recipient) continue;

        await payoutRaceCoins({
          awardCoinsFn,
          userId: recipient.userId,
          raceId,
          placement,
          amount,
        });
        await participantModel.incrementPayoutCoins(recipient.id, amount);
      }
    }

    events.emit("RACE_COMPLETED", {
      raceId,
      winnerUserId,
      participantUserIds,
    });

    return race;
  };
}

const completeRace = buildCompleteRace();

module.exports = { buildCompleteRace, completeRace };
