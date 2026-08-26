const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { runTournamentStart } = require("../services/tournamentStart");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");

// Creator manual start (POST /tournaments/:id/start). Allowed only when the
// bracket is exactly full. Seeds, commits the pot, and creates round 1 under the
// tournament lock via the shared runTournamentStart. (Featured tournaments have
// creatorId null, so this endpoint never applies to them.)
function buildStartTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const compatibilityEvents = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const rng = dependencies.rng;
  const stepsModel = dependencies.Steps;

  return async function startTournament({ userId, tournamentId, supportsCharacters, supportsRemoteAssets = false }) {
    const { deferred } = await withTournamentLock(
      tournamentId,
      async (tx, def, tournament) => {
        if (!tournament) {
          throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }
        if (tournament.creatorId !== userId) {
          throw new TournamentError("Only the creator can start", 403, "NOT_CREATOR");
        }
        if (tournament.status !== "PENDING") {
          throw new TournamentError(
            "This tournament has already started",
            409,
            "TOURNAMENT_NOT_PENDING"
          );
        }
        const acceptedCount = await tx.tournamentParticipant.count({
          where: { tournamentId, status: "ACCEPTED" },
        });
        if (acceptedCount !== tournament.bracketSize) {
          const need = tournament.bracketSize - acceptedCount;
          throw new TournamentError(
            `Need ${need} more racer${need === 1 ? "" : "s"}`,
            409,
            "BRACKET_NOT_FULL"
          );
        }
        const startEvents = await runTournamentStart({
          tx,
          tournament,
          now,
          rng,
          stepsModel,
        });
        if (startEvents) def.push(...startEvents);
      },
      {
        prisma: db,
        resolveUserIds: async (tx) => {
          const participants = await tx.tournamentParticipant.findMany({
            where: { tournamentId, status: "ACCEPTED" },
            select: { userId: true },
          });
          return participants.map((row) => row.userId);
        },
      }
    );

    for (const payload of deferred) {
      compatibilityEvents?.emit(payload.type, payload);
    }
    const full = await tournamentModel.findById(tournamentId);
    return serializeTournamentPayload(full, userId, {
      supportsCharacters,
      supportsRemoteAssets,
    });
  };
}

const startTournament = buildStartTournament();

module.exports = { buildStartTournament, startTournament };
