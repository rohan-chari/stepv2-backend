const { prisma } = require("../db");

const Season = {
  // The single live season (there should be at most one ACTIVE at a time).
  async getActive() {
    return prisma.season.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { index: "desc" },
    });
  },

  async getById(id) {
    return prisma.season.findUnique({ where: { id } });
  },

  // Highest season index ever created (0 if none) — used to number new seasons.
  async getLatestIndex() {
    const latest = await prisma.season.findFirst({
      orderBy: { index: "desc" },
      select: { index: true },
    });
    return latest?.index ?? 0;
  },

  async create({ index, startsAt, endsAt }) {
    return prisma.season.create({
      data: { index, startsAt, endsAt, status: "ACTIVE" },
    });
  },

  // At-most-once settlement gate. Holds a transaction-scoped advisory lock while
  // it flips ACTIVE -> SETTLING via a compare-and-swap; returns the affected
  // count (1 = this caller won the claim, 0 = already being settled/closed).
  // The advisory lock serializes concurrent settles even across processes; the
  // SETTLING status then guards the rest of the work after the lock releases.
  async claimForSettlement(seasonId) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ranked-season-roll'))`;
      const result = await tx.season.updateMany({
        where: { id: seasonId, status: "ACTIVE" },
        data: { status: "SETTLING" },
      });
      return result.count;
    });
  },

  async markClosed(seasonId, settledAt) {
    return prisma.season.update({
      where: { id: seasonId },
      data: { status: "CLOSED", settledAt },
    });
  },
};

const SeasonScore = {
  // Ladder order: highest points first.
  async listForSeason(seasonId) {
    return prisma.seasonScore.findMany({
      where: { seasonId },
      orderBy: [{ points: "desc" }, { userId: "asc" }],
    });
  },

  async getForUser(userId, seasonId) {
    return prisma.seasonScore.findUnique({
      where: { userId_seasonId: { userId, seasonId } },
    });
  },

  // The user's live (provisional) standing in the current ACTIVE season, for
  // showing their tier on other surfaces (profile, etc.). Null if no active
  // season or the user has no score yet.
  async getActiveForUser(userId) {
    const season = await prisma.season.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { index: "desc" },
      select: { id: true },
    });
    if (!season) return null;
    return prisma.seasonScore.findUnique({
      where: { userId_seasonId: { userId, seasonId: season.id } },
      select: {
        provisionalTier: true,
        provisionalDivision: true,
        provisionalRank: true,
        points: true,
      },
    });
  },

  // Upsert the live (provisional) standing for a user. Always (re)writes points,
  // earned, and carry-over so the row reflects the latest computation.
  async writeProvisional({
    userId,
    seasonId,
    points,
    earnedPoints,
    carryOverSeed,
    rank,
    tier,
    division,
  }) {
    const provisional = {
      points,
      earnedPoints,
      carryOverSeed,
      provisionalRank: rank,
      provisionalTier: tier,
      provisionalDivision: division,
    };
    return prisma.seasonScore.upsert({
      where: { userId_seasonId: { userId, seasonId } },
      create: { userId, seasonId, ...provisional },
      update: provisional,
    });
  },

  // Upsert the locked (final) standing at settlement.
  async writeFinal({
    userId,
    seasonId,
    points,
    earnedPoints,
    carryOverSeed,
    rank,
    tier,
    division,
  }) {
    const final = {
      points,
      earnedPoints,
      carryOverSeed,
      rank,
      tier,
      division,
      provisionalRank: rank,
      provisionalTier: tier,
      provisionalDivision: division,
    };
    return prisma.seasonScore.upsert({
      where: { userId_seasonId: { userId, seasonId } },
      create: { userId, seasonId, ...final },
      update: final,
    });
  },
};

module.exports = { Season, SeasonScore };
