const { prisma: defaultPrisma } = require("../db");
const { Tournament } = require("../models/tournament");
const { serializeTournamentSummary } = require("./serializeTournament");

const STATUS_ORDER = { ACTIVE: 0, PENDING: 1, COMPLETED: 2 };

// The additive `tournaments` array for GET /races (token clients only). Every
// tournament the viewer is ACCEPTED in (status != CANCELLED) PLUS ones they are
// INVITED to only while still PENDING. Ordered ACTIVE -> PENDING -> COMPLETED,
// newest first within each group, COMPLETED capped at the last 5. Each summary
// carries myCurrentMatchRaceId (the viewer's live matchup, null if none).
function buildGetTournamentsForUser(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;

  return async function getTournamentsForUser(userId) {
    const rows = await tournamentModel.findForUser(userId);
    if (rows.length === 0) return [];

    // Live matchup raceId per ACTIVE tournament for this viewer.
    const activeIds = rows
      .filter((t) => t.status === "ACTIVE")
      .map((t) => t.id);
    const matchByTournament = new Map();
    if (activeIds.length > 0) {
      const matchups = await db.race.findMany({
        where: {
          tournamentId: { in: activeIds },
          status: "ACTIVE",
          participants: { some: { userId, status: "ACCEPTED" } },
        },
        select: { id: true, tournamentId: true },
      });
      for (const m of matchups) matchByTournament.set(m.tournamentId, m.id);
    }

    const summaries = rows.map((t) => {
      const summary = serializeTournamentSummary(t, userId);
      summary.myCurrentMatchRaceId = matchByTournament.get(t.id) || null;
      return summary;
    });

    // Sort: status group, then newest-first within group (startedAt/completedAt
    // fall back to nothing here; findForUser already returns createdAt desc, so
    // a stable sort by status preserves newest-first).
    const byStatus = { ACTIVE: [], PENDING: [], COMPLETED: [] };
    for (const s of summaries) {
      (byStatus[s.status] || (byStatus[s.status] = [])).push(s);
    }
    const completedCapped = (byStatus.COMPLETED || []).slice(0, 5);

    return [
      ...(byStatus.ACTIVE || []),
      ...(byStatus.PENDING || []),
      ...completedCapped,
    ];
  };
}

const getTournamentsForUser = buildGetTournamentsForUser();

module.exports = { buildGetTournamentsForUser, getTournamentsForUser };
