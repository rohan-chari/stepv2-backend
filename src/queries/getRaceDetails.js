const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");

async function getRaceDetails(userId, raceId) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    const error = new Error("You are not a participant in this race");
    error.statusCode = 403;
    throw error;
  }

  const heldPotCoins = race.participants.reduce((sum, participant) => {
    if (participant.buyInStatus === "HELD") {
      return sum + (participant.buyInAmount || 0);
    }
    return sum;
  }, 0);
  const projectedPotCoins = (race.potCoins || 0) + heldPotCoins;
  const payouts = computeRacePayouts({
    preset: race.payoutPreset,
    potCoins: projectedPotCoins,
  });

  return {
    id: race.id,
    name: race.name,
    targetSteps: race.targetSteps,
    status: race.status,
    maxDurationDays: race.maxDurationDays,
    buyInAmount: race.buyInAmount,
    payoutPreset: race.payoutPreset,
    potCoins: race.potCoins || 0,
    heldPotCoins,
    projectedPotCoins,
    payouts: {
      first: payouts[0],
      second: payouts[1],
      third: payouts[2],
    },
    startedAt: race.startedAt,
    endsAt: race.endsAt,
    completedAt: race.completedAt,
    creator: race.creator,
    winner: race.winner,
    isCreator: race.creatorId === userId,
    myStatus: myParticipant.status,
    participants: race.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      profilePhotoUrl: p.user.profilePhotoUrl,
      status: p.status,
      totalSteps: p.totalSteps,
      finishedAt: p.finishedAt,
      joinedAt: p.joinedAt,
      buyInAmount: p.buyInAmount,
      buyInStatus: p.buyInStatus,
      payoutCoins: p.payoutCoins,
    })),
    createdAt: race.createdAt,
  };
}

module.exports = { getRaceDetails };
