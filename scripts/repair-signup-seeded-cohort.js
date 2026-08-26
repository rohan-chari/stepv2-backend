#!/usr/bin/env node
require("dotenv").config();
const { prisma } = require("../src/db");
const {
  windowFor,
  upcomingWindowFor,
  SEED_TIMEZONE,
} = require("../src/modules/races/services/seededRaceBuckets");

const TARGET_CADENCES = ["DAILY", "WEEKLY"];
const TARGET_KIND_BY_CADENCE = Object.freeze({
  DAILY: "DAILY_10K",
  WEEKLY: "WEEKLY_50K",
});

function utcBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    throw new Error("--date must be YYYY-MM-DD");
  }
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error("invalid --date");
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function historicalWindowFor(seed, createdAt) {
  return windowFor(seed, createdAt);
}

function sameInstant(left, right) {
  return new Date(left).getTime() === new Date(right).getTime();
}

function chooseHistoricalRace(bucketRows, historicalWindow, ledgerRaceId = null) {
  const exact = bucketRows.filter((bucket) =>
    sameInstant(bucket.windowStart, historicalWindow.windowStart) &&
    sameInstant(bucket.windowEnd, historicalWindow.windowEnd) &&
    bucket.race?.timezone === SEED_TIMEZONE,
  );
  if (ledgerRaceId) {
    const stamped = exact.find((bucket) => bucket.race.id === ledgerRaceId);
    if (stamped) return { race: stamped.race, bucketId: stamped.id };
  }
  if (exact.length === 1) return { race: exact[0].race, bucketId: exact[0].id };
  if (exact.length > 1) {
    return {
      error: "AMBIGUOUS_BUCKET",
      candidateRaceIds: exact.map((bucket) => bucket.race.id).sort(),
    };
  }
  return { error: "HISTORICAL_BUCKET_NOT_FOUND", candidateRaceIds: [] };
}

async function resolveSignupRace(db, seed, createdAt, userId = null) {
  const historicalWindow = historicalWindowFor(seed, createdAt);
  const [buckets, ledger] = await Promise.all([
    db.seededRaceBucket.findMany({
      where: { seedId: seed.id, windowStart: historicalWindow.windowStart },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        race: {
          select: {
            id: true,
            seedId: true,
            seededBucketId: true,
            status: true,
            completedAt: true,
            timezone: true,
          },
        },
      },
    }),
    userId && db.seededRaceWindowMembership
      ? db.seededRaceWindowMembership.findUnique({
          where: {
            seedId_windowStart_userId: {
              seedId: seed.id,
              windowStart: historicalWindow.windowStart,
              userId,
            },
          },
          select: { raceId: true },
        })
      : null,
  ]);
  const chosen = chooseHistoricalRace(
    buckets,
    historicalWindow,
    ledger?.raceId || null,
  );
  if (!chosen.error) return { ...chosen, ...historicalWindow, seed };

  // The historical signup path used the exact next-window LEGACY race only
  // when no active private bucket existed. Resolve that canonical identity,
  // never an arbitrary race whose lifespan merely overlapped signup time.
  const upcoming = upcomingWindowFor(seed, createdAt);
  const legacyRows = await db.race.findMany({
    where: {
      seedId: seed.id,
      seededBucketId: null,
      scheduledStartAt: upcoming.windowStart,
      timezone: SEED_TIMEZONE,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      seedId: true,
      seededBucketId: true,
      status: true,
      completedAt: true,
      timezone: true,
    },
  });
  if (legacyRows.length === 1) {
    return {
      race: legacyRows[0],
      bucketId: null,
      windowStart: upcoming.windowStart,
      windowEnd: upcoming.windowEnd,
      seed,
    };
  }
  return {
    ...chosen,
    seed,
    windowStart: historicalWindow.windowStart,
    windowEnd: historicalWindow.windowEnd,
    ...(legacyRows.length > 1
      ? {
          error: "AMBIGUOUS_LEGACY_WINDOW",
          candidateRaceIds: legacyRows.map((race) => race.id).sort(),
        }
      : {}),
  };
}

