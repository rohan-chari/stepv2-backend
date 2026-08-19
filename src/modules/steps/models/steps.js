const { prisma } = require("../../../db");
const {
  bumpScoringInputVersion,
  lockScoringInputState,
  readCanonicalSampleInput,
  scoringBoundaryIsSafe,
  persistScoringInputState,
} = require("../services/scoringInputVersion");

const Steps = {
  async findByUserId(userId) {
    return prisma.step.findMany({
      where: { userId },
      orderBy: { date: "desc" },
    });
  },

  async findByUserIdAndDate(userId, date) {
    return prisma.step.findUnique({
      where: { userId_date: { userId, date: new Date(date) } },
    });
  },

  async create({ userId, steps, date, stepGoal }, { noopSuppression = false } = {}) {
    return prisma.$transaction(async (tx) => {
      const state = noopSuppression ? await lockScoringInputState(tx, userId) : null;
      const row = await tx.step.create({
        data: { userId, steps, date: new Date(date), stepGoal },
      });
      if (!noopSuppression) {
        await bumpScoringInputVersion(tx, userId);
        return row;
      }
      const next = await readCanonicalSampleInput(tx, userId, state.dbNow);
      await persistScoringInputState(tx, userId, state, next, true);
      return { record: row, storageChanged: true, scoringChanged: true };
    });
  },

  async update(id, fields, { noopSuppression = false } = {}) {
    return prisma.$transaction(async (tx) => {
      const before = noopSuppression
        ? await tx.step.findUnique({ where: { id } })
        : null;
      const state = noopSuppression
        ? await lockScoringInputState(tx, before?.userId)
        : null;
      const row = await tx.step.update({ where: { id }, data: fields });
      if (!noopSuppression) {
        await bumpScoringInputVersion(tx, row.userId);
        return row;
      }
      const next = await readCanonicalSampleInput(tx, row.userId);
      const storageChanged = Number(before?.steps) !== Number(row.steps);
      const decisionState = { ...state, dbNow: next.dbNow };
      const scoringChanged = storageChanged || !scoringBoundaryIsSafe(decisionState) ||
        state.scoringWatermark !== next.scoringWatermark;
      await persistScoringInputState(tx, row.userId, state, next, scoringChanged);
      return { record: row, storageChanged, scoringChanged };
    });
  },

  async findByUserIdAndDateRange(userId, startDate, endDate) {
    return prisma.step.findMany({
      where: {
        userId,
        date: { gte: new Date(startDate), lte: new Date(endDate) },
      },
      orderBy: { date: "asc" },
    });
  },

  // Bulk variant of findByUserIdAndDateRange across users, for the
  // cross-participant prefetch in getHomeRaceCard. Same inclusive date
  // bounds; callers slice per user, so filtering these rows by one userId
  // matches that user's per-user query exactly.
  async findByUserIdsAndDateRange(userIds, startDate, endDate) {
    if (!userIds || userIds.length === 0) return [];
    return prisma.step.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: new Date(startDate), lte: new Date(endDate) },
      },
      orderBy: { date: "asc" },
    });
  },

  // All per-day step rows in the half-open date range [startDate, endExclusive),
  // across users, for ranked scoring. The end is exclusive so a season boundary
  // day counts toward exactly one season (no double-count on rollover). Excludes
  // review/demo accounts by default so they never appear on the ladder.
  async findRowsInRange(startDate, endExclusive, { excludeReviewAccounts = true } = {}) {
    return prisma.step.findMany({
      where: {
        date: { gte: new Date(startDate), lt: new Date(endExclusive) },
        ...(excludeReviewAccounts ? { user: { isReviewAccount: false } } : {}),
      },
      select: { userId: true, date: true, steps: true },
    });
  },

  async sumStepsForUsers(userIds, startDate, endDate) {
    if (userIds.length === 0) return new Map();

    const results = await prisma.step.groupBy({
      by: ["userId"],
      _sum: { steps: true },
      where: {
        userId: { in: userIds },
        date: { gte: new Date(startDate), lte: new Date(endDate) },
      },
    });

    const totals = new Map();
    for (const row of results) {
      totals.set(row.userId, row._sum.steps || 0);
    }
    return totals;
  },
};

module.exports = { Steps };
