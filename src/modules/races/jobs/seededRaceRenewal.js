const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { appSettings } = require("../../../shared/config/appSettings");
const { buildAutoJoinFeaturedRaces } = require("../commands/autoJoinFeaturedRaces");
const { buildSeededRaceBuckets, stampWindowMode, readWindowMode } = require("../services/seededRaceBuckets");
const { normalizePowerupConfig } = require("../services/validateRaceConfig");
const {
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
  getTimeZoneParts,
  formatDateString,
} = require("../../../shared/time/week");
const { JobRun } = require("../../../shared/db/jobRun");
const {
  filterInactiveUserIds,
  findUsersWithActivitySince,
  disableAutoEnrollForInactive,
} = require("../services/seededInactivity");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
const {
  acquireGlobalEnrollmentLock,
  enrollIfGlobalEventActive,
} = require("../../steps/services/globalEventEnrollment");
const {
  isFundedPrizeV2Enabled,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  resolveRacePrizeStamp,
} = require("../services/fundedExposure");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("../services/raceWriteFence");

// Tight cadence so the midnight promote/settle handoff gap is small: at 00:00 ET
// the just-expired race is filtered out of Featured while the next race is still
// PENDING until this job promotes it. One minute keeps that window <= ~1 min.
const RENEWAL_INTERVAL_MS = 60 * 1000;

// Canonical timezone for seeded daily/weekly challenges. Their day boundaries
// (and thus "midnight") are defined here for every participant, globally.
const SEED_TIMEZONE = "America/New_York";

// ET hour the weekly mid-race ghost sweep is allowed to run (spec §4.3 Hook 3).
// Aligned with the retention job's quiet window; the exact hour isn't load-bearing.
const WEEKLY_SWEEP_HOUR_ET = 3;

