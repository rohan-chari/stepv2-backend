const { prisma: defaultPrisma } = require("../../../db");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
} = require("../../../shared/time/week");
const { prorateSamplesIntoWindow } = require("../../steps/models/stepSample");
const { normalizePowerupConfig } = require("./validateRaceConfig");

const SEED_TIMEZONE = "America/New_York";
const BUCKET_CAPACITY = 15;
const BUCKET_FEATURE = "seeded_race_buckets";

class SeededBucketError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "SeededBucketError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function windowFor(seed, date = new Date()) {
  if (seed.cadence === "WEEKLY") {
    const windowStart = startOfWeekNewYork(date, SEED_TIMEZONE);
    return { windowStart, windowEnd: nextWeekStartNewYork(date, SEED_TIMEZONE) };
  }
  const windowStart = startOfDayNewYork(date, SEED_TIMEZONE);
  return { windowStart, windowEnd: nextMidnightNewYork(date, SEED_TIMEZONE) };
}

function upcomingWindowFor(seed, date = new Date()) {
  const current = windowFor(seed, date);
  return windowFor(seed, current.windowEnd);
}

function supportsBuckets(clientFeatures) {
  return clientFeatures?.has(BUCKET_FEATURE) === true;
}

// The ledger is the single authority across the temporary global stream and
// private buckets. Legacy enrollment must claim it before adding a
// RaceParticipant; otherwise the same person can enter both fields by changing
// client capability between requests. The legacy race's scheduled/start instant
// is its canonical ET window identity.
async function claimLegacyStream({ prisma, race, userId }) {
  if (!race?.seedId || !prisma?.seededRaceWindowMembership) return true;
  const windowStart = race.scheduledStartAt || race.startedAt;
  if (!windowStart) return true;
  const membership = await prisma.seededRaceWindowMembership.upsert({
    where: {
      seedId_windowStart_userId: {
        seedId: race.seedId,
        windowStart: new Date(windowStart),
        userId,
      },
    },
    create: {
      seedId: race.seedId,
      windowStart: new Date(windowStart),
      userId,
      stream: "LEGACY",
      raceId: race.id,
    },
    update: {},
  });
  return membership.stream === "LEGACY";
}

function skillBand(a, b) {
  return Math.abs(a - b) <= Math.max(2000, 0.5 * Math.max(a, b));
}

