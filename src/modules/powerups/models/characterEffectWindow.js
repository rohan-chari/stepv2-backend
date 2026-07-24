const { prisma } = require("../../../db");

// Materialized Corgi "Zoomies" windows (§3.6.2). Keyed by (userId, localDayKey,
// slot) with a UNIQUE constraint, so materialization is insert-first and
// cluster-safe (never an advisory lock across the callback — the 3e6c827 rule).
const CharacterEffectWindow = {
  // Insert-first idempotent create. A duplicate (userId, localDayKey, slot) is
  // swallowed so two cluster workers materializing the same day never collide.
  async createIfAbsent({ userId, animal, multiplier, startsAt, endsAt, localDayKey, slot }) {
    try {
      return await prisma.characterEffectWindow.create({
        data: { userId, animal, multiplier, startsAt, endsAt, localDayKey, slot },
      });
    } catch (error) {
      // P2002 = unique violation (already materialized by another tick/worker).
      if (error && error.code === "P2002") return null;
      throw error;
    }
  },

  // Windows for `userId` overlapping [rangeStart, rangeEnd]. Used by the scoring
  // paths (getRaceProgress / raceExpiry) to fold active zoomies into the total.
  async findActiveInRangeForUser(userId, rangeStart, rangeEnd) {
    return prisma.characterEffectWindow.findMany({
      where: {
        userId,
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
      orderBy: { startsAt: "asc" },
    });
  },

  // Windows live at `now` (startsAt <= now < endsAt) that have NOT been notified.
  // Push is claimed via claimNotify (CAS), so a returned row still races other
  // workers until it wins the claim.
  async findDueForNotify(now) {
    const at = new Date(now);
    return prisma.characterEffectWindow.findMany({
      where: {
        startsAt: { lte: at },
        endsAt: { gt: at },
        notifiedAt: null,
      },
      orderBy: { startsAt: "asc" },
    });
  },

  // CAS push-dedup claim: flips notifiedAt from null exactly once. Returns true
  // for the single winner, false for every loser.
  async claimNotify(id, now = new Date()) {
    const result = await prisma.characterEffectWindow.updateMany({
      where: { id, notifiedAt: null },
      data: { notifiedAt: now },
    });
    return result.count === 1;
  },

  // Retention: delete windows that ended before `cutoff` (45 days ago).
  async deleteEndedBefore(cutoff) {
    const result = await prisma.characterEffectWindow.deleteMany({
      where: { endsAt: { lt: new Date(cutoff) } },
    });
    return result.count;
  },
};

module.exports = { CharacterEffectWindow };