async function auditCohort({ db = prisma, date, apply = false }) {
  const { start, end } = utcBounds(date);
  const users = await db.user.findMany({
    where: { createdAt: { gte: start, lt: end } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, isReviewAccount: true },
  });
  const report = {
    date, mode: apply ? "APPLY" : "DRY_RUN", users: users.length,
    missingDaily: [], missingWeekly: [], missingBoth: [], ineligible: [],
    alreadyEnrolled: [], completedOrSettled: [], unresolved: [], errors: [], commands: [],
  };
  const seeds = await db.raceSeed.findMany({
    where: {
      kind: { in: Object.values(TARGET_KIND_BY_CADENCE) },
      active: true,
    },
    orderBy: [{ cadence: "asc" }, { kind: "asc" }, { id: "asc" }],
  });
  const seedByCadence = new Map();
  for (const cadence of TARGET_CADENCES) {
    const matching = seeds.filter(
      (seed) => seed.cadence === cadence &&
        seed.kind === TARGET_KIND_BY_CADENCE[cadence],
    );
    if (matching.length === 1) seedByCadence.set(cadence, matching[0]);
  }
  const byRace = new Map();
  for (const user of users) {
    if (user.isReviewAccount) {
      report.ineligible.push(user.id);
      continue;
    }
    const missing = [];
    try {
      for (const cadence of TARGET_CADENCES) {
        const seed = seedByCadence.get(cadence);
        if (!seed) {
          missing.push(cadence);
          report.unresolved.push({
            userId: user.id,
            cadence,
            reason: "SEED_NOT_UNIQUE",
          });
          continue;
        }
        const resolution = await resolveSignupRace(
          db,
          seed,
          user.createdAt,
          user.id,
        );
        if (resolution.error) {
          missing.push(cadence);
          report.unresolved.push({
            userId: user.id,
            cadence,
            reason: resolution.error,
            windowStart: resolution.windowStart,
            windowEnd: resolution.windowEnd,
            candidateRaceIds: resolution.candidateRaceIds,
          });
          continue;
        }
        const race = resolution.race;
        const membership = await db.raceParticipant.findUnique({
          where: { raceId_userId: { raceId: race.id, userId: user.id } },
          select: { id: true },
        });
        if (membership) continue;
        missing.push(cadence);
        if (!["PENDING", "ACTIVE"].includes(race.status) || race.completedAt) {
          report.completedOrSettled.push({ userId: user.id, cadence, raceId: race.id });
          continue;
        }
        const target = byRace.get(race.id) || {
          raceId: race.id,
          seedId: seed.id,
          cadence,
          bucketId: resolution.bucketId,
          windowStart: resolution.windowStart,
          windowEnd: resolution.windowEnd,
          userIds: [],
        };
        target.userIds.push(user.id);
        byRace.set(race.id, target);
      }
      if (missing.includes("DAILY")) report.missingDaily.push(user.id);
      if (missing.includes("WEEKLY")) report.missingWeekly.push(user.id);
      if (missing.length === 2) report.missingBoth.push(user.id);
      if (missing.length === 0) report.alreadyEnrolled.push(user.id);
    } catch (error) {
      report.errors.push({ userId: user.id, error: error.message });
    }
  }
  for (const [raceId, target] of [...byRace].sort(([a], [b]) => a.localeCompare(b))) {
    const userIds = [...new Set(target.userIds)].sort();
    const dedupeKey = `cohort-repair:${raceId}:${date}`;
    const payload = {
      raceId,
      userIds,
      sourceDate: date,
      seedId: target.seedId,
      cadence: target.cadence,
      seededBucketId: target.bucketId,
      windowStart: target.windowStart.toISOString(),
      windowEnd: target.windowEnd.toISOString(),
    };
    report.commands.push({ raceId, userIds, dedupeKey, payload });
    if (apply) {
      await db.$transaction(async (tx) => {
        const existing = await tx.raceAdminCommand.findUnique({
          where: { dedupeKey },
        });
        if (!existing) {
          await tx.raceAdminCommand.create({
            data: {
              raceId,
              commandType: "HISTORICAL_COHORT_ENROLLMENT",
              dedupeKey,
              payload,
            },
          });
        } else if (["PENDING", "FAILED"].includes(existing.status)) {
          await tx.raceAdminCommand.update({
            where: { id: existing.id },
            data: {
              payload,
              status: "PENDING",
              availableAt: new Date(),
              lastError: null,
              completedAt: null,
            },
          });
        }
      });
    }
  }
  return report;
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const date = argValue("date");
  const apply = process.argv.includes("--apply");
  const connection = new URL(process.env.DATABASE_URL || "");
  const database = connection.pathname.replace(/^\//, "");
  if (apply && argValue("confirm-database") !== database) {
    throw new Error(
      `apply requires --confirm-database=${database}; run and review --dry-run first`,
    );
  }
  process.stdout.write(
    `COHORT_REPORT=${JSON.stringify(await auditCohort({ date, apply }))}\n`,
  );
}

if (require.main === module) {
  main().then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  }).catch(async (error) => {
    console.error(error.message);
    await prisma.$disconnect();
    process.exit(1);
  });
}

module.exports = {
  auditCohort,
  resolveSignupRace,
  utcBounds,
  historicalWindowFor,
  chooseHistoricalRace,
};
