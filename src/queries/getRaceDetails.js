const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const { characterPresentation } = require("../utils/shopCosmetics");
const { roundLabel } = require("../constants/tournaments");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../constants/raceFinishReward");

async function getRaceDetails(userId, raceId, supportsCharacters = false) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  // Declining revokes access: the decliner is treated like a non-participant
  // instead of getting a read-only ghost view of the race.
  if (!myParticipant || myParticipant.status === "DECLINED") {
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
    acceptedCount,
    finishRewardPool
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
      // {animal, accessories} — naked capy for viewers without `characters`.
      ...characterPresentation(p.user, supportsCharacters),
      status: p.status,
      totalSteps: p.totalSteps,
      finishedAt: p.finishedAt,
      joinedAt: p.joinedAt,
      buyInAmount: p.buyInAmount,
      buyInStatus: p.buyInStatus,
      payoutCoins: p.payoutCoins,
      // Team races (additive; null on individual races). The lobby renders the
      // two-column face-off from `team`; forfeitedAt marks frozen members.
      team: p.team ?? null,
      forfeitedAt: p.forfeitedAt ?? null,
    })),
    createdAt: race.createdAt,
    // ── Team races (TR-101/402; additive — old clients ignore these and never
    // receive a team race in their lists anyway).
    isTeamRace: race.isTeamRace === true,
    teamSize: race.teamSize ?? null,
    teamAName: race.teamAName ?? null,
    teamBName: race.teamBName ?? null,
    winnerTeam: race.winnerTeam ?? null,
    myTeam: myParticipant.team ?? null,
    myForfeitedAt: myParticipant.forfeitedAt ?? null,
    // ── Tournament matchup context (additive; null on ordinary races). The
    // frontend reads these defensively to show the "🏆 {round} — {name}" banner.
    tournamentId: race.tournamentId ?? null,
    tournamentRound: race.tournamentRound ?? null,
    tournamentRoundLabel:
      race.tournamentId && race.tournament
        ? roundLabel(race.tournament.bracketSize, race.tournamentRound)
        : null,
    tournamentName: race.tournament?.name ?? null,
  };
}

module.exports = { getRaceDetails };
