const { characterPresentation } = require("../../cosmetics");
const { roundLabel, totalRoundsFor } = require("../constants/tournaments");
const {
  collectRaceIllusions,
  isStealthedForViewer,
} = require("../../races/services/raceIllusions");

// Summary fields shared by the create/mutation responses, the GET /races
// tournaments bucket, and the public listing. Excludes participants/rounds.
function summaryFields(t) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    bracketSize: t.bracketSize,
    matchupDurationDays: t.matchupDurationDays,
    buyInAmount: t.buyInAmount,
    potCoins: t.potCoins || 0,
    powerupsEnabled: t.powerupsEnabled === true,
    powerupStepInterval: t.powerupStepInterval ?? null,
    isPublic: t.isPublic === true,
    shareToken: t.shareToken ?? null,
    currentRound: t.currentRound || 0,
    totalRounds: t.totalRounds ?? totalRoundsFor(t.bracketSize),
    creatorId: t.creatorId ?? null,
    seedId: t.seedId ?? null,
    seedKind: t.seed ? t.seed.kind : null,
    championPrizeCoins: t.seed ? t.seed.championPrizeCoins ?? null : null,
    championUserId: t.championUserId ?? null,
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
  };
}

function serializeParticipant(p, supportsCharacters) {
  return {
    userId: p.userId,
    displayName: p.user?.displayName ?? null,
    status: p.status,
    seed: p.seed ?? null,
    eliminatedInRound: p.eliminatedInRound ?? null,
    avatar: p.user?.profilePhotoUrl ?? null,
    ...characterPresentation(p.user, supportsCharacters),
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
          totalSteps: masked ? null : p.totalSteps || 0,
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
  { supportsCharacters = false, now = () => new Date() } = {}
) {
  const participants = (t.participants || []).map((p) =>
    serializeParticipant(p, supportsCharacters)
  );
  const myParticipant = (t.participants || []).find(
    (p) => p.userId === viewerUserId
  );
  const acceptedCount = (t.participants || []).filter(
    (p) => p.status === "ACCEPTED"
  ).length;

  return {
    ...summaryFields(t),
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
    ...summaryFields(t),
    myStatus: myParticipant?.status ?? null,
    myEliminatedInRound: myParticipant?.eliminatedInRound ?? null,
    acceptedCount,
    // myCurrentMatchRaceId is filled by the caller when it has the matchup races.
    myCurrentMatchRaceId: null,
  };
}

module.exports = {
  summaryFields,
  serializeTournamentPayload,
  serializeTournamentSummary,
  serializeParticipant,
  buildRounds,
};
