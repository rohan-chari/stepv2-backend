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

  // Events created today (UTC). Used by the scheduler for idempotency: it must
  // not re-create an event for an anchor that already fired today.
  async findCreatedOnUtcDay(date) {
    const d = new Date(date);
    const dayStart = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    return prisma.globalStepEvent.findMany({
      where: { startsAt: { gte: dayStart, lt: nextDay } },
      orderBy: { startsAt: "asc" },
    });
  },
};

module.exports = { GlobalStepEvent };
