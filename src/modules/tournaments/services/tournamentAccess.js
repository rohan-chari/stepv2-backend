const { prisma: defaultPrisma } = require("../../../db");

// Read-only spectate gate: is `userId` an ACCEPTED participant of `tournamentId`
// (any bracket player, INCLUDING eliminated — eliminated players stay ACCEPTED
// with eliminatedInRound set, so they can watch the bracket to the end)?
//
// Used ONLY by the matchup-race READ queries (getRaceDetails / getRaceProgress)
// to let a tournament participant view a matchup they aren't in. Never relax any
// write path with this — writes stay participant-only.
async function isTournamentParticipant(tournamentId, userId, { prisma = defaultPrisma } = {}) {
  if (!tournamentId || !userId) return false;
  const row = await prisma.tournamentParticipant.findFirst({
    where: { tournamentId, userId, status: "ACCEPTED" },
    select: { id: true },
  });
  return !!row;
}

module.exports = { isTournamentParticipant };
