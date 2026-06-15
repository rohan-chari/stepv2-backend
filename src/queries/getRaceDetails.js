const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const { buildAccessoriesList } = require("../utils/shopCosmetics");
const {
  getFinishRewardPool,
  FINISH_REWARD_TOP_FRACTION,
} = require("../constants/raceFinishReward");

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
  const finishRewardPool = getFinishRewardPool(race.seedId);

  return {
    id: race.id,
    name: race.name,
    status: race.status,
    maxDurationDays: race.maxDurationDays,
    targetSteps: race.targetSteps, // 1.1.4 compat
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
    // Minted reward for seeded races (no buy-in). null when the race pays no
    // finish reward. Additive: older clients ignore the field.
    finishReward:
      finishRewardPool > 0
        ? { pool: finishRewardPool, topFraction: FINISH_REWARD_TOP_FRACTION }
        : null,
    startedAt: race.startedAt,
    endsAt: race.endsAt,
    completedAt: race.completedAt,
    creator: race.creator,
    winner: race.winner,
    isCreator: race.creatorId === userId,
    isPublic: race.isPublic || false,
    // null => unlimited (no cap). Older app clients read this defensively
    // (int? ?? 10) so they show a finite figure but never crash.
    maxParticipants: race.maxParticipants ?? null,
    powerupsEnabled: race.powerupsEnabled || false,
    powerupStepInterval: race.powerupStepInterval,
    myStatus: myParticipant.status,
    myChatMuted: myParticipant.chatMuted || false,
    myLastReadRaceChatAt: myParticipant.lastReadRaceChatAt,
    participants: race.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      profilePhotoUrl: p.user.profilePhotoUrl,
      accessories: buildAccessoriesList(p.user),
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
