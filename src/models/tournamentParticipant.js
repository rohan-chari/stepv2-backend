const { prisma } = require("../db");

const TournamentParticipant = {
  async findByTournamentAndUser(tournamentId, userId) {
    return prisma.tournamentParticipant.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
  },

  async findByTournament(tournamentId) {
    return prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { joinedAt: "asc" },
    });
  },

  // ACCEPTED participants only (INVITED never occupy a bracket slot — the same
  // ACCEPTED-only counting rule team sides use).
  async findAccepted(tournamentId) {
    return prisma.tournamentParticipant.findMany({
      where: { tournamentId, status: "ACCEPTED" },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { joinedAt: "asc" },
    });
  },

  async countAccepted(tournamentId) {
    return prisma.tournamentParticipant.count({
      where: { tournamentId, status: "ACCEPTED" },
    });
  },

  async create(data) {
    return prisma.tournamentParticipant.create({ data });
  },

  async update(id, data) {
    return prisma.tournamentParticipant.update({ where: { id }, data });
  },
};

module.exports = { TournamentParticipant };