function buildRenewSeededRaces(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const events = dependencies.eventBus || eventBus;
  const settings = dependencies.appSettings || appSettings;
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  // Pass the cron's logger down: the enrollment filter is a prune hook too
  // (hook 1), and its inactivity/auto-enroll-flip logging belongs in the same
  // stream as this job's, not on the default console.
  const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma, logger });
  const seededBuckets = buildSeededRaceBuckets({ prisma, now });
  const acquireWriteFence =
    dependencies.acquireRaceWriteFence || (async (tx, raceId) => (
      typeof tx.$queryRawUnsafe === "function"
        ? acquireRaceWriteFence(tx, raceId)
        : null
    ));
  const lockUsers =
    dependencies.lockFundedExposureUsers || (async (tx, userIds) => (
      tx.fundedExposureGuard
        ? lockFundedExposureUsers(tx, userIds)
        : userIds
    ));
  const lockCompetitions =
    dependencies.lockCompetitionRows || (async (tx, competitionIds) => (
      typeof tx.$queryRawUnsafe === "function"
        ? lockCompetitionRows(tx, competitionIds)
        : []
    ));

  function runTransaction(callback) {
    return typeof prisma.$transaction === "function"
      ? prisma.$transaction(callback, { timeout: 15_000, maxWait: 10_000 })
      : callback(prisma);
  }

  async function acquireMembershipLocks(tx, raceId, userIds, at = now()) {
    await acquireWriteFence(tx, raceId, at);
    await acquireGlobalEnrollmentLock(tx);
    await lockUsers(tx, [...new Set(userIds.filter(Boolean))].sort());
    await lockCompetitions(tx, { raceIds: [raceId] });
  }

  // The [start, end) UTC instants of the calendar period containing `fromDate`
  // in the seed's cadence: a single ET day (daily) or Mon 00:00 -> Mon 00:00 ET
  // (weekly). DST-exact via the tz helpers.
  function windowFor(seed, fromDate) {
    if (seed.cadence === "WEEKLY") {
      return {
        startedAt: startOfWeekNewYork(fromDate, SEED_TIMEZONE),
        endsAt: nextWeekStartNewYork(fromDate, SEED_TIMEZONE),
      };
    }
    return {
      startedAt: startOfDayNewYork(fromDate, SEED_TIMEZONE),
      endsAt: nextMidnightNewYork(fromDate, SEED_TIMEZONE),
    };
  }

  async function createSeededRace(seed, { status, startedAt, endsAt, scheduledStartAt }) {
    const durationHours =
      seed.durationHours || (seed.cadence === "WEEKLY" ? 168 : 24);
    // App-funded prize pools (D5/D8): seeded challenges move onto the pool
    // formula and pay TOP_HALF (even shares), so a 300-player Daily spreads the
    // capped pool across 150 finishers instead of handing it to one winner (the
    // DB default is WINNER_TAKES_ALL). Gated on the kill switch: while it is off
    // the races stay legacy (fundedPrize false) and keep minting today's graded
    // raceFinishReward.
    const fundedPrizePools = await settings.getFlag("fundedPrizePoolsEnabled");
    const payoutRoundingV1Enabled = await settings.getFlag(
      "payoutRoundingV1Enabled",
    );
    // Top-heavy payouts are STAMPED here and nowhere else: read paths and
    // settlement consult the column, so flipping the flag later can only change
    // what FUTURE races advertise, never an in-flight or historical one.
    const geometricPayouts = await settings.getFlag(
      "seededGeometricPayoutsEnabled"
    );
    const prizeStamp = isFundedPrizeV2Enabled()
      ? newRacePrizeStamp()
      : resolveRacePrizeStamp({ prizeCalculationVersion: 1 });
    // NOTE (batch 2026-08-08 item 5): this path bypasses raceModel.create, so
    // it does NOT stamp team_pool_mult_bps — correct, because a seeded
    // Daily/Weekly is never a team race (isTeamRace stays at the schema default
    // false) and the team payout buff is a team-mode incentive only. The column
    // stays NULL = 1.0. If seeded TEAM challenges are ever introduced, this
    // create must call resolveTeamPoolMultBps like createRace does.
    return prisma.race.create({
      data: {
        payoutPreset: "TOP_HALF",
        payoutCurve: geometricPayouts === true ? "GEOMETRIC" : null,
        fundedPrize: fundedPrizePools === true,
        prizeCalculationVersion: prizeStamp.prizeCalculationVersion,
        prizeCoinUnit:
          prizeStamp.prizeCalculationVersion >= 2
            ? prizeStamp.prizeCoinUnit
            : null,
        prizePoolMaxCoins:
          prizeStamp.prizeCalculationVersion >= 2
            ? prizeStamp.prizePoolMaxCoins
            : null,
        payoutRoundingVersion: payoutRoundingV1Enabled === true ? 1 : 0,
        seedId: seed.id,
        creatorId: null,
        name: seed.name,
        targetSteps: seed.targetSteps,
        status,
        isPublic: true,
        maxParticipants: seed.maxParticipants,
        powerupsEnabled: seed.powerupsEnabled ?? false,
        // The seed's own powerup_step_interval column is no longer read: every
        // seeded challenge runs the fixed 2,000-step cadence like every other
        // race. (Prod seeds still hold 2500; harmless, just ignored.)
        powerupStepInterval: normalizePowerupConfig({
          powerupsEnabled: seed.powerupsEnabled ?? false,
        }),
        timeBased: seed.timeBased ?? false,
        timezone: SEED_TIMEZONE,
        // PENDING "next" races keep startedAt NULL until promotion so they can
        // never shadow the live race in getFeaturedRaces' most-recently-started
        // tiebreak; the start instant lives in scheduledStartAt.
        startedAt,
        endsAt,
        scheduledStartAt,
        maxDurationDays: Math.max(1, Math.ceil(durationHours / 24)),
      },
      select: {
        id: true,
        seedId: true,
        name: true,
        status: true,
        startedAt: true,
        endsAt: true,
        scheduledStartAt: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
        fundedPrize: true,
        maxDurationDays: true,
        prizeCoinUnit: true,
        prizePoolMaxCoins: true,
        prizeCalculationVersion: true,
      },
    });
  }

  // Enroll every opted-in user (users.auto_join_featured_races) into a race
  // this tick just created. Best-effort: a failure must never break race
  // creation, or Featured would show no challenge at all. The created-race
  // select omits maxParticipants, so the cap comes from the seed.
  async function autoEnroll(seed, race) {
    try {
      const joined = await enrollAutoJoinUsers({
        id: race.id,
        maxParticipants: seed.maxParticipants,
        seedId: race.seedId,
        startedAt: race.startedAt,
        scheduledStartAt: race.scheduledStartAt,
      });
      if (joined > 0) {
        logger.log(
          `[CRON] Auto-joined ${joined} user(s) into seeded race ${race.id} (${seed.kind})`
        );
      }
    } catch (error) {
      logger.error(`[CRON] Auto-join enrollment failed for ${seed.kind}:`, error);
    }
  }

  // Batch 2026-08-10 item 1: turn auto-enroll off for the ghosts this tick just
  // pruned (boxless ones only — the service decides). ALWAYS called after the
  // hook's own deleteMany and ALWAYS swallowing: each hook's outer catch changes
  // what the prune returns, so a flip failure must never reach it.
  async function flipAutoEnroll(userIds, nowDate, where) {
    try {
      await disableAutoEnrollForInactive({
        userIds,
        now: nowDate,
        prisma,
        appSettings: settings,
        logger,
      });
    } catch (error) {
      logger.error(`[CRON] Auto-enroll flip failed (${where}):`, error);
    }
  }

  // Hook 2 (spec §4.3): drop every 2-day-zero ACCEPTED participant from a
  // seeded race, regardless of how they joined (D3). Runs while the race is
  // still PENDING so soon-pruned users are never briefly live.
  //
  // deleteMany, not per-row delete: a pm2-cluster double-promotion must be a
  // silent no-op the second time, not a P2025. Fail-open — the challenge
  // running matters more than the prune.
  async function pruneInactiveParticipants(race) {
    try {
      if ((await settings.getFlag("seededInactivityPruneEnabled")) !== true) {
        return 0;
      }
      const accepted = await prisma.raceParticipant.findMany({
        where: { raceId: race.id, status: "ACCEPTED" },
        select: { userId: true },
      });
      if (accepted.length === 0) return 0;

      const inactive = await filterInactiveUserIds({
        userIds: accepted.map((p) => p.userId),
        now: now(),
        raceCreatedAt: race.createdAt,
        prisma,
      });
      if (inactive.size === 0) return 0;

      const inactiveIds = [...inactive].sort();
      const count = await runTransaction(async (tx) => {
        await acquireMembershipLocks(tx, race.id, inactiveIds);
        const lockedRace = await tx.race.findUnique({
          where: { id: race.id },
          select: { status: true, seededBucketId: true },
        });
        if (!lockedRace || lockedRace.status !== "PENDING") return 0;
        const participantWhere = {
          raceId: race.id,
          status: "ACCEPTED",
          userId: { in: inactiveIds },
        };
        // Assignment rows intentionally retain their exact participant pointer
        // as the audit of the immutable plan. A private bucket therefore prunes
        // by revoking the participant instead of deleting it (the FK stays valid
        // and the row no longer occupies an ACCEPTED slot); legacy races retain
        // their historical delete semantics.
        if (lockedRace.seededBucketId) {
          await tx.seededRaceBucketAssignment.updateMany({
            where: {
              bucketId: lockedRace.seededBucketId,
              userId: { in: inactiveIds },
            },
            data: { state: "PRUNED" },
          });
          return (await tx.raceParticipant.updateMany({
            where: participantWhere,
            data: { status: "DECLINED" },
          })).count;
        }
        return (await tx.raceParticipant.deleteMany({
          where: participantWhere,
        })).count;
      });
      if (count > 0) {
        logger.log(
          `[CRON] Pruned ${count} inactive participant(s) from seeded race ${race.id}`
        );
      }
      await flipAutoEnroll(inactiveIds, now(), "promotion prune");
      return count;
    } catch (error) {
      logger.error(`[CRON] Inactivity prune failed for race ${race.id}:`, error);
      return 0;
    }
  }

  // Hook 3 (spec §4.3, D4): once per ET day, sweep the ACTIVE weekly's ghosts —
  // participants who are 2-day-zero AND have walked nothing at all in the race
  // so far. A competitor who walked early in the week then rested keeps their
  // earned position, so the guard is deliberately stricter than the predicate.
  async function sweepWeeklyGhosts(race, nowDate) {
    try {
      if ((await settings.getFlag("seededInactivityPruneEnabled")) !== true) {
        return 0;
      }
      const parts = getTimeZoneParts(nowDate, SEED_TIMEZONE);
      if (parts.hour < WEEKLY_SWEEP_HOUR_ET) return 0;
      const dayKey = formatDateString(parts.year, parts.month, parts.day);
      // Atomic CAS across the pm2 cluster. Never markRan (read-then-upsert lets
      // two workers both proceed) and never an advisory lock held across this.
      if (!(await JobRun.claimRun(`seeded_weekly_sweep:${race.id}`, dayKey))) {
        return 0;
      }

      const candidates = await prisma.raceParticipant.findMany({
        where: { raceId: race.id, status: "ACCEPTED", totalSteps: { lte: 0 } },
        select: { userId: true },
      });
      if (candidates.length === 0) return 0;

      const inactive = await filterInactiveUserIds({
        userIds: candidates.map((p) => p.userId),
        now: nowDate,
        raceCreatedAt: race.createdAt,
        prisma,
      });
      if (inactive.size === 0) return 0;

      // Every exit below flips (batch 2026-08-10 item 1) — the delete guards
      // that follow are about what is safe to REMOVE mid-race, not about who is
      // still playing the game, so a ghost spared by them still loses
      // auto-enroll. try/finally rather than a call before each `return` so a
      // future early exit cannot silently skip it. The flip's input is the
      // inactivity predicate's output, exactly as in the other two hooks, and
      // flipAutoEnroll never throws, so this cannot mask the sweep's result.
      try {
        // Ghost guard: persisted totalSteps can lag, so confirm against the raw
        // step data for the race window before removing anyone.
        const walked = await findUsersWithActivitySince({
          userIds: [...inactive],
          since: race.startedAt,
          prisma,
        });

        // Side-effect guard: a participant holding a powerup — or caught up in an
        // active effect as caster or target — is skipped. Deleting their row
        // cascades RacePowerup and, through it, RaceActiveEffect rows that may be
        // scoring OTHER participants (RaceActiveEffect.sourceUserId carries no FK,
        // so the cascade travels via the caster's powerup rows).
        const remaining = [...inactive].filter((id) => !walked.has(id));
        if (remaining.length === 0) return 0;
        const count = await runTransaction(async (tx) => {
          await acquireMembershipLocks(tx, race.id, remaining, nowDate);
          const lockedRace = await tx.race.findUnique({
            where: { id: race.id },
            select: { status: true, seededBucketId: true },
          });
          if (!lockedRace || lockedRace.status !== "ACTIVE") return 0;
          const powerups = await tx.racePowerup.findMany({
            where: { raceId: race.id, userId: { in: remaining } },
            select: { userId: true },
          });
          const effects = await tx.raceActiveEffect.findMany({
            where: {
              raceId: race.id,
              OR: [
                { targetUserId: { in: remaining } },
                { sourceUserId: { in: remaining } },
              ],
            },
            select: { targetUserId: true, sourceUserId: true },
          });
          const entangled = new Set(powerups.map((p) => p.userId));
          for (const effect of effects) {
            entangled.add(effect.targetUserId);
            entangled.add(effect.sourceUserId);
          }
          const doomed = remaining.filter((id) => !entangled.has(id));
          if (doomed.length === 0) return 0;
          const participantWhere = {
            raceId: race.id,
            status: "ACCEPTED",
            userId: { in: doomed },
          };
          if (lockedRace.seededBucketId) {
            await tx.seededRaceBucketAssignment.updateMany({
              where: {
                bucketId: lockedRace.seededBucketId,
                userId: { in: doomed },
              },
              data: { state: "PRUNED" },
            });
            return (await tx.raceParticipant.updateMany({
              where: participantWhere,
              data: { status: "DECLINED" },
            })).count;
          }
          return (await tx.raceParticipant.deleteMany({
            where: participantWhere,
          })).count;
        });
        if (count > 0) {
          logger.log(
            `[CRON] Weekly sweep removed ${count} ghost(s) from race ${race.id}`
          );
        }
        return count;
      } finally {
        await flipAutoEnroll([...inactive], nowDate, "weekly sweep");
      }
    } catch (error) {
      logger.error(`[CRON] Weekly sweep failed for race ${race.id}:`, error);
      return 0;
    }
  }

  // Flip a due PENDING seeded race to ACTIVE. Deliberately NOT startRace: that
  // path requires creatorId===userId (seeded races have none), >=2 accepted
  // participants (a daily race must start even with 0-1 opt-ins), and computes
  // endsAt as +N*24h (wrong on DST days). Here startedAt = the scheduled midnight
  // and endsAt is the pre-computed exact next-midnight from creation.
  async function promoteSeededRace(seed, race) {
    // BEFORE the ACTIVE flip: the pruned rows never exist on a live race, so no
    // step sync, featured read, or box init can race them.
    await pruneInactiveParticipants(race);

    const startedAt = race.scheduledStartAt
      ? new Date(race.scheduledStartAt)
      : now();
    const data = { status: "ACTIVE", startedAt };
    // Defensive: recompute endsAt if a PENDING race was created without one.
    if (!race.endsAt) {
      data.endsAt = windowFor(seed, startedAt).endsAt;
    }
    // One cron worker owns promotion. The compare-and-swap prevents a second
    // process that read the same PENDING row from duplicating box init and
    // RACE_STARTED push fanout.
    const accepted = await runTransaction(async (tx) => {
      // Universal membership/lifecycle order: C0, global event, sorted user
      // guards, then the competition row. The optimistic user discovery is
      // stable after C0 because every membership writer shares that fence.
      await acquireWriteFence(tx, race.id, startedAt);
      await acquireGlobalEnrollmentLock(tx);
      const discoveredParticipants = await tx.raceParticipant.findMany({
        where: { raceId: race.id, status: "ACCEPTED" },
        select: { userId: true },
      });
      await lockUsers(
        tx,
        discoveredParticipants.map((participant) => participant.userId),
      );
      await lockCompetitions(tx, { raceIds: [race.id] });
      const locked = typeof tx.race.findUnique === "function"
        ? await tx.race.findUnique({
            where: { id: race.id },
            select: { status: true },
          })
        : await tx.race.findFirst({
            where: { seedId: race.seedId, status: "PENDING" },
            orderBy: { scheduledStartAt: "asc" },
          });
      if (
        !locked ||
        locked.status !== "PENDING" ||
        (locked.id && locked.id !== race.id)
      ) return null;
      const transition = typeof tx.race.updateMany === "function"
        ? await tx.race.updateMany({
            where: { id: race.id, status: "PENDING" },
            data,
          })
        : { count: 1, ...(await tx.race.update({ where: { id: race.id }, data })) };
      if (transition.count !== 1) return null;
      if (race.seededBucketId && tx.seededRaceBucket) {
        await tx.seededRaceBucket.updateMany({
          where: { id: race.seededBucketId, status: "PENDING" },
          data: { status: "ACTIVE" },
        });
      }
      const rows = await tx.raceParticipant.findMany({
        where: { raceId: race.id, status: "ACCEPTED" },
        select: { id: true, userId: true, nextBoxAtSteps: true },
      });
      if (race.powerupsEnabled && race.powerupStepInterval) {
        for (const p of rows) {
          if (!p.nextBoxAtSteps) {
            await tx.raceParticipant.update({
              where: { id: p.id },
              data: { nextBoxAtSteps: race.powerupStepInterval },
            });
          }
        }
      }
      await enrollIfGlobalEventActive(tx, {
        raceId: race.id,
        userIds: rows.map((participant) => participant.userId),
        at: now(),
      });
      await enqueueRaceResolution({
        raceId: race.id,
        reason: "RACE_START",
        priority: "IMMEDIATE",
      }, tx);
      return rows;
    });
    if (!accepted) return null;

    // "Your race started" push to everyone who opted in. creatorUserId null =>
    // the RACE_STARTED handler notifies every accepted participant.
    events.emit("RACE_STARTED", {
      raceId: race.id,
      raceName: race.name,
      creatorUserId: null,
      participantUserIds: accepted.map((p) => p.userId),
      isSeededBucket: Boolean(race.seededBucketId),
    });
    return {
      id: race.id,
      name: race.name,
      startedAt,
      endsAt: race.endsAt || data.endsAt,
    };
  }

  // Idempotent per-seed reconcile: at steady state this is read-only.
  async function reconcileSeed(seed, results) {
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const current = windowFor(seed, nowDate);

    // Buckets finalise once, inside their own advisory-locked transaction, in a
    // short deterministic pre-boundary window. This never affects historical
    // legacy/global rows and fails closed if matching cannot complete.
    if (["DAILY_10K", "WEEKLY_50K"].includes(seed.kind)) {
      const next = windowFor(seed, current.endsAt);
      if (next.startedAt.getTime() - nowMs <= 5 * 60 * 1000) {
        const buckets = await seededBuckets.finalise({
          seed,
          windowStart: next.startedAt,
          windowEnd: next.endsAt,
        });
        if (buckets.length) results.push({ action: "finalized-buckets", seedKind: seed.kind, race: { id: buckets[0].raceId, endsAt: next.endsAt } });
      }
    }

    // 1) Promote every due PENDING race. A legacy seed has at most one, while
    // the private stream can have many finalized buckets for the same window.
    // Do not use findFirst here: leaving later bucket rows PENDING would strand
    // their members even though the boundary has passed.
    // The fallback preserves the narrow injected Prisma doubles used by the
    // long-standing lifecycle unit tests. Production always exposes findMany
    // and therefore promotes every due bucket.
    const pending = typeof prisma.race.findMany === "function"
      ? await prisma.race.findMany({
          where: {
            seedId: seed.id,
            status: "PENDING",
            scheduledStartAt: { lte: nowDate },
          },
          orderBy: { scheduledStartAt: "asc" },
        })
      : [await prisma.race.findFirst({
          where: { seedId: seed.id, status: "PENDING" },
          orderBy: { scheduledStartAt: "asc" },
        })].filter(
          (race) =>
            race &&
            race.scheduledStartAt &&
            new Date(race.scheduledStartAt).getTime() <= nowMs
        );
    for (const due of pending) {
      const race = await promoteSeededRace(seed, due);
      if (race) results.push({ action: "promoted", seedKind: seed.kind, race });
    }

    // 2) Ensure an ACTIVE race covers `now`. (After a promotion the promoted race
    // covers it, so this is a no-op; it only creates on a true gap / cold start.)
    const active = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "ACTIVE", seededBucketId: null },
      orderBy: { startedAt: "desc" },
    });
    const activeCoversNow =
      active && active.endsAt && new Date(active.endsAt).getTime() > nowMs;
    if (!activeCoversNow) {
      const race = await createSeededRace(seed, {
        status: "ACTIVE",
        startedAt: current.startedAt,
        endsAt: current.endsAt,
        scheduledStartAt: null,
      });
      // A cold-start active window cannot safely be bucketed after its
      // matching cutoff; stamp it legacy rather than consulting the flag on a
      // later read/finalizer pass.
      if (["DAILY_10K", "WEEKLY_50K"].includes(seed.kind)) {
        await stampWindowMode({
          prisma, seedId: seed.id, windowStart: current.startedAt,
          windowEnd: current.endsAt, mode: "LEGACY",
        });
      }
      await autoEnroll(seed, race);
      results.push({ action: "created-active", seedKind: seed.kind, race });
    }

    // 3) Ensure exactly one upcoming PENDING race exists for the next window.
    let upcoming = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "PENDING", seededBucketId: null },
      orderBy: { scheduledStartAt: "desc" },
    });
    if (!upcoming) {
      const next = windowFor(seed, current.endsAt);
      upcoming = await createSeededRace(seed, {
        status: "PENDING",
        startedAt: null,
        scheduledStartAt: next.startedAt,
        endsAt: next.endsAt,
      });
      results.push({ action: "created-upcoming", seedKind: seed.kind, race: upcoming });
    }
    // 3b) Mode-stamp + automatic bucket election, retried on EVERY tick (not
    // just the one that created the race). A single failed tick used to
    // permanently strand every auto-join user who was eligible at that
    // instant — electAutomatic() only ever ran once per window, with no
    // retry, so a transient DB hiccup (e.g. connection-pool exhaustion) on
    // that one tick silently dropped the whole day's cohort. Both calls are
    // idempotent (stampWindowMode is a write-once upsert; electAutomatic
    // re-checks mode/finalized/already-taken and skips users already swept),
    // so re-running them every minute until the window closes just backfills
    // whoever a prior tick missed.
    if (["DAILY_10K", "WEEKLY_50K"].includes(seed.kind)) {
      const next = windowFor(seed, current.endsAt);
      if (nowMs < next.startedAt.getTime()) {
        const mode = (await settings.getFlag("seededRaceBucketsEnabled")) === true
          ? "BUCKET"
          : "LEGACY";
        // Write-once: a flag flip after the window's mode is first decided
        // can never retarget it.
        await stampWindowMode({
          prisma, seedId: seed.id, windowStart: next.startedAt,
          windowEnd: next.endsAt, mode,
        });
        const decidedMode = await readWindowMode({
          prisma, seedId: seed.id, windowStart: next.startedAt,
        });
        if (decidedMode === "BUCKET") {
          await seededBuckets.electAutomatic({
            seed, windowStart: next.startedAt, windowEnd: next.endsAt,
          });
        }
      }
    }

    // 3c) Legacy/global enrollment, retried on EVERY tick, not just the one
    // that created the race. enrollAutoJoinUsers is documented idempotent
    // (skipDuplicates / claimLegacyStream dedupe), so this is a no-op once
    // everyone eligible is already in. Previously this only ran once, tied to
    // race creation: a single failed tick (e.g. the connection-pool-exhaustion
    // incident on 2026-08-14) silently and permanently dropped the bulk of
    // that day's auto-join population, who only trickled back in by manually
    // opening the app.
    //
    // ORDERING IS LOAD-BEARING and must stay after 3b. enrollAutoJoinUsers
    // decides whether to exclude bucket-capable accounts by reading the
    // window's durable mode, and readWindowMode's mixed-deploy default is
    // LEGACY. On the tick that CREATES a window there is no mode row yet, so
    // running this first makes it claim every capable user into the write-once
    // LEGACY stream; electAutomatic then finds them all taken and elects
    // nobody. That inversion shipped in a5a3ddb and put the entire capable
    // cohort back in the 450-person global field for the 2026-08-17 and
    // 2026-08-18 windows.
    await autoEnroll(seed, upcoming);

    // 4) Weekly only (D4): sweep the ACTIVE race's ghosts once per ET day. The
    // daily is boundary-only — its field was filtered at enrollment and pruned
    // at promotion hours earlier, with nearly the same window.
    if (seed.cadence === "WEEKLY") {
      const live = await prisma.race.findFirst({
        where: { seedId: seed.id, status: "ACTIVE" },
        orderBy: { startedAt: "desc" },
      });
      if (live) await sweepWeeklyGhosts(live, nowDate);
    }
  }

  return async function renewSeededRaces() {
    const activeSeeds = await prisma.raceSeed.findMany({
      where: { active: true },
    });

    if (activeSeeds.length === 0) return [];

    const results = [];
    for (const seed of activeSeeds) {
      try {
        await reconcileSeed(seed, results);
      } catch (error) {
        logger.error(
          `[CRON] Seeded race reconcile failed for ${seed.kind}:`,
          error
        );
      }
    }

    for (const r of results) {
      logger.log(
        `[CRON] Seeded race ${r.action} for ${r.seedKind}: ${r.race.id}` +
          (r.race.endsAt ? ` (ends ${new Date(r.race.endsAt).toISOString()})` : "")
      );
    }

    return results;
  };
}

const renewSeededRaces = buildRenewSeededRaces();

function scheduleSeededRaceRenewal(dependencies = {}) {
  const interval = dependencies.intervalMs || RENEWAL_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const renewFn = dependencies.renewSeededRaces || renewSeededRaces;

  // Guard against overlapping ticks (a slow run spanning the next interval),
  // which could otherwise double-create the upcoming PENDING race.
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      await renewFn();
    } catch (error) {
      logger.error("[CRON] Seeded race renewal error:", error);
    } finally {
      running = false;
    }
  }

  run();
  setInterval(run, interval);
  logger.log(`[CRON] Seeded race renewal scheduled (every ${interval / 1000}s)`);
}

module.exports = {
  buildRenewSeededRaces,
  renewSeededRaces,
  scheduleSeededRaceRenewal,
  RENEWAL_INTERVAL_MS,
  SEED_TIMEZONE,
};
