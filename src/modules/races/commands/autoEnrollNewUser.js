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
  lockCompetitionRows,
} = require("../services/raceWriteFence");

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
        select: { status: true, maxParticipants: true },
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
        !allowOverCapacity &&
        lockedRace.maxParticipants != null &&
        acceptedCount >= lockedRace.maxParticipants
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

  async function remainingCapacity(race) {
    if (race.maxParticipants == null) return Infinity;
    const accepted = await db.raceParticipant.count({
      where: { raceId: race.id, status: "ACCEPTED" },
    });
    return Math.max(0, race.maxParticipants - accepted);
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

      // seededBucketId: null excludes private bucket cohorts. A bucket is
      // skill/friendship-matched by the election+finalise flow; a brand-new
      // signup dropped straight in bypasses that matching and the cohort's
      // privacy boundary entirely (confirmed in prod 2026-08-15: two signups
      // landed in a 3-person private cohort seconds after account creation).
      // Legacy/global seeded races have no such invariant to protect.
      const races = await db.race.findMany({
        where: {
          seedId: { not: null },
          seededBucketId: null,
          status: { in: ["ACTIVE", "PENDING"] },
        },
        orderBy: { startedAt: "desc" },
      });

      let welcomeTarget = null;
      let joinedCount = 0;
      for (const race of races) {
        const capacity = await remainingCapacity(race);
        if (capacity <= 0) continue;
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

      // CAPACITY RELAXATION (onboarding revamp §5.6). A full seeded race is a
      // soft product constraint; a signup that lands in ZERO races is a
      // dead-on-arrival account that nothing later recovers. So when the loop
      // above joined nothing, put the user into the most recently started ACTIVE
      // seeded race anyway, over capacity. `races` is already ordered
      // startedAt desc, so the first ACTIVE row is that race.
      //
      // Deliberately NOT a race-minting fallback: a persistent seed
      // misconfiguration would then create unbounded races. If there is no
      // ACTIVE seeded race at all we log and leave the user in nothing.
      if (joinedCount === 0) {
        const fallback = races.find((race) => race.status === "ACTIVE");
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
