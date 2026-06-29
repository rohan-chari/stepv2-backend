const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const { buildAccessoriesList } = require("../utils/shopCosmetics");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
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

  const acceptedCount = race.participants.filter(
    (p) => p.status === "ACCEPTED"
  ).length;
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
    participantCount: acceptedCount,
  });
  // Projected from the current field; the final pool/places are recomputed from
  // actual finishers at settlement (completeRace).
  const finishRewardPool = computeFinishRewardPool(race.seedId, acceptedCount);
  const finishRewardPlaces = computeFinishRewardPlaces(
    race.seedId,
    acceptedCount
  );

  return {
    id: race.id,
    name: race.name,
    // Seed kind for the auto-generated daily/weekly public challenges (null for
    // user-created races). Additive: older clients ignore the field; newer ones
    // use it to show a clean "Daily/Weekly Challenge" label in the header.
    seedKind: race.seed?.kind || null,
    status: race.status,
    maxDurationDays: race.maxDurationDays,
    targetSteps: race.targetSteps, // 1.1.4 compat
    buyInAmount: race.buyInAmount,
    payoutPreset: race.payoutPreset,
    potCoins: race.potCoins || 0,
    heldPotCoins,
    projectedPotCoins,
    // Legacy three-place shape, kept for app builds that predate payoutTiers.
    // They read first/second/third and only ever show the podium, which degrades
    // gracefully for the field-scaled presets (they just don't see places 4+).
    payouts: {
      first: payouts[0] || 0,
      second: payouts[1] || 0,
      third: payouts[2] || 0,
    },
    // Full payout breakdown, one entry per paid place (placement 1..N). Newer app
    // builds render this; older ones ignore it and fall back to `payouts` above.
    payoutTiers: payouts.map((amount, index) => ({
      placement: index + 1,
      amount,
    })),
    // Minted reward for seeded races (no buy-in). null when the race pays no
    // finish reward. Additive: older clients ignore the field.
    finishReward:
      finishRewardPool > 0
        ? { pool: finishRewardPool, paidPlaces: finishRewardPlaces }
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
    // Per-race placement-alert opt-out. Defaulted false so old app builds that
    // don't read this key are unaffected; the new build renders the mute toggle.
    myPlacementAlertsMuted: myParticipant.placementAlertsMuted || false,
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
