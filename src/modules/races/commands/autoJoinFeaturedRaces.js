const { prisma: defaultPrisma } = require("../../../db");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  filterInactiveUserIds,
  disableAutoEnrollForInactive,
} = require("../services/seededInactivity");
const { claimLegacyStream, readWindowMode, BUCKET_FEATURE } = require("../services/seededRaceBuckets");
const {
  computeRaceExposureStamp,
  lockFundedExposureUsers,
  reserveFundedExposure,
  resolveRacePrizeStamp,
} = require("../services/fundedExposure");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("../services/raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
  enrollIfGlobalEventActive,
} = require("../../steps/services/globalEventEnrollment");

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
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const acquireWriteFence =
    dependencies.acquireRaceWriteFence || acquireRaceWriteFence;
  const lockUsers =
    dependencies.lockFundedExposureUsers || lockFundedExposureUsers;
  const lockCompetitions =
    dependencies.lockCompetitionRows || lockCompetitionRows;
  const acquireGlobalLock =
    dependencies.acquireGlobalEnrollmentLock || acquireGlobalEnrollmentLock;
  const enrollGlobalEvent =
    dependencies.enrollIfGlobalEventActive || enrollIfGlobalEventActive;

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
    const candidates = capacity === Infinity ? userIds : userIds.slice(0, capacity);
    const toAdd = [];
    for (const userId of candidates) {
      if (await claimLegacyStream({ prisma, race, userId })) toAdd.push(userId);
    }
    if (toAdd.length === 0) return 0;
    const exposureStamp = race.fundedPrize === true
      ? computeRaceExposureStamp({
          maxDurationDays: race.maxDurationDays,
          prizeCoinUnit: resolveRacePrizeStamp(race).prizeCoinUnit,
          teamPoolMultBps: race.teamPoolMultBps,
        })
      : null;
    const participantData = (userId) => ({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      ...(exposureStamp
        ? {
            fundedExposureMillicoins: exposureStamp.exposureMillicoins,
            fundedExposureRateMillicoinsPerDay:
              exposureStamp.exposureRateMillicoinsPerDay,
          }
        : {}),
    });
    let joined = 0;
    for (const userId of [...toAdd].sort()) {
      try {
        joined += await prisma.$transaction(async (tx) => {
          await acquireWriteFence(tx, race.id);
          await acquireGlobalLock(tx);
          await lockUsers(tx, [userId]);
          if (!exposureStamp) {
            await lockCompetitions(tx, { raceIds: [race.id] });
          }
          const lockedRace = await tx.race.findUnique({
            where: { id: race.id },
            select: { status: true, maxParticipants: true },
          });
          if (!lockedRace || !["ACTIVE", "PENDING"].includes(lockedRace.status)) {
            return 0;
          }
          const existing = await tx.raceParticipant.findUnique({
            where: { raceId_userId: { raceId: race.id, userId } },
            select: { id: true },
          });
          if (existing) return 0;
          const acceptedCount = await tx.raceParticipant.count({
            where: { raceId: race.id, status: "ACCEPTED" },
          });
          if (
            lockedRace.maxParticipants != null &&
            acceptedCount >= lockedRace.maxParticipants
          ) {
            return 0;
          }
          if (exposureStamp) {
            await reserveFundedExposure({
              tx,
              userId,
              stamp: exposureStamp,
              competition: { raceId: race.id },
              enforceLimits: false,
            });
          }
          const created = await tx.raceParticipant.createMany({
            data: [participantData(userId)],
            skipDuplicates: true,
          });
          if (created.count > 0 && lockedRace.status === "ACTIVE") {
            await enrollGlobalEvent(tx, {
              raceId: race.id,
              userIds: [userId],
              at: new Date(),
            });
          }
          return created.count;
        });
      } catch (error) {
        if (
          error?.code !== "FUNDED_EXPOSURE_LIMIT" &&
          error?.code !== "FUNDED_EXPOSURE_RETRY"
        ) {
          throw error;
        }
        logger.warn(
          `[CRON] Funded exposure skipped seeded auto-enrollment user=${userId} race=${race.id}`,
        );
      }
    }
    return joined;
  }

  // Cron path: enroll every opted-in user into a just-created seeded race.
  // `race` needs { id, maxParticipants }.
  async function enrollAutoJoinUsers(race) {
    const windowStart = race.scheduledStartAt || race.startedAt;
    const mode = race.seedId && windowStart
      ? await readWindowMode({ prisma, seedId: race.seedId, windowStart })
      : "LEGACY";
    const users = await prisma.user.findMany({
      where: {
        autoJoinFeaturedRaces: true,
        // In a durable BUCKET window the capable accounts are elected by the
        // bucket service before this legacy pass. Everybody else remains on
        // the frozen-client compatible global field.
        ...(mode === "BUCKET" ? { NOT: { clientFeatures: { has: BUCKET_FEATURE } } } : {}),
      },
      select: { id: true },
      // Oldest accounts first so the cutoff on a capped race is deterministic.
      orderBy: { createdAt: "asc" },
    });
    return enroll(race, await dropInactive(users.map((u) => u.id)));
  }

  // Hook 1 (spec §4.3): keep 2-day-zero accounts out of the field before the
  // capacity slice, so the slots go to people actually playing. The race is
  // being created now, so the race-createdAt exemption is vacuous here.
  // Fail-open: a predicate failure must never stop the challenge from filling.
  async function dropInactive(userIds) {
    if (userIds.length === 0) return userIds;
    const now = new Date();
    let inactive;
    let remaining = userIds;
    try {
      if ((await settings.getFlag("seededInactivityPruneEnabled")) !== true) {
        return userIds;
      }
      inactive = await filterInactiveUserIds({ userIds, now, prisma });
      if (inactive.size === 0) return userIds;
      remaining = userIds.filter((id) => !inactive.has(id));
    } catch (error) {
      logger.error("[CRON] Inactivity enrollment filter failed:", error);
      return userIds;
    }

    // THE terminating path (batch 2026-08-10 item 1). With the prune on, a
    // ghost is filtered out here and never becomes a participant, so hooks 2/3
    // would never see them again — if the flip lived only there, this filter
    // would re-evaluate the same dead accounts against every new seeded race
    // forever. Once flipped they drop out of the `autoJoinFeaturedRaces: true`
    // query above, so the ghost set shrinks monotonically.
    //
    // Runs AFTER the filter result is computed and in its OWN try/catch that
    // never rethrows: the catch above returns the UNFILTERED list, so a flip
    // failure must never reach it and undo the prune.
    try {
      await disableAutoEnrollForInactive({
        userIds: [...inactive],
        now,
        prisma,
        appSettings: settings,
        logger,
      });
    } catch (error) {
      logger.error("[CRON] Auto-enroll flip failed (enrollment filter):", error);
    }
    return remaining;
  }

  // Toggle path: opt one user into every existing PENDING seeded race they are
  // not already in. Deliberately skips ACTIVE races — auto-join starts with
  // the NEXT challenge, not the one already running.
  async function optUserIntoPendingSeededRaces(userId) {
    const pending = await prisma.race.findMany({
      where: { status: "PENDING", seedId: { not: null } },
      select: {
        id: true,
        seedId: true,
        startedAt: true,
        scheduledStartAt: true,
        maxParticipants: true,
        fundedPrize: true,
        maxDurationDays: true,
        teamPoolMultBps: true,
        prizeCoinUnit: true,
        prizePoolMaxCoins: true,
        prizeCalculationVersion: true,
      },
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
