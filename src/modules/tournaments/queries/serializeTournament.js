const { characterPresentation } = require("../../cosmetics");
const {
  roundLabel,
  totalRoundsFor,
  clampMatchupDuration,
} = require("../constants/tournaments");
const {
  computePrizePool,
  buildPrizePoolPayload,
} = require("../../../shared/economy/prizePool");
const {
  collectRaceIllusions,
  isStealthedForViewer,
} = require("../../races/services/raceIllusions");
const { buildPayoutPlan } = require("../../races/services/payoutRounding");
const {
  resolveTournamentPrizeStamp,
} = require("../../races/services/fundedExposure");

// Total bracket length in days — the duration band a funded bracket pool is
// sized on (D9): every round is played back-to-back.
function tournamentDurationDays(t) {
  const rounds = t.totalRounds ?? totalRoundsFor(t.bracketSize);
  return rounds * clampMatchupDuration(t.matchupDurationDays || 0);
}

// Legacy buy-in pot OR app-funded bracket pool, discriminated by fundedPrize.
// Funded brackets report buyInAmount 0 (a frozen build then charges nothing) and
// carry the pool in potCoins as well, so `lib/utils/tournament.dart` keeps
// rendering a correct figure on an un-updated binary.
function tournamentMoneyView(t, acceptedCount) {
  const award = (rawAwardCoins) => buildPayoutPlan({
    payoutRoundingVersion: t.payoutRoundingVersion,
    awards: [{ recipientId: "champion", placement: 1, rawAwardCoins }],
  }).totals.awardCoins;
  if (t.fundedPrize !== true) {
    return {
      prizePool: null,
      buyInAmount: t.buyInAmount,
      potCoins: award(t.potCoins || 0),
    };
  }
  const completed = t.status === "COMPLETED";
  const prizeStamp = resolveTournamentPrizeStamp(t);
  const playerCount =
    acceptedCount != null
      ? acceptedCount
      : (t.participants || []).filter((p) => p.status === "ACCEPTED").length;
  const durationDays = tournamentDurationDays(t);
  const rawCoins = completed
    ? t.prizePoolCoins || 0
    : computePrizePool({
        playerCount,
        durationDays,
        max: prizeStamp.tournamentChampionMaxCoins,
        unit: prizeStamp.prizeCoinUnit,
      });
  const coins = award(rawCoins);
  return {
    prizePool: buildPrizePoolPayload({
      funded: true,
      playerCount,
      durationDays,
      projected: !completed,
      coins,
      max: prizeStamp.tournamentChampionMaxCoins,
      unit: prizeStamp.prizeCoinUnit,
    }),
    buyInAmount: 0,
    potCoins: coins,
  };
}

// Summary fields shared by the create/mutation responses, the GET /races
// tournaments bucket, and the public listing. Excludes participants/rounds.
function summaryFields(t, acceptedCount = null) {
  const money = tournamentMoneyView(t, acceptedCount);
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    bracketSize: t.bracketSize,
    matchupDurationDays: t.matchupDurationDays,
    buyInAmount: money.buyInAmount,
    potCoins: money.potCoins,
    // App-funded bracket pool (additive); null for a legacy paid bracket.
    prizePool: money.prizePool,
    powerupsEnabled: t.powerupsEnabled === true,
    powerupStepInterval: t.powerupStepInterval ?? null,
    isPublic: t.isPublic === true,
    shareToken: t.shareToken ?? null,
    currentRound: t.currentRound || 0,
    totalRounds: t.totalRounds ?? totalRoundsFor(t.bracketSize),
    creatorId: t.creatorId ?? null,
    seedId: t.seedId ?? null,
    seedKind: t.seed ? t.seed.kind : null,
    // A featured lobby quotes its prize at mint. Pre-snapshot rows remain
    // readable through the seed fallback during the mixed-version rollout.
    championPrizeCoins: t.seedId
      ? buildPayoutPlan({
          payoutRoundingVersion: t.payoutRoundingVersion,
          awards: [{
            recipientId: "champion",
            placement: 1,
            rawAwardCoins: t.championPrizeCoinsSnapshot ?? t.seed?.championPrizeCoins ?? 0,
          }],
        }).totals.awardCoins
      : null,
    championUserId: t.championUserId ?? null,
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
  };
}

function serializeParticipant(
  p,
  supportsCharacters,
  supportsRemoteAssets = false
) {
  return {
    userId: p.userId,
    displayName: p.user?.displayName ?? null,
    status: p.status,
    seed: p.seed ?? null,
    eliminatedInRound: p.eliminatedInRound ?? null,
    avatar: p.user?.profilePhotoUrl ?? null,
    ...characterPresentation(
      p.user,
      supportsCharacters,
      "prod",
      supportsRemoteAssets
    ),
  };
}

