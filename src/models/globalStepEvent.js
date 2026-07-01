const { prisma } = require("../db");

const GlobalStepEvent = {
  async create({ startsAt, endsAt, multiplier, label }) {
    return prisma.globalStepEvent.create({
      data: { startsAt, endsAt, multiplier, label: label ?? null },
    });
  },

  // Events whose window overlaps [rangeStart, rangeEnd]. Used by getRaceProgress
  // (rangeStart = race start, rangeEnd = now) and raceExpiry (rangeEnd = end) to
  // fetch the windows relevant to a participant's step samples.
  async findActiveInRange(rangeStart, rangeEnd) {
    return prisma.globalStepEvent.findMany({
      where: {
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      orderBy: { startsAt: "asc" },
    });
  },

  // The single event currently active at `now` (startsAt <= now < endsAt), or
  // null. Used by the home card to surface a "2x STEPS" banner. Akin to
  // findActiveInRange but returns just the one in-progress row.
  async findActiveAt(now) {
    const at = new Date(now);
    return prisma.globalStepEvent.findFirst({
      where: {
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      orderBy: { startsAt: "desc" },
    });
  },

  // Events started at/after `since`. Used by the scheduler for idempotency: it
  // must not re-create an event for a chosen time that already fired. A rolling
  // lookback (not calendar-day bucketing) because the ET-anchored start and the
  // next tick can straddle UTC midnight, which UTC-day buckets would split.
  async findStartedSince(since) {
    return prisma.globalStepEvent.findMany({
      where: { startsAt: { gte: new Date(since) } },
      orderBy: { startsAt: "asc" },
    });
  },
};

module.exports = { GlobalStepEvent };
