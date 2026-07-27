const { Race } = require("../models/race");
const { characterPresentation } = require("../../cosmetics");
const { roundLabel } = require("../../tournaments/constants/tournaments");
const { isTournamentParticipant } = require("../../tournaments/services/tournamentAccess");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../racePrizePool");

// `releaseChannel` (batch 2026-07-26, item 8) is trailing + optional and
// defaults to "prod", so every existing caller keeps byte-identical behaviour.
async function getRaceDetails(userId, raceId, supportsCharacters = false, releaseChannel = "prod") {
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
    // Tournament spectating: any ACCEPTED bracket player (including eliminated)
    // may READ a matchup race they aren't in. Read-only — no write path is
    // relaxed here. Non-tournament races and non-participants still 403.
    const canSpectate =
      race.tournamentId != null &&
      (await isTournamentParticipant(race.tournamentId, userId));
    if (!canSpectate) {
      const error = new Error("You are not a participant in this race");
      error.statusCode = 403;
      throw error;
    }
  }

  const acceptedCount = race.participants.filter(
    (p) => p.status === "ACCEPTED"
  ).length;
  // Legacy buy-in pot OR app-funded prize pool, decided by race.fundedPrize.
  // Projected from the current field; a funded race's final pool is recomputed
  // from actual finishers at settlement and then stamped (completeRace).
  const money = buildRaceMoneyView({ race, acceptedCount });
  const { payouts: legacyPayouts, payoutTiers } = serializePayouts(money.payouts);

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
    buyInAmount: money.buyInAmount,
    payoutPreset: race.payoutPreset,
    potCoins: money.potCoins,
    heldPotCoins: money.heldPotCoins,
    projectedPotCoins: money.projectedPotCoins,
    // App-funded prize pool (additive). null for a legacy buy-in race, in which
    // case the client renders today's buy-in/pot UI unchanged.
    prizePool: money.prizePool,
    // Legacy three-place shape, kept for app builds that predate payoutTiers.
    // They read first/second/third and only ever show the podium, which degrades
    // gracefully for the field-scaled presets (they just don't see places 4+).
    payouts: legacyPayouts,
    // Full payout breakdown, one entry per paid place (placement 1..N). Newer app
    // builds render this; older ones ignore it and fall back to `payouts` above.
    payoutTiers,
    // Minted reward for seeded races (no buy-in). null when the race pays no
    // finish reward. Additive: older clients ignore the field.
    finishReward: money.finishReward,
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
    // myParticipant is undefined for a tournament spectator (viewer isn't in
    // this matchup) — every "my*" field degrades safely, which is how the client
    // detects read-only spectate mode.
    myStatus: myParticipant?.status ?? null,
    myChatMuted: myParticipant?.chatMuted || false,
    // Per-race placement-alert opt-out. Defaulted false so old app builds that
    // don't read this key are unaffected; the new build renders the mute toggle.
    myPlacementAlertsMuted: myParticipant?.placementAlertsMuted || false,
    myLastReadRaceChatAt: myParticipant?.lastReadRaceChatAt ?? null,
    participants: race.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      profilePhotoUrl: p.user.profilePhotoUrl,
      // {animal, accessories} — naked capy for viewers without `characters`.
      ...characterPresentation(p.user, supportsCharacters, releaseChannel),
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
    myTeam: myParticipant?.team ?? null,
    myForfeitedAt: myParticipant?.forfeitedAt ?? null,
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
