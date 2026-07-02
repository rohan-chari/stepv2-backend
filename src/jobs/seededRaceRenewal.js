const { prisma: defaultPrisma } = require("../db");
const { eventBus } = require("../events/eventBus");
const { buildAutoJoinFeaturedRaces } = require("../commands/autoJoinFeaturedRaces");
const {
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
} = require("../utils/week");

// Tight cadence so the midnight promote/settle handoff gap is small: at 00:00 ET
// the just-expired race is filtered out of Featured while the next race is still
// PENDING until this job promotes it. One minute keeps that window <= ~1 min.
const RENEWAL_INTERVAL_MS = 60 * 1000;

// Canonical timezone for seeded daily/weekly challenges. Their day boundaries
// (and thus "midnight") are defined here for every participant, globally.
const SEED_TIMEZONE = "America/New_York";

function buildRenewSeededRaces(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const events = dependencies.eventBus || eventBus;
  const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma });

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
    return prisma.race.create({
      data: {
        seedId: seed.id,
        creatorId: null,
        name: seed.name,
        targetSteps: seed.targetSteps,
        status,
        isPublic: true,
        maxParticipants: seed.maxParticipants,
        powerupsEnabled: seed.powerupsEnabled ?? false,
        powerupStepInterval: seed.powerupStepInterval ?? null,
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
        name: true,
        status: true,
        startedAt: true,
        endsAt: true,
        scheduledStartAt: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
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

  // Flip a due PENDING seeded race to ACTIVE. Deliberately NOT startRace: that
  // path requires creatorId===userId (seeded races have none), >=2 accepted
  // participants (a daily race must start even with 0-1 opt-ins), and computes
  // endsAt as +N*24h (wrong on DST days). Here startedAt = the scheduled midnight
  // and endsAt is the pre-computed exact next-midnight from creation.
  async function promoteSeededRace(seed, race) {
    const startedAt = race.scheduledStartAt
      ? new Date(race.scheduledStartAt)
      : now();
    const data = { status: "ACTIVE", startedAt };
    // Defensive: recompute endsAt if a PENDING race was created without one.
    if (!race.endsAt) {
      data.endsAt = windowFor(seed, startedAt).endsAt;
    }
    await prisma.race.update({ where: { id: race.id }, data });

    const accepted = await prisma.raceParticipant.findMany({
      where: { raceId: race.id, status: "ACCEPTED" },
      select: { id: true, userId: true, nextBoxAtSteps: true },
    });

    // Initialize the first powerup-box threshold for opt-ins (idempotent).
    if (race.powerupsEnabled && race.powerupStepInterval) {
      for (const p of accepted) {
        if (!p.nextBoxAtSteps) {
          await prisma.raceParticipant.update({
            where: { id: p.id },
            data: { nextBoxAtSteps: race.powerupStepInterval },
          });
        }
      }
    }

    // "Your race started" push to everyone who opted in. creatorUserId null =>
    // the RACE_STARTED handler notifies every accepted participant.
    events.emit("RACE_STARTED", {
      raceId: race.id,
      raceName: race.name,
      creatorUserId: null,
      participantUserIds: accepted.map((p) => p.userId),
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

    // 1) Promote a PENDING race whose scheduled start has passed.
    const pending = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "PENDING" },
      orderBy: { scheduledStartAt: "asc" },
    });
    if (
      pending &&
      pending.scheduledStartAt &&
      new Date(pending.scheduledStartAt).getTime() <= nowMs
    ) {
      const race = await promoteSeededRace(seed, pending);
      results.push({ action: "promoted", seedKind: seed.kind, race });
    }

    // 2) Ensure an ACTIVE race covers `now`. (After a promotion the promoted race
    // covers it, so this is a no-op; it only creates on a true gap / cold start.)
    const active = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "ACTIVE" },
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
      await autoEnroll(seed, race);
      results.push({ action: "created-active", seedKind: seed.kind, race });
    }

    // 3) Ensure exactly one upcoming PENDING race exists for the next window.
    const upcoming = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "PENDING" },
      orderBy: { scheduledStartAt: "desc" },
    });
    if (!upcoming) {
      const next = windowFor(seed, current.endsAt);
      const race = await createSeededRace(seed, {
        status: "PENDING",
        startedAt: null,
        scheduledStartAt: next.startedAt,
        endsAt: next.endsAt,
      });
      await autoEnroll(seed, race);
      results.push({ action: "created-upcoming", seedKind: seed.kind, race });
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
