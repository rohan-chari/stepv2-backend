const { prisma } = require("../db");

const TournamentSeed = {
  async findActive() {
    return prisma.tournamentSeed.findMany({ where: { active: true } });
  },

  async findByKind(kind) {
    return prisma.tournamentSeed.findUnique({ where: { kind } });
  },
};

module.exports = { TournamentSeed };
