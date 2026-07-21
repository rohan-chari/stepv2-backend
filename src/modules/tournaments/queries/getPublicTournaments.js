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
      const featuredRows = await db.tournament.findMany({
        where: { seedId: { in: activeSeedIds }, status: "PENDING" },
        include: summaryInclude,
        orderBy: { createdAt: "desc" },
      });
      const seenSeeds = new Set();
      for (const t of featuredRows) {
        if (seenSeeds.has(t.seedId)) continue; // one open lobby per seed
        seenSeeds.add(t.seedId);
        featured.push(serializeTournamentSummary(t, userId));
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
      tournaments.push(serializeTournamentSummary(t, userId));
    }

    return { featured, tournaments };
  };
}

const getPublicTournaments = buildGetPublicTournaments();

module.exports = { buildGetPublicTournaments, getPublicTournaments };