// Deterministic, batch-only clustering. It starts with qualifying friendship
// components, packs those in stable order, then uses nearest median for the
// remaining groups. The final singleton rebalance is deterministic too.
function planBuckets(candidates, friendships = []) {
  const sorted = [...candidates].sort(
    (a, b) => a.matchSteps - b.matchSteps || String(a.userId).localeCompare(String(b.userId))
  );
  if (sorted.length === 0) return [];
  const byId = new Map(sorted.map((candidate) => [candidate.userId, candidate]));
  const adjacent = new Map(sorted.map((candidate) => [candidate.userId, new Set()]));
  for (const { userAId, userBId } of friendships) {
    const a = byId.get(userAId);
    const b = byId.get(userBId);
    if (a && b && skillBand(a.matchSteps, b.matchSteps)) {
      adjacent.get(a.userId).add(b.userId);
      adjacent.get(b.userId).add(a.userId);
    }
  }
  const groups = [];
  const visited = new Set();
  for (const candidate of sorted) {
    if (visited.has(candidate.userId)) continue;
    const queue = [candidate.userId];
    const group = [];
    visited.add(candidate.userId);
    while (queue.length) {
      const id = queue.shift();
      group.push(byId.get(id));
      for (const neighbor of adjacent.get(id)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    group.sort((a, b) => a.matchSteps - b.matchSteps || String(a.userId).localeCompare(String(b.userId)));
    // Oversized friend components cannot be preserved under the hard cap. Split
    // at deterministic adjacent skill order; all retained edges were legal.
    for (let index = 0; index < group.length; index += BUCKET_CAPACITY) {
      groups.push(group.slice(index, index + BUCKET_CAPACITY));
    }
  }
  groups.sort((a, b) =>
    a[0].matchSteps - b[0].matchSteps || String(a[0].userId).localeCompare(String(b[0].userId))
  );
  const buckets = [];
  for (const group of groups) {
    let remaining = [...group];
    while (remaining.length) {
      let bucket = buckets.find((existing) => existing.length + remaining.length <= BUCKET_CAPACITY);
      if (!bucket) bucket = [];
      const capacity = BUCKET_CAPACITY - bucket.length;
      bucket.push(...remaining.splice(0, capacity));
      if (!buckets.includes(bucket)) buckets.push(bucket);
    }
  }
  if (sorted.length > 1 && buckets.length > 1 && buckets.at(-1).length === 1) {
    const lone = buckets.at(-1)[0];
    const choices = buckets.slice(0, -1).filter((bucket) => bucket.length < BUCKET_CAPACITY);
    if (choices.length) {
      choices.sort((left, right) => {
        const median = (bucket) => bucket[Math.floor(bucket.length / 2)].matchSteps;
        return Math.abs(lone.matchSteps - median(left)) - Math.abs(lone.matchSteps - median(right)) ||
          String(left[0].userId).localeCompare(String(right[0].userId));
      });
      choices[0].push(lone);
      buckets.pop();
    } else {
      // Every earlier bucket is full (e.g. 16 eligible candidates). Rebalance
      // the closest full bucket with the singleton; this is the only legal way
      // to honour both max-15 and the no-singleton rule.
      const previous = buckets[buckets.length - 2];
      const combined = [...previous, lone].sort(
        (a, b) => a.matchSteps - b.matchSteps || String(a.userId).localeCompare(String(b.userId))
      );
      const midpoint = Math.ceil(combined.length / 2);
      buckets.splice(buckets.length - 2, 2, combined.slice(0, midpoint), combined.slice(midpoint));
    }
  }
  return buckets;
}

async function matchStepsForCandidates({ prisma, candidates, seed, windowStart }) {
  const lookbackEnd = new Date(windowStart);
  const days = seed.cadence === "WEEKLY" ? 28 : 28;
  // Daily skips D-1 and looks over D-29..D-2. Weekly skips the immediately
  // preceding week and uses the four weeks before it: D-35..D-7.
  const excludedMs = seed.cadence === "WEEKLY" ? 7 * 86400000 : 86400000;
  const rangeEnd = new Date(lookbackEnd.getTime() - excludedMs);
  const rangeStart = new Date(rangeEnd.getTime() - days * 86400000);
  const userIds = candidates.map((row) => row.userId);
  const [samples, daily] = await Promise.all([
    prisma.stepSample.findMany({
      where: { userId: { in: userIds }, periodEnd: { gt: rangeStart }, periodStart: { lt: rangeEnd } },
      select: { userId: true, periodStart: true, periodEnd: true, steps: true },
    }),
    prisma.step.findMany({
      where: { userId: { in: userIds }, date: { gte: new Date(rangeStart.toISOString().slice(0, 10)), lt: new Date(rangeEnd.toISOString().slice(0, 10)) } },
      select: { userId: true, steps: true },
    }),
  ]);
  const sampleTotals = new Map(userIds.map((id) => [id, 0]));
  for (const sample of samples) {
    const normalized = { start: sample.periodStart, end: sample.periodEnd, steps: sample.steps };
    sampleTotals.set(sample.userId, sampleTotals.get(sample.userId) + prorateSamplesIntoWindow([normalized], rangeStart.getTime(), rangeEnd.getTime()));
  }
  const dailyTotals = new Map(userIds.map((id) => [id, 0]));
  for (const row of daily) dailyTotals.set(row.userId, dailyTotals.get(row.userId) + Math.max(0, Number(row.steps) || 0));
  return candidates.map((candidate) => ({
    ...candidate,
    matchSteps: Math.max(0, Math.floor(Math.max(sampleTotals.get(candidate.userId) || 0, dailyTotals.get(candidate.userId) || 0))),
  }));
}

function buildSeededRaceBuckets(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const settings = dependencies.appSettings || defaultAppSettings;

  async function elect({ userId, seedKind, window = "UPCOMING" }) {
    if (window !== "UPCOMING") throw new SeededBucketError("Window must be UPCOMING", 400, "INVALID_WINDOW");
    const seed = await prisma.raceSeed.findFirst({ where: { kind: seedKind, active: true } });
    if (!seed || !["DAILY_10K", "WEEKLY_50K"].includes(seed.kind)) {
      throw new SeededBucketError("Seed not found or disabled", 404, "SEED_NOT_FOUND_OR_DISABLED");
    }
    const { windowStart, windowEnd } = upcomingWindowFor(seed, now());
    if (now() >= windowStart) throw new SeededBucketError("Window is finalized", 409, "WINDOW_FINALIZED");
    // Election and finalization share the identical transaction-scoped lock.
    // Without it, an election that commits after finalise snapshots candidates
    // but before the boundary would receive 202 yet never get an assignment.
    const lockKey = `seeded-bucket:${seed.id}:${new Date(windowStart).toISOString()}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      if (now() >= windowStart) {
        throw new SeededBucketError("Window is finalized", 409, "WINDOW_FINALIZED");
      }
      const finalized = await tx.seededRaceBucket.count({
        where: { seedId: seed.id, windowStart },
      });
      if (finalized > 0) {
        throw new SeededBucketError("Window is finalized", 409, "WINDOW_FINALIZED");
      }
      // Deploy/migration safety: a legacy PENDING participant created before
      // this release cannot have a ledger row yet. Detect it under the same
      // window lock and stamp LEGACY before permitting any bucket election.
      const legacyParticipant = await tx.raceParticipant.findFirst({
        where: {
          userId,
          status: "ACCEPTED",
          race: {
            seedId: seed.id,
            seededBucketId: null,
            status: "PENDING",
            scheduledStartAt: windowStart,
          },
        },
        select: { raceId: true },
      });
      if (legacyParticipant) {
        await tx.seededRaceWindowMembership.upsert({
          where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId } },
          create: {
            seedId: seed.id,
            windowStart,
            userId,
            stream: "LEGACY",
            raceId: legacyParticipant.raceId,
          },
          update: {},
        });
      }
      // The advisory lock serializes normal callers, while upsert keeps this
      // idempotent even if a prior deployment or an operational task already
      // created the ledger row. Avoid catching a unique violation inside the
      // transaction: PostgreSQL marks that transaction aborted before a read
      // can inspect which stream won.
      const membership = await tx.seededRaceWindowMembership.upsert({
        where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId } },
        create: { seedId: seed.id, windowStart, userId, stream: "BUCKET" },
        update: {},
      });
      if (membership.stream === "LEGACY") {
        throw new SeededBucketError("Legacy stream elected", 409, "LEGACY_STREAM_ELECTED");
      }
    });
    return { elected: true, raceId: null, finalizesAt: windowStart, windowEnd };
  }

  async function finalise({ seed, windowStart, windowEnd }) {
    if (now() >= windowStart) return [];
    // These values are stamped exactly as the legacy renewal path stamps
    // them. Bucket matching must never silently alter a seeded race's payout
    // economics merely because its participant field is private.
    const [fundedPrizePools, geometricPayouts] = await Promise.all([
      settings.getFlag("fundedPrizePoolsEnabled"),
      settings.getFlag("seededGeometricPayoutsEnabled"),
    ]);
    const lockKey = `seeded-bucket:${seed.id}:${new Date(windowStart).toISOString()}`;
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const elected = await tx.seededRaceWindowMembership.findMany({
        where: { seedId: seed.id, windowStart, stream: "BUCKET" },
        select: { userId: true }, orderBy: { userId: "asc" },
      });
      if (!elected.length) return [];
      const existing = await tx.seededRaceBucket.findMany({ where: { seedId: seed.id, windowStart }, include: { assignments: true } });
      if (existing.length) return existing;
      const candidates = await matchStepsForCandidates({ prisma: tx, candidates: elected, seed, windowStart });
      const friendships = await tx.friendship.findMany({
        where: { status: "ACCEPTED", OR: [{ requesterId: { in: elected.map((e) => e.userId) } }, { addresseeId: { in: elected.map((e) => e.userId) } }] },
        select: { requesterId: true, addresseeId: true },
      });
      const plan = planBuckets(candidates, friendships.map((row) => ({ userAId: row.requesterId, userBId: row.addresseeId })));
      const rows = [];
      for (let ordinal = 0; ordinal < plan.length; ordinal += 1) {
        const group = plan[ordinal];
        const race = await tx.race.create({
          data: {
            seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps, status: "PENDING", isPublic: false,
            maxParticipants: BUCKET_CAPACITY, powerupsEnabled: seed.powerupsEnabled,
            timeBased: seed.timeBased, timezone: SEED_TIMEZONE, scheduledStartAt: windowStart, endsAt: windowEnd,
            maxDurationDays: seed.cadence === "WEEKLY" ? 7 : 1, payoutPreset: "TOP_HALF",
            payoutCurve: geometricPayouts === true ? "GEOMETRIC" : null,
            fundedPrize: fundedPrizePools === true,
            powerupStepInterval: normalizePowerupConfig({
              powerupsEnabled: seed.powerupsEnabled ?? false,
            }),
          },
        });
        const bucket = await tx.seededRaceBucket.create({ data: { seedId: seed.id, windowStart, windowEnd, raceId: race.id, status: "PENDING" } });
        await tx.race.update({ where: { id: race.id }, data: { seededBucketId: bucket.id } });
        for (const candidate of group) {
          const participant = await tx.raceParticipant.create({ data: { raceId: race.id, userId: candidate.userId, status: "ACCEPTED" } });
          await tx.seededRaceBucketAssignment.create({ data: { bucketId: bucket.id, userId: candidate.userId, seedId: seed.id, windowStart, raceParticipantId: participant.id, matchSteps: candidate.matchSteps, state: "FINAL" } });
          await tx.seededRaceWindowMembership.update({ where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: candidate.userId } }, data: { raceId: race.id } });
        }
        rows.push(bucket);
      }
      return rows;
    });
  }

  async function featuredCards(userId) {
    const seeds = await prisma.raceSeed.findMany({
      where: { active: true, kind: { in: ["DAILY_10K", "WEEKLY_50K"] } },
      orderBy: { kind: "asc" },
    });
    const cards = [];
    for (const seed of seeds) {
      const current = windowFor(seed, now());
      const upcoming = upcomingWindowFor(seed, now());
      const bucket = await prisma.seededRaceBucket.findFirst({
        // Membership predicate is the privacy boundary: never select another
        // player's bucket merely to discover that this viewer has no row.
        where: {
          seedId: seed.id,
          windowStart: { in: [current.windowStart, upcoming.windowStart] },
          assignments: { some: { userId } },
        },
        orderBy: { windowStart: "asc" },
        include: { race: { include: { participants: { where: { userId }, select: { status: true } } } } },
      });
      const elected = await prisma.seededRaceWindowMembership.findUnique({
        where: { seedId_windowStart_userId: { seedId: seed.id, windowStart: upcoming.windowStart, userId } },
      });
      const race = bucket?.race || null;
      const mine = race?.participants?.[0] || null;
      cards.push({
        raceId: race?.id ?? null,
        seedKind: seed.kind,
        name: seed.name,
        endsAt: race?.endsAt ?? current.windowEnd,
        participantCount: mine ? await prisma.raceParticipant.count({ where: { raceId: race.id, status: "ACCEPTED" } }) : 0,
        maxParticipants: BUCKET_CAPACITY,
        isFull: false,
        myStatus: mine?.status ?? (elected?.stream === "BUCKET" ? "ELECTED" : null),
        bucketPrivate: true,
        upcoming: {
          raceId: race?.status === "PENDING" ? race.id : null,
          scheduledStartAt: upcoming.windowStart,
          participantCount: 0,
          maxParticipants: BUCKET_CAPACITY,
          isFull: false,
          myStatus: elected?.stream === "BUCKET" ? "ELECTED" : null,
          bucketPrivate: true,
        },
      });
    }
    return cards;
  }

  return { elect, finalise, featuredCards };
}

module.exports = { buildSeededRaceBuckets, SeededBucketError, windowFor, upcomingWindowFor, supportsBuckets, claimLegacyStream, planBuckets, BUCKET_CAPACITY, BUCKET_FEATURE };
