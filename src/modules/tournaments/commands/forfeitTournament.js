const { prisma: defaultPrisma } = require("../../../db");
const { Tournament } = require("../models/tournament");
const { completeRace: defaultCompleteRace } = require("../../races/commands/completeRace");
const { TournamentError } = require("../services/tournamentErrors");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");

// Forfeit a live matchup (POST /tournaments/:id/forfeit). Freezes the caller's
// matchup total, immediately completes the matchup in the opponent's favor, and
// runs advancement. Players with no live matchup (eliminated or between rounds)
// get NO_LIVE_MATCHUP. No refunds after start (buy-ins are committed).
function buildForfeitTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const completeRace = dependencies.completeRace || defaultCompleteRace;
  const now = dependencies.now || (() => new Date());

  return async function forfeitTournament({ userId, tournamentId, supportsCharacters }) {
    const tournament = await tournamentModel.findSummaryById(tournamentId);
    if (!tournament) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }

    // The caller's live matchup: an ACTIVE matchup race in this tournament where
    // they are an ACCEPTED, non-finished, non-forfeited participant.
    const matchup = await db.race.findFirst({
      where: {
        tournamentId,
        status: "ACTIVE",
        participants: {
          some: {
            userId,
            status: "ACCEPTED",
            forfeitedAt: null,
            finishedAt: null,
          },
        },
      },
      include: { participants: { where: { status: "ACCEPTED" } } },
    });

    if (!matchup) {
      throw new TournamentError(
        "You have no live matchup to forfeit",
        409,
        "NO_LIVE_MATCHUP"
      );
    }

    const mine = matchup.participants.find((p) => p.userId === userId);
    const opponent = matchup.participants.find((p) => p.userId !== userId);

    // Freeze the forfeiter's total as-is (the opponent wins on the forfeit rule).
    await db.raceParticipant.update({
      where: { id: mine.id },
      data: { forfeitedAt: now() },
    });

    // Complete the matchup — the completeRace tournament branch honors the
    // forfeit (opponent wins), stamps the loser's elimination, and advances.
    await completeRace({
      raceId: matchup.id,
      winnerUserId: opponent ? opponent.userId : null,
      participantUserIds: matchup.participants.map((p) => p.userId),
    });

    const full = await tournamentModel.findById(tournamentId);
    return serializeTournamentPayload(full, userId, { supportsCharacters });
  };
}

const forfeitTournament = buildForfeitTournament();

module.exports = { buildForfeitTournament, forfeitTournament };