// Build the rounds/bracket. Real matchups come from tournament.races grouped by
// tournamentRound; future rounds are drawn as placeholders so the client can
// render the whole skeleton. Non-COMPLETED matchups apply the same viewer
// illusions (Stealth/Detour) as the race room so the bracket isn't a
// stealth-defeating side channel (§6.4/D5).
function buildRounds(t, viewerUserId, nowMs) {
  const totalRounds = t.totalRounds ?? totalRoundsFor(t.bracketSize);
  const racesByRound = new Map();
  for (const race of t.races || []) {
    const r = race.tournamentRound;
    if (!racesByRound.has(r)) racesByRound.set(r, []);
    racesByRound.get(r).push(race);
  }

  const rounds = [];
  for (let round = 1; round <= totalRounds; round++) {
    const matchCount = Math.pow(2, totalRounds - round);
    const racesForRound = (racesByRound.get(round) || []).sort(
      (a, b) => (a.tournamentMatchIndex || 0) - (b.tournamentMatchIndex || 0)
    );

    const matchups = [];
    for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
      const race = racesForRound.find(
        (r) => r.tournamentMatchIndex === matchIndex
      );
      if (!race) {
        matchups.push({
          matchIndex,
          raceId: null,
          status: null,
          endsAt: null,
          players: [],
          winnerUserId: null,
          tie: false,
        });
        continue;
      }

      const completed = race.status === "COMPLETED";
      const accepted = (race.participants || []).filter(
        (p) => p.status === "ACCEPTED"
      );

      // Illusions apply only to a live (non-COMPLETED) matchup; finals are true.
      let illusions = { stealthedUserIds: new Set(), viewerIsDetoured: false };
      if (!completed && race.powerupsEnabled) {
        illusions = collectRaceIllusions(
          race.activeEffects || [],
          viewerUserId,
          nowMs
        );
      }

      const players = accepted.map((p) => {
        const masked =
          !completed &&
          (illusions.viewerIsDetoured ||
            isStealthedForViewer(p.userId, {
              stealthedUserIds: illusions.stealthedUserIds,
              viewerUserId,
              finished: p.finishedAt != null,
            }));
        return {
          userId: p.userId,
          totalSteps: masked ? null : Math.max(0, Number(p.totalSteps) || 0),
          forfeited: p.forfeitedAt != null,
          // Item 11: emit the masked flag (parallel to the race leaderboard's
          // `stealthed`) so the bracket renders "???" instead of a blank/0 for a
          // detoured/stealthed player. Additive — old clients ignore it, and a
          // new client can also infer masking from totalSteps === null.
          stealthed: masked,
        };
      });

      // `tie` is derived at read time: a COMPLETED matchup whose two finalized
      // totals are equal (both non-forfeited).
      let tie = false;
      if (completed && accepted.length === 2) {
        tie =
          !accepted[0].forfeitedAt &&
          !accepted[1].forfeitedAt &&
          (accepted[0].totalSteps || 0) === (accepted[1].totalSteps || 0);
      }

      matchups.push({
        matchIndex,
        raceId: race.id,
        status: race.status,
        endsAt: race.endsAt ?? null,
        players,
        winnerUserId: race.winnerUserId ?? null,
        tie,
      });
    }

    rounds.push({
      round,
      label: roundLabel(t.bracketSize, round),
      matchups,
    });
  }

  return rounds;
}

// Full GET /tournaments/:id payload (§6.4).
function serializeTournamentPayload(
  t,
  viewerUserId,
  {
    supportsCharacters = false,
    supportsRemoteAssets = false,
    now = () => new Date(),
  } = {}
) {
  const participants = (t.participants || []).map((p) =>
    serializeParticipant(p, supportsCharacters, supportsRemoteAssets)
  );
  const myParticipant = (t.participants || []).find(
    (p) => p.userId === viewerUserId
  );
  const acceptedCount = (t.participants || []).filter(
    (p) => p.status === "ACCEPTED"
  ).length;

  return {
    ...summaryFields(t, acceptedCount),
    acceptedCount,
    myStatus: myParticipant?.status ?? null,
    participants,
    rounds: buildRounds(t, viewerUserId, now().getTime()),
  };
}

// Summary object for listings (§6.3). Adds the viewer-relative fields.
function serializeTournamentSummary(t, viewerUserId) {
  const myParticipant = (t.participants || []).find(
    (p) => p.userId === viewerUserId
  );
  const acceptedCount = (t.participants || []).filter(
    (p) => p.status === "ACCEPTED"
  ).length;
  return {
    ...summaryFields(t, acceptedCount),
    myStatus: myParticipant?.status ?? null,
    myEliminatedInRound: myParticipant?.eliminatedInRound ?? null,
    acceptedCount,
    // myCurrentMatchRaceId is filled by the caller when it has the matchup races.
    myCurrentMatchRaceId: null,
  };
}

module.exports = {
  summaryFields,
  tournamentDurationDays,
  serializeTournamentPayload,
  serializeTournamentSummary,
  serializeParticipant,
  buildRounds,
};
