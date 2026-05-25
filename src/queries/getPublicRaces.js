const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");

function buildGetPublicRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;

  return async function getPublicRaces({ userId }) {
    const races = await raceModel.findPublicPending();

    const results = [];
    for (const race of races) {
      const participants = race.participants || [];
      const userInRace = participants.some((p) => p.userId === userId);
      if (userInRace) continue;

      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      const maxParticipants = race.maxParticipants || 10;
      if (acceptedCount >= maxParticipants) continue;

      const heldPotCoins = participants.reduce((sum, p) => {
        if (p.buyInStatus === "HELD") {
          return sum + (p.buyInAmount || 0);
        }
        return sum;
      }, 0);
      const projectedPotCoins = (race.potCoins || 0) + heldPotCoins;
      const payouts = computeRacePayouts({
        preset: race.payoutPreset,
        potCoins: projectedPotCoins,
      });

      results.push({
        id: race.id,
        name: race.name,
        status: race.status,
        maxDurationDays: race.maxDurationDays,
        buyInAmount: race.buyInAmount,
        payoutPreset: race.payoutPreset,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        maxParticipants,
        participantCount: acceptedCount,
        projectedPotCoins,
        payouts: {
          first: payouts[0],
          second: payouts[1],
          third: payouts[2],
        },
        creator: race.creator,
        createdAt: race.createdAt,
      });
    }
    return results;
  };
}

const getPublicRaces = buildGetPublicRaces();

module.exports = { buildGetPublicRaces, getPublicRaces };
