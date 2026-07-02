const { prisma: defaultPrisma } = require("../db");

// Auto-join for the seeded daily/weekly featured challenges
// (users.auto_join_featured_races). Two entry points share the same
// capacity-respecting enrollment:
//
//   * enrollAutoJoinUsers(race)     — renewal cron, right after it creates a
//     seeded race: enroll every opted-in user.
//   * optUserIntoPendingSeededRaces(userId) — the settings toggle, on enable:
//     opt this user into the already-created PENDING "next" race(s) so the
//     preference takes effect starting with the next challenge instead of
//     waiting a full cadence for the cron to create a new one.
//
// Enrollment writes RaceParticipant rows directly rather than going through
// joinRaceCore: seeded races never have a buy-in, the first powerup-box
// threshold for pre-start opt-ins is initialized by promoteSeededRace, and a
// bulk system enrollment must not emit per-user RACE_PUBLIC_JOINED events or
// onboarding box grants. Duplicate protection comes from skipDuplicates /
// an existing-participant check, so both entry points are idempotent.
function buildAutoJoinFeaturedRaces(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  // How many more ACCEPTED participants `race` can take. null max => unlimited.
  async function remainingCapacity(race) {
    if (race.maxParticipants == null) return Infinity;
    const accepted = await prisma.raceParticipant.count({
      where: { raceId: race.id, status: "ACCEPTED" },
    });
    return Math.max(0, race.maxParticipants - accepted);
  }

  async function enroll(race, userIds) {
    if (userIds.length === 0) return 0;
    const capacity = await remainingCapacity(race);
    if (capacity <= 0) return 0;
    const toAdd = capacity === Infinity ? userIds : userIds.slice(0, capacity);
    const result = await prisma.raceParticipant.createMany({
      data: toAdd.map((userId) => ({
        raceId: race.id,
        userId,
        status: "ACCEPTED",
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  // Cron path: enroll every opted-in user into a just-created seeded race.
  // `race` needs { id, maxParticipants }.
  async function enrollAutoJoinUsers(race) {
    const users = await prisma.user.findMany({
      where: { autoJoinFeaturedRaces: true },
      select: { id: true },
      // Oldest accounts first so the cutoff on a capped race is deterministic.
      orderBy: { createdAt: "asc" },
    });
    return enroll(
      race,
      users.map((u) => u.id)
    );
  }

  // Toggle path: opt one user into every existing PENDING seeded race they are
  // not already in. Deliberately skips ACTIVE races — auto-join starts with
  // the NEXT challenge, not the one already running.
  async function optUserIntoPendingSeededRaces(userId) {
    const pending = await prisma.race.findMany({
      where: { status: "PENDING", seedId: { not: null } },
      select: { id: true, maxParticipants: true },
    });
    let joined = 0;
    for (const race of pending) {
      const existing = await prisma.raceParticipant.findFirst({
        where: { raceId: race.id, userId },
        select: { id: true },
      });
      if (existing) continue;
      joined += await enroll(race, [userId]);
    }
    return joined;
  }

  return { enrollAutoJoinUsers, optUserIntoPendingSeededRaces };
}

const {
  enrollAutoJoinUsers,
  optUserIntoPendingSeededRaces,
} = buildAutoJoinFeaturedRaces();

module.exports = {
  buildAutoJoinFeaturedRaces,
  enrollAutoJoinUsers,
  optUserIntoPendingSeededRaces,
};
