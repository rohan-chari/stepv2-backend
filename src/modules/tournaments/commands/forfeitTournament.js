const {
  prisma: defaultPrisma,
  runInPrismaTransaction: defaultRunInPrismaTransaction,
} = require("../../../db");
const { Tournament } = require("../models/tournament");
const { completeRace: defaultCompleteRace } = require("../../races/commands/completeRace");
const { TournamentError } = require("../services/tournamentErrors");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");
const {
  lockFundedExposureUsers,
} = require("../../races/services/fundedExposure");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("../../races/services/raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");

// Forfeit a live matchup (POST /tournaments/:id/forfeit). Freezes the caller's
// matchup total, immediately completes the matchup in the opponent's favor, and
// runs advancement. Players with no live matchup (eliminated or between rounds)
// get NO_LIVE_MATCHUP. No refunds after start (buy-ins are committed).
function buildForfeitTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const completeRace = dependencies.completeRace || defaultCompleteRace;
  const now = dependencies.now || (() => new Date());
  const runTransaction =
    dependencies.runInPrismaTransaction || defaultRunInPrismaTransaction;
  const usesDefaultPersistence =
    !dependencies.prisma &&
    !dependencies.Tournament &&
    !dependencies.completeRace;

  return async function forfeitTournament({ userId, tournamentId, supportsCharacters, supportsRemoteAssets = false }) {
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

    const forfeitMatchup = async (tx = db) => {
      let lockedMatchup = matchup;
      if (usesDefaultPersistence) {
        await acquireRaceWriteFence(tx, matchup.id);
        await acquireGlobalEnrollmentLock(tx);
        const participantUserIds = matchup.participants
          .map((participant) => participant.userId)
          .sort();
        await lockFundedExposureUsers(tx, participantUserIds);
        await lockCompetitionRows(tx, {
          raceIds: [matchup.id],
          tournamentIds: [tournamentId],
        });
        lockedMatchup = await tx.race.findFirst({
          where: {
            id: matchup.id,
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
        if (!lockedMatchup) {
          throw new TournamentError(
            "You have no live matchup to forfeit",
            409,
            "NO_LIVE_MATCHUP",
          );
        }
      }
      const mine = lockedMatchup.participants.find(
        (participant) => participant.userId === userId,
      );
      const opponent = lockedMatchup.participants.find(
        (participant) => participant.userId !== userId,
      );
      await tx.raceParticipant.update({
        where: { id: mine.id },
        data: { forfeitedAt: now() },
      });
      await completeRace({
        raceId: lockedMatchup.id,
        winnerUserId: opponent ? opponent.userId : null,
        participantUserIds: lockedMatchup.participants.map(
          (participant) => participant.userId,
        ),
      });
    };

    if (usesDefaultPersistence) {
      await runTransaction(forfeitMatchup, { timeout: 30_000, maxWait: 10_000 });
    } else {
      await forfeitMatchup(db);
    }

    const full = await tournamentModel.findById(tournamentId);
    return serializeTournamentPayload(full, userId, {
      supportsCharacters,
      supportsRemoteAssets,
    });
  };
}

const forfeitTournament = buildForfeitTournament();

module.exports = { buildForfeitTournament, forfeitTournament };
