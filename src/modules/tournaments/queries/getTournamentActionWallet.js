const { prisma: defaultPrisma } = require("../../../db");

function buildGetTournamentActionWallet(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  return async function getTournamentActionWallet(userId) {
    const [user, held] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      }),
      prisma.raceParticipant.aggregate({
        where: { userId, buyInStatus: "HELD" },
        _sum: { buyInAmount: true },
      }),
    ]);
    if (!user) throw new Error("User not found after tournament action");
    return {
      coins: user.coins ?? 0,
      heldCoins: held._sum.buyInAmount ?? 0,
    };
  };
}

const getTournamentActionWallet = buildGetTournamentActionWallet();

module.exports = {
  buildGetTournamentActionWallet,
  getTournamentActionWallet,
};
