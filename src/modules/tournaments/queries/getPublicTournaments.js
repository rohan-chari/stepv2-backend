const { prisma: defaultPrisma } = require("../../../db");
const { Tournament, summaryInclude } = require("../models/tournament");
const { serializeTournamentSummary } = require("./serializeTournament");

// GET /tournaments/public — { featured: [...], tournaments: [...] }.
//   featured    = each active seed's open PENDING bracket (stays listed even
//                 when joined/full; the card flips JOIN -> VIEW client-side).
//   tournaments = user-created PENDING public brackets with open slots the
//                 viewer isn't in, newest first, capped at 25.
function buildGetPublicTournaments(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;

  return async function getPublicTournaments({ userId }) {
    const activeSeeds = await db.tournamentSeed.findMany({
      where: { active: true },
      select: { id: true },
    });
    const activeSeedIds = activeSeeds.map((s) => s.id);

    const featured = [];
    if (activeSeedIds.length > 0) {
      // Seeds where the viewer is still ALIVE in some bracket. joinTournamentCore
      // rejects a second bracket of the same seed with ALREADY_IN_FEATURED, so
      // those lobbies are listed (the card flips to VIEW) but are NOT joinable —
      // and must not be advertised as an available race to join.
      const aliveRows = await db.tournamentParticipant.findMany({
        where: {
          userId,
          status: "ACCEPTED",
          eliminatedInRound: null,
          tournament: {
            seedId: { in: activeSeedIds },
            status: { in: ["PENDING", "ACTIVE"] },
          },
        },
        select: { tournament: { select: { seedId: true } } },
      });
      const aliveSeedIds = new Set(
        aliveRows.map((r) => r.tournament?.seedId).filter(Boolean)
      );

      const featuredRows = await db.tournament.findMany({
        where: { seedId: { in: activeSeedIds }, status: "PENDING" },
        include: summaryInclude,
        orderBy: { createdAt: "desc" },
      });
      const seenSeeds = new Set();
      for (const t of featuredRows) {
        if (seenSeeds.has(t.seedId)) continue; // one open lobby per seed
        seenSeeds.add(t.seedId);
        const summary = serializeTournamentSummary(t, userId);
        // Additive field (§ discovery). Old clients ignore it; the backend uses
        // it so "PUBLIC RACES (X)" only counts brackets the viewer could join.
        // A DECLINED row is a soft-removed leaver — joinTournamentCore lets
        // them rejoin, so it counts as joinable (matches the user-created
        // branch's "status !== DECLINED is mine" rule below).
        summary.joinable =
          (summary.myStatus === null || summary.myStatus === "DECLINED") &&
          summary.acceptedCount < summary.bracketSize &&
          !aliveSeedIds.has(t.seedId);
        featured.push(summary);
      }
    }

    const userRows = await tournamentModel.findPublicPending();
    const tournaments = [];
    for (const t of userRows) {
      const mine = (t.participants || []).some(
        (p) => p.userId === userId && p.status !== "DECLINED"
      );
      if (mine) continue;
      const acceptedCount = (t.participants || []).filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      if (acceptedCount >= t.bracketSize) continue; // no open slots
      // Already filtered to "not mine, has room, no seed" — always joinable.
      tournaments.push({
        ...serializeTournamentSummary(t, userId),
        joinable: true,
      });
    }

    return { featured, tournaments };
  };
}

const getPublicTournaments = buildGetPublicTournaments();

module.exports = { buildGetPublicTournaments, getPublicTournaments };
