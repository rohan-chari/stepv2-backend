const { prisma } = require("../db");

// ── Date helpers (UTC date axis, matching Step.date semantics) ──────────────

// UTC midnight of the Monday on or before the given moment.
function mondayOnOrBefore(value) {
  const d = value instanceof Date ? value : new Date(value);
  const day = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const dow = day.getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  day.setUTCDate(day.getUTCDate() - back);
  return day;
}

function addDaysUtc(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const RankedWeek = {
  // The week whose [startsOn, endsOn) window covers `now` (any status).
  async getCurrent(now = new Date()) {
    return prisma.rankedWeek.findFirst({
      where: { startsOn: { lte: now }, endsOn: { gt: now } },
      orderBy: { index: "desc" },
    });
  },

  async getById(id) {
    return prisma.rankedWeek.findUnique({ where: { id } });
  },

  async getLatestIndex() {
    const latest = await prisma.rankedWeek.findFirst({
      orderBy: { index: "desc" },
      select: { index: true },
    });
    return latest?.index ?? 0;
  },

  async create({ index, startsOn, endsOn }) {
    return prisma.rankedWeek.create({
      data: { index, startsOn, endsOn, status: "ACTIVE" },
    });
  },

  // Weeks past their boundary and still ACTIVE (settlement candidates; the
  // caller applies the grace period).
  async findUnsettled(now = new Date()) {
    return prisma.rankedWeek.findMany({
      where: { status: "ACTIVE", endsOn: { lte: now } },
      orderBy: { index: "asc" },
    });
  },

  // At-most-once settlement gate — advisory lock + ACTIVE -> SETTLING CAS,
  // same pattern as Season.claimForSettlement.
  async claimForSettlement(weekId) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ranked-week-roll'))`;
      const result = await tx.rankedWeek.updateMany({
        where: { id: weekId, status: "ACTIVE" },
        data: { status: "SETTLING" },
      });
      return result.count;
    });
  },

  async markClosed(weekId, settledAt) {
    return prisma.rankedWeek.update({
      where: { id: weekId },
      data: { status: "CLOSED", settledAt },
    });
  },
};

const RankedCohort = {
  async create({ weekId, tier }) {
    return prisma.rankedCohort.create({ data: { weekId, tier } });
  },

  // Cohorts of a week (optionally one tier) with member counts, smallest
  // first — used to place mid-week joiners.
  async listForWeek(weekId, { tier } = {}) {
    return prisma.rankedCohort.findMany({
      where: { weekId, ...(tier ? { tier } : {}) },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: "asc" },
    });
  },
};

const RankedCohortMember = {
  async createMany(rows) {
    if (rows.length === 0) return { count: 0 };
    return prisma.rankedCohortMember.createMany({
      data: rows,
      skipDuplicates: true, // (weekId, userId) unique — concurrent place is a no-op
    });
  },

  async listForWeek(weekId) {
    return prisma.rankedCohortMember.findMany({
      where: { weekId },
      orderBy: [{ weeklySteps: "desc" }, { userId: "asc" }],
    });
  },

  async listForCohort(cohortId) {
    return prisma.rankedCohortMember.findMany({
      where: { cohortId },
      orderBy: [{ weeklySteps: "desc" }, { userId: "asc" }],
    });
  },

  async getForUser(weekId, userId) {
    return prisma.rankedCohortMember.findUnique({
      where: { weekId_userId: { weekId, userId } },
    });
  },

  async writeProvisional({ id, weeklySteps, provisionalRank }) {
    return prisma.rankedCohortMember.update({
      where: { id },
      data: { weeklySteps, provisionalRank },
    });
  },

  async writeFinal({
    id,
    weeklySteps,
    finalRank,
    outcome,
    resultTier,
    rewardCoins,
    promotionCoins,
  }) {
    return prisma.rankedCohortMember.update({
      where: { id },
      data: {
        weeklySteps,
        provisionalRank: finalRank,
        finalRank,
        outcome,
        resultTier,
        rewardCoins,
        promotionCoins,
      },
    });
  },
};

module.exports = {
  RankedWeek,
  RankedCohort,
  RankedCohortMember,
  mondayOnOrBefore,
  addDaysUtc,
};
