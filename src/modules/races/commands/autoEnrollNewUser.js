const { randomUUID } = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { hashAppleSub } = require("../../users/appleSubHash");
const {
  acquireGlobalEnrollmentLock,
  enrollIfGlobalEventActive,
} = require("../../steps/services/globalEventEnrollment");
const {
  computeRaceExposureStamp,
  lockFundedExposureUsers,
  reserveFundedExposure,
  resolveRacePrizeStamp,
} = require("../services/fundedExposure");
const {
  acquireRaceWriteFence,
  acquireRaceWriteFences,
  lockCompetitionRows,
} = require("../services/raceWriteFence");
const {
  acquireSeededWindowLock,
  cohortMaximumForSeed,
  DAILY_COHORT_MAXIMUM,
  readWindowMode,
  WEEKLY_COHORT_MAXIMUM,
} = require("../services/seededRaceBuckets");

// Signup starter-race enrollment (product decision 2026-07-12): a brand-new
// account must never land on an empty races list. Called best-effort from the
// create branch of the provisioners (ensureAppleUser / ensureGoogleUser),
// right after referral attribution — SIGNUP MUST NEVER FAIL because of it.
//
// What it does:
//   1. Defaults `autoJoinFeaturedRaces` ON for the new user, so the renewal
//      cron keeps enrolling them into each new seeded challenge. The existing
//      featured-settings toggle lets them opt out at any time.
//   2. Enrolls them into every current seeded race — ACTIVE ones included, so
//      the very first session shows a live mid-race leaderboard (the pending
//      "next" race alone would greet them with "starts Thursday"). Direct
//      participant writes, same as autoJoinFeaturedRaces.js: seeded races have
//      no buy-in, and a system enrollment must not emit per-user join events.
//   3. Grants the 3 welcome mystery boxes into the ACTIVE seeded race, through
//      the same once-per-human OnboardingBoxGrant ledger as joinRaceCore's
//      onboarding join — but WITHOUT setting firstRaceOnboardingSeen. That
//      flag short-circuits the client's whole onboarding gate (shipped
//      binaries skip the tutorial when it's true), so it stays false and the
//      client onboarding runs unchanged. The old first-race picker can't
//      dead-end either way: it excludes races you're in and auto-skips on an
//      empty list; if the user does join another race with onboarding=true,
//      the ledger makes the second box grant a no-op.
function buildAutoEnrollNewUser(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const events = dependencies.eventBus || eventBus;
  const hashSub = dependencies.hashAppleSub || hashAppleSub;
  const acquireWriteFence =
    dependencies.acquireRaceWriteFence || acquireRaceWriteFence;
  const acquireWriteFences =
    dependencies.acquireRaceWriteFences || acquireRaceWriteFences;
  const lockUsers =
    dependencies.lockFundedExposureUsers || lockFundedExposureUsers;
  const lockCompetitions =
    dependencies.lockCompetitionRows || lockCompetitionRows;

  const WELCOME_BOXES = 3;
  const DEFAULT_POWERUP_SLOTS = 3;

  async function createAcceptedParticipant(race, userId, { allowOverCapacity = false } = {}) {
    return db.$transaction(async (tx) => {
      await acquireWriteFence(tx, race.id);
      // The selection read above is optimistic: the race may have started
      // before C0 was acquired. Take the global-event lock unconditionally so
      // the authoritative lifecycle reread below can safely choose the ACTIVE
      // enrollment path without relying on stale status.
      await acquireGlobalEnrollmentLock(tx);
      await lockUsers(tx, [userId]);
      let exposureStamp = null;
      if (race.fundedPrize === true) {
        const prizeStamp = resolveRacePrizeStamp(race);
        exposureStamp = computeRaceExposureStamp({
          maxDurationDays: race.maxDurationDays,
          prizeCoinUnit: prizeStamp.prizeCoinUnit,
          teamPoolMultBps: race.teamPoolMultBps,
        });
        await reserveFundedExposure({
          tx,
          userId,
          stamp: exposureStamp,
          competition: { raceId: race.id },
          // This is a seeded enrollment caller. Keep its historical exposure
          // policy explicit while user-created admission is unlimited.
          enforceLimits: true,
        });
      } else {
        await lockCompetitions(tx, { raceIds: [race.id] });
      }
      const lockedRace = await tx.race.findUnique({
        where: { id: race.id },
        select: {
          status: true,
          maxParticipants: true,
          seededBucketId: true,
          seededBucket: {
            select: { id: true, seedId: true, windowStart: true },
          },
        },
      });
      if (!lockedRace || !["ACTIVE", "PENDING"].includes(lockedRace.status)) {
        const error = new Error("Race is no longer joinable");
        error.code = "RACE_NOT_JOINABLE";
        throw error;
      }
      const acceptedCount = await tx.raceParticipant.count({
        where: { raceId: race.id, status: "ACCEPTED" },
      });
      if (
        lockedRace.maxParticipants != null &&
        acceptedCount >= lockedRace.maxParticipants &&
        (!allowOverCapacity || lockedRace.seededBucketId != null)
      ) {
        const error = new Error("Race is full");
        error.code = "RACE_FULL";
        throw error;
      }
      const participant = await tx.raceParticipant.create({
        data: {
          raceId: race.id,
          userId,
          status: "ACCEPTED",
          ...(exposureStamp
            ? {
                fundedExposureMillicoins:
                  exposureStamp.exposureMillicoins,
                fundedExposureRateMillicoinsPerDay:
                  exposureStamp.exposureRateMillicoinsPerDay,
              }
            : {}),
        },
      });
      if (lockedRace.seededBucket) {
        await tx.seededRaceWindowMembership.create({
          data: {
            seedId: lockedRace.seededBucket.seedId,
            windowStart: lockedRace.seededBucket.windowStart,
            userId,
            stream: "BUCKET",
            raceId: race.id,
          },
        });
        await tx.seededRaceBucketAssignment.create({
          data: {
            bucketId: lockedRace.seededBucket.id,
            userId,
            seedId: lockedRace.seededBucket.seedId,
            windowStart: lockedRace.seededBucket.windowStart,
            raceParticipantId: participant.id,
            matchSteps: 0,
            state: "FINAL",
          },
        });
      }
      if (lockedRace.status === "ACTIVE") {
        await enrollIfGlobalEventActive(tx, {
          raceId: race.id,
          userIds: [userId],
          at: new Date(),
        });
      }
      return participant;
    });
  }

  async function createOverflowParticipant(sourceRace, userId) {
    const windowStart = sourceRace.scheduledStartAt || sourceRace.startedAt;
    if (!sourceRace.seedId || !windowStart || !sourceRace.endsAt) {
      const error = new Error("Seeded overflow source has no window identity");
      error.code = "OVERFLOW_NOT_AVAILABLE";
      throw error;
    }
    const configuredMaximum = cohortMaximumForSeed(sourceRace.seed);
    const maximum = Number.isFinite(configuredMaximum)
      ? configuredMaximum
      : sourceRace.seed?.cadence === "DAILY"
        ? DAILY_COHORT_MAXIMUM
        : sourceRace.seed?.cadence === "WEEKLY"
          ? WEEKLY_COHORT_MAXIMUM
          : Infinity;
    if (!Number.isFinite(maximum)) {
      const error = new Error("Seeded overflow source has no hard cap");
      error.code = "OVERFLOW_NOT_AVAILABLE";
      throw error;
    }

    return db.$transaction(async (tx) => {
      const raceId = randomUUID();
      const bucketId = randomUUID();
      const race = await tx.race.create({
        data: {
          id: raceId,
          seedId: sourceRace.seedId,
          name: sourceRace.name,
          targetSteps: sourceRace.targetSteps,
          status: "ACTIVE",
          isPublic: false,
          maxParticipants: maximum,
          powerupsEnabled: sourceRace.powerupsEnabled,
          powerupStepInterval: sourceRace.powerupStepInterval,
          timeBased: sourceRace.timeBased,
          timezone: sourceRace.timezone,
          scheduledStartAt: sourceRace.scheduledStartAt,
          startedAt: sourceRace.startedAt,
          endsAt: sourceRace.endsAt,
          maxDurationDays: sourceRace.maxDurationDays,
          payoutPreset: sourceRace.payoutPreset,
          payoutCurve: sourceRace.payoutCurve,
          fundedPrize: sourceRace.fundedPrize,
          prizeCalculationVersion: sourceRace.prizeCalculationVersion,
          prizeCoinUnit: sourceRace.prizeCoinUnit,
          prizePoolMaxCoins: sourceRace.prizePoolMaxCoins,
          payoutRoundingVersion: sourceRace.payoutRoundingVersion,
          exitActionsEnabled: sourceRace.exitActionsEnabled,
        },
      });

      // Match the universal enrollment order. The provisional empty race is
      // invisible until commit; if another signup opened reusable capacity,
      // the retry signal rolls this row and every reservation back.
      await acquireWriteFences(tx, [sourceRace.id, raceId]);
      await acquireGlobalEnrollmentLock(tx);
      let exposureStamp = null;
      if (race.fundedPrize === true) {
        const prizeStamp = resolveRacePrizeStamp(race);
        exposureStamp = computeRaceExposureStamp({
          maxDurationDays: race.maxDurationDays,
          prizeCoinUnit: prizeStamp.prizeCoinUnit,
          teamPoolMultBps: race.teamPoolMultBps,
        });
        await reserveFundedExposure({
          tx,
          userId,
          stamp: exposureStamp,
          competition: { raceId },
          enforceLimits: true,
        });
      } else {
        await lockUsers(tx, [userId]);
        await lockCompetitions(tx, { raceIds: [sourceRace.id, raceId] });
      }
      await acquireSeededWindowLock(tx, sourceRace.seedId, windowStart);

      const lockedSource = await tx.race.findUnique({
        where: { id: sourceRace.id },
        select: {
          seedId: true,
          status: true,
          seededBucketId: true,
          scheduledStartAt: true,
          startedAt: true,
          endsAt: true,
        },
      });
      const lockedWindowStart =
        lockedSource?.scheduledStartAt || lockedSource?.startedAt;
      if (
        !lockedSource ||
        lockedSource.seedId !== sourceRace.seedId ||
        lockedSource.status !== "ACTIVE" ||
        lockedSource.seededBucketId == null ||
        !lockedWindowStart ||
        new Date(lockedWindowStart).getTime() !== new Date(windowStart).getTime() ||
        !lockedSource.endsAt ||
        new Date(lockedSource.endsAt).getTime() <= Date.now() ||
        (await readWindowMode({
          prisma: tx,
          seedId: sourceRace.seedId,
          windowStart,
        })) !== "BUCKET"
      ) {
        const error = new Error("Seeded cohort window is no longer joinable");
        error.code = "RACE_NOT_JOINABLE";
        throw error;
      }

      const currentRaces = await tx.race.findMany({
        where: {
          seedId: sourceRace.seedId,
          status: "ACTIVE",
          seededBucketId: { not: null },
          startedAt: sourceRace.startedAt,
          id: { not: raceId },
        },
        select: { id: true, maxParticipants: true },
      });
      if (currentRaces.length) {
        const accepted = await tx.raceParticipant.groupBy({
          by: ["raceId"],
          where: {
            raceId: { in: currentRaces.map((row) => row.id) },
            status: "ACCEPTED",
          },
          _count: { _all: true },
        });
        const acceptedByRaceId = new Map(
          accepted.map((row) => [row.raceId, row._count._all]),
        );
        if (currentRaces.some((row) =>
          row.maxParticipants == null ||
          (acceptedByRaceId.get(row.id) || 0) < row.maxParticipants
        )) {
          const error = new Error("Seeded cohort capacity became available");
          error.code = "OVERFLOW_RETRY";
          throw error;
        }
      }

      await tx.seededRaceBucket.create({
        data: {
          id: bucketId,
          seedId: sourceRace.seedId,
          windowStart,
          windowEnd: sourceRace.endsAt,
          raceId,
          status: "ACTIVE",
        },
      });
      await tx.race.update({
        where: { id: raceId },
        data: { seededBucketId: bucketId },
      });
      const participant = await tx.raceParticipant.create({
        data: {
          raceId,
          userId,
          status: "ACCEPTED",
          ...(exposureStamp
            ? {
                fundedExposureMillicoins: exposureStamp.exposureMillicoins,
                fundedExposureRateMillicoinsPerDay:
                  exposureStamp.exposureRateMillicoinsPerDay,
              }
            : {}),
        },
      });
      await tx.seededRaceWindowMembership.create({
        data: {
          seedId: sourceRace.seedId,
          windowStart,
          userId,
          stream: "BUCKET",
          raceId,
        },
      });
      await tx.seededRaceBucketAssignment.create({
        data: {
          bucketId,
          userId,
          seedId: sourceRace.seedId,
          windowStart,
          raceParticipantId: participant.id,
          matchSteps: 0,
          state: "FINAL",
        },
      });
      await enrollIfGlobalEventActive(tx, {
        raceId,
        userIds: [userId],
        at: new Date(),
      });
      return { race: { ...race, seededBucketId: bucketId }, participant };
    });
  }

  async function remainingCapacity(race) {
    if (race.maxParticipants == null) return Infinity;
    const accepted = await db.raceParticipant.count({
      where: { raceId: race.id, status: "ACCEPTED" },
    });
    return Math.max(0, race.maxParticipants - accepted);
  }

  async function remainingCapacities(races) {
    if (!races.length) return new Map();
    if (typeof db.raceParticipant.groupBy !== "function") {
      return new Map(await Promise.all(races.map(async (race) => [
        race.id,
        await remainingCapacity(race),
      ])));
    }
    const counts = await db.raceParticipant.groupBy({
      by: ["raceId"],
      where: {
        raceId: { in: races.map((race) => race.id) },
        status: "ACCEPTED",
      },
      _count: { _all: true },
    });
    const acceptedByRaceId = new Map(
      counts.map((row) => [row.raceId, row._count._all]),
    );
    return new Map(races.map((race) => [
      race.id,
      race.maxParticipants == null
        ? Infinity
        : Math.max(0, race.maxParticipants - (acceptedByRaceId.get(race.id) || 0)),
    ]));
  }

  // Mirror of joinRaceCore's maybeGrantOnboardingBoxes, minus the
  // firstRaceOnboardingSeen write (see header). Same ledger, same exactly-once
  // guarantee, same deferred POWERUP_EARNED emits.
  async function grantWelcomeBoxes({ user, race, participant }) {
    const earnedEvents = [];
    try {
      if (!race || race.powerupsEnabled !== true) return;

      const providerSub = user.appleId || user.googleSub || null;
      const appleSubHash = hashSub(providerSub);
      if (!appleSubHash) return;

      const slots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;
      const boxesToGrant = Math.min(WELCOME_BOXES, slots);
      if (boxesToGrant <= 0) return;

      await db.$transaction(async (tx) => {
        await tx.onboardingBoxGrant.create({ data: { appleSubHash } });

        for (let i = 0; i < boxesToGrant; i++) {
          const powerup = await tx.racePowerup.create({
            data: {
              raceId: race.id,
              participantId: participant.id,
              userId: user.id,
              type: null,
              rarity: null,
              status: "MYSTERY_BOX",
              earnedAtSteps: i,
            },
          });
          earnedEvents.push({
            raceId: race.id,
            userId: user.id,
            powerupId: powerup.id,
          });
        }
      });
    } catch (error) {
      // P2002 = this human already got their welcome boxes under a prior
      // account (reinstall). Anything else is logged and swallowed.
      if (!error || error.code !== "P2002") {
        console.warn(
          `Welcome box grant skipped: ${error && error.message ? error.message : error}`
        );
      }
      return;
    }
    for (const payload of earnedEvents) {
      events.emit("POWERUP_EARNED", payload);
    }
  }

  return async function autoEnrollNewUser({ user }) {
    try {
      if (!user || !user.id) return;
      // Review/demo accounts stay out of real races entirely.
      if (user.isReviewAccount === true) return;

      await db.user.update({
        where: { id: user.id },
        data: { autoJoinFeaturedRaces: true },
      });

      // New signups must see the currently running Daily/Weekly challenge.
      // Active bucket races are already finalized cohorts, so adding a
      // newcomer does not change bucket identity or repack existing members;
      // it is the required late-onboarding path. Keep future PENDING bucket
      // races excluded: those users must enter through the next-window
      // election so skill/friendship matching remains intact.
      const races = await db.race.findMany({
        where: {
          seedId: { not: null },
          OR: [
            // The current private cohort is the only active target. Legacy
            // global seeded races must not receive cohort onboarding users.
            { status: "ACTIVE", seededBucketId: { not: null } },
            { status: "PENDING", seededBucketId: null },
          ],
        },
        orderBy: { startedAt: "desc" },
        include: { seed: { select: { kind: true, cadence: true } } },
      });

      let welcomeTarget = null;
      let joinedCount = 0;

      // Keep dependency-injected callers that return the historical compact
      // race shape working; real Prisma rows always include `seed` above.
      if (!races.some((race) => race.seed?.cadence)) {
        for (const race of races) {
          if ((await remainingCapacity(race)) <= 0) continue;
          try {
            const participant = await createAcceptedParticipant(race, user.id);
            joinedCount += 1;
            if (!welcomeTarget && race.status === "ACTIVE") {
              welcomeTarget = { race, participant };
            }
          } catch (error) {
            if (error?.code === "FUNDED_EXPOSURE_LIMIT") continue;
            if (!error || error.code !== "P2002") throw error;
          }
        }
      } else {
        // A signup gets exactly one race for each cadence. Re-read and retry
        // the least-full ordering because selection is optimistic: another
        // signup can claim the same last slot before this user's C0 lock.
        for (const cadence of ["DAILY", "WEEKLY"]) {
          let cadenceJoined = false;
          for (let attempt = 0; attempt < 8 && !cadenceJoined; attempt += 1) {
            const candidates = attempt === 0
              ? races.filter((race) => race.seed?.cadence === cadence)
              : await db.race.findMany({
                  where: {
                    seedId: { not: null },
                    seed: { cadence },
                    OR: [
                      { status: "ACTIVE", seededBucketId: { not: null } },
                      { status: "PENDING", seededBucketId: null },
                    ],
                  },
                  orderBy: { startedAt: "desc" },
                  include: { seed: { select: { kind: true, cadence: true } } },
                });
            const activeCandidates = candidates.filter(
              (race) => race.status === "ACTIVE" && race.seededBucketId != null,
            );
            const capacityByRaceId = await remainingCapacities(activeCandidates);
            const ordered = activeCandidates
              .map((race) => ({
                race,
                capacity: capacityByRaceId.get(race.id) ?? 0,
              }))
              .filter((row) => row.capacity > 0)
              .sort((a, b) =>
                b.capacity - a.capacity ||
                new Date(b.race.startedAt || 0) - new Date(a.race.startedAt || 0) ||
                String(a.race.id).localeCompare(String(b.race.id))
              );

            for (const { race } of ordered) {
              try {
                const participant = await createAcceptedParticipant(race, user.id);
                joinedCount += 1;
                cadenceJoined = true;
                if (!welcomeTarget) welcomeTarget = { race, participant };
                break;
              } catch (error) {
                if (["RACE_FULL", "RACE_NOT_JOINABLE"].includes(error?.code)) {
                  continue;
                }
                if (error?.code === "FUNDED_EXPOSURE_LIMIT") break;
                if (error?.code === "P2002") {
                  joinedCount += 1;
                  cadenceJoined = true;
                  break;
                }
                throw error;
              }
            }
            if (cadenceJoined) break;

            if (activeCandidates.length) {
              try {
                const overflow = await createOverflowParticipant(
                  activeCandidates[0],
                  user.id,
                );
                joinedCount += 1;
                cadenceJoined = true;
                if (!welcomeTarget) welcomeTarget = overflow;
                break;
              } catch (error) {
                if (error?.code === "OVERFLOW_RETRY") continue;
                if (error?.code === "FUNDED_EXPOSURE_LIMIT") break;
                if (error?.code === "P2002") {
                  joinedCount += 1;
                  cadenceJoined = true;
                  break;
                }
                // Renewal can close this cadence between the optimistic list
                // read and the authoritative overflow check. Exhaust only
                // this active source so pending fallback and the other
                // cadence still get a chance.
                if (error?.code !== "RACE_NOT_JOINABLE") throw error;
              }
            }

            const pending = candidates.find(
              (race) => race.status === "PENDING" && race.seededBucketId == null,
            );
            if (pending) {
              try {
                await createAcceptedParticipant(pending, user.id);
                joinedCount += 1;
                cadenceJoined = true;
              } catch (error) {
                if (error?.code === "FUNDED_EXPOSURE_LIMIT") break;
                if (error?.code === "P2002") {
                  joinedCount += 1;
                  cadenceJoined = true;
                  break;
                }
                if (!["RACE_FULL", "RACE_NOT_JOINABLE"].includes(error?.code)) {
                  throw error;
                }
              }
            }
            break;
          }
        }
      }

      // CAPACITY RELAXATION (onboarding revamp §5.6) remains only for legacy
      // seeded races. A private cohort's maxParticipants is now a hard product
      // and payout boundary, so onboarding must never push one past its cap.
      //
      // If there is no ACTIVE seeded race at all, keep the legacy fallback;
      // private bucket windows use the capped overflow path above.
      if (joinedCount === 0) {
        const fallback = races.find(
          (race) => race.status === "ACTIVE" && race.seededBucketId == null,
        );
        if (fallback) {
          try {
            const participant = await createAcceptedParticipant(fallback, user.id, {
              allowOverCapacity: true,
            });
            joinedCount += 1;
            welcomeTarget = { race: fallback, participant };
            console.warn(
              `AUTO_ENROLL_OVER_CAPACITY: every seeded race was full; enrolled user=${user.id} into race=${fallback.id} over its ${fallback.maxParticipants} cap`
            );
          } catch (error) {
            if (error?.code !== "FUNDED_EXPOSURE_LIMIT") {
              if (!error || error.code !== "P2002") throw error;
              joinedCount += 1;
            }
          }
        }
      }

      // Distinctive, greppable alarm (§5.6). If this shows up in prod logs the
      // seed reconciler is broken, not this function.
      if (joinedCount === 0) {
        console.warn(
          `AUTO_ENROLL_EMPTY: signup enrolled in zero races user=${user.id} seededRaceCount=${races.length}`
        );
      }

      if (welcomeTarget) {
        await grantWelcomeBoxes({
          user,
          race: welcomeTarget.race,
          participant: welcomeTarget.participant,
        });
      }
    } catch (error) {
      console.warn(
        `Signup starter-race enrollment skipped: ${
          error && error.message ? error.message : error
        }`
      );
    }
  };
}

const autoEnrollNewUser = buildAutoEnrollNewUser();

module.exports = { buildAutoEnrollNewUser, autoEnrollNewUser };
