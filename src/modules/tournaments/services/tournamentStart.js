const { createRoundRaces } = require("./tournamentRounds");
const { roundLabel } = require("../constants/tournaments");

// Fisher-Yates shuffle (seeded RNG injectable for deterministic tests).
function shuffle(array, rng = Math.random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Start a full PENDING tournament INSIDE the caller's transaction + tournament
// lock. Shared by the creator-start endpoint and the pop-when-full fill-join, so
// both paths seed, commit the pot, and create round 1 identically.
//
// Idempotent: the conditional PENDING->ACTIVE claim means only the caller that
// flips the row proceeds; a loser returns null (no double start / double push).
// Returns the TOURNAMENT_STARTED event payloads to emit after commit, or null.
async function runTournamentStart({ tx, tournament, now = () => new Date(), rng, stepsModel }) {
  const tournamentId = tournament.id;

  // Conditional flip claims the PENDING -> ACTIVE transition.
  const flip = await tx.tournament.updateMany({
    where: { id: tournamentId, status: "PENDING" },
    data: { status: "ACTIVE", startedAt: now(), currentRound: 1 },
  });
  if (flip.count === 0) return null;

  const accepted = await tx.tournamentParticipant.findMany({
    where: { tournamentId, status: "ACCEPTED" },
    include: { user: { select: { id: true, displayName: true } } },
    orderBy: { joinedAt: "asc" },
  });

  // Commit the pot: HELD buy-ins -> COMMITTED; potCoins = size * buyIn. An
  // app-funded bracket commits NO pot — nobody was charged, and its prize is
  // minted at advancement instead.
  const buyIn =
    tournament.fundedPrize === true ? 0 : tournament.buyInAmount || 0;
  if (buyIn > 0) {
    for (const p of accepted) {
      if (p.buyInStatus === "HELD") {
        await tx.tournamentParticipant.update({
          where: { id: p.id },
          data: { buyInStatus: "COMMITTED" },
        });
      }
    }
    await tx.tournament.update({
      where: { id: tournamentId },
      data: { potCoins: tournament.bracketSize * buyIn },
    });
  }

  // Random seeding: shuffle accepted -> assign seed 0..N-1.
  const shuffled = shuffle(accepted, rng);
  const seededUserIds = [];
  for (let seed = 0; seed < shuffled.length; seed++) {
    await tx.tournamentParticipant.update({
      where: { id: shuffled[seed].id },
      data: { seed },
    });
    seededUserIds.push(shuffled[seed].userId);
  }

  // Round-1 matchups: match i pairs seeds 2i and 2i+1.
  const matchups = [];
  for (let i = 0; i < seededUserIds.length / 2; i++) {
    matchups.push([seededUserIds[2 * i], seededUserIds[2 * i + 1]]);
  }

  const startedAt = now();
  const created = await createRoundRaces({
    tx,
    tournament,
    round: 1,
    matchups,
    startedAt,
    stepsModel,
  });

  // Name lookup for the per-player start push.
  const nameByUser = new Map(
    accepted.map((p) => [p.userId, p.user?.displayName || "your opponent"])
  );
  const label = roundLabel(tournament.bracketSize, 1);

  const deferred = [];
  for (const c of created) {
    const [a, b] = c.userIds;
    deferred.push({
      type: "TOURNAMENT_STARTED",
      tournamentId,
      roundId: `${tournamentId}:round:1`,
      tournamentName: tournament.name,
      userId: a,
      raceId: c.raceId,
      opponentName: nameByUser.get(b) || "your opponent",
      label,
      days: tournament.matchupDurationDays,
    });
    deferred.push({
      type: "TOURNAMENT_STARTED",
      tournamentId,
      roundId: `${tournamentId}:round:1`,
      tournamentName: tournament.name,
      userId: b,
      raceId: c.raceId,
      opponentName: nameByUser.get(a) || "your opponent",
      label,
      days: tournament.matchupDurationDays,
    });
  }
  return deferred;
}

module.exports = { runTournamentStart, shuffle };
