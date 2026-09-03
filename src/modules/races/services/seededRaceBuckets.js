const { prisma: defaultPrisma } = require("../../../db");
const { randomUUID } = require("node:crypto");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
} = require("../../../shared/time/week");
const { prorateSamplesIntoWindow } = require("../../steps/models/stepSample");
const { normalizePowerupConfig } = require("./validateRaceConfig");
const { filterInactiveUserIds } = require("./seededInactivity");
const {
  computeRaceExposureStamp,
  computeTournamentExposureStamp,
  FUNDED_EXPOSURE_LIMIT_MILLICOINS,
  FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  reserveFundedExposures,
  resolveRacePrizeStamp,
  resolveTournamentPrizeStamp,
} = require("./fundedExposure");
const {
  acquireRaceWriteFence,
  acquireRaceWriteFences,
  lockCompetitionRows,
} = require("./raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");
const { invalidateUser: invalidateRaceListUser } = require("./raceListCache");

const SEED_TIMEZONE = "America/New_York";
const BUCKET_CAPACITY = 15;
const DAILY_COHORT_MINIMUM = 30;
const DAILY_COHORT_MAXIMUM = 35;
const WEEKLY_COHORT_MINIMUM = 75;
const WEEKLY_COHORT_MAXIMUM = 100;
const BUCKET_FEATURE = "seeded_race_buckets";
// Finalizing a production Daily can create roughly thirty private races and
// must take every race/user/competition lock before publishing membership.
// Prisma's 5s interactive-transaction default is too small for that bounded
// batch under ordinary production load. Weekly uses this same path, so keep
// one explicit budget for both cadences rather than relying on client defaults.
const FINALIZATION_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
};

function cohortMinimumForSeed(seed) {
  if (seed?.kind === "DAILY_10K") return DAILY_COHORT_MINIMUM;
  return seed?.cadence === "WEEKLY" ? WEEKLY_COHORT_MINIMUM : BUCKET_CAPACITY;
}

function cohortMaximumForSeed(seed) {
  if (seed?.kind === "DAILY_10K") return DAILY_COHORT_MAXIMUM;
  if (seed?.cadence === "WEEKLY") return WEEKLY_COHORT_MAXIMUM;
  return Infinity;
}

function cohortCountForSize(
  size,
  minimum = BUCKET_CAPACITY,
  maximum = Infinity,
) {
  if (size <= 0) return 0;
  const targetCount = size < minimum ? 1 : Math.floor(size / minimum);
  const capCount = Number.isFinite(maximum) ? Math.ceil(size / maximum) : 1;
  return Math.max(targetCount, capCount);
}

function splitFundedExposureCandidates(elected, totals, stamp) {
  const eligible = [];
  const skippedUserIds = [];
  for (const row of elected) {
    const current = totals.get(row.userId) || {
      exposureMillicoins: 0,
      exposureRateMillicoinsPerDay: 0,
    };
    const fits =
      current.exposureMillicoins + stamp.exposureMillicoins <=
        FUNDED_EXPOSURE_LIMIT_MILLICOINS &&
      current.exposureRateMillicoinsPerDay +
        stamp.exposureRateMillicoinsPerDay <=
        FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY;
    if (fits) eligible.push(row);
    else skippedUserIds.push(row.userId);
  }
  return { eligible, skippedUserIds };
}

async function readFundedExposureCohort(prisma, userIds) {
  const ordered = [...new Set(userIds.filter(Boolean))].sort();
  const totals = new Map(
    ordered.map((userId) => [userId, {
      exposureMillicoins: 0,
      exposureRateMillicoinsPerDay: 0,
    }]),
  );
  if (!ordered.length) return totals;

  const [races, tournaments] = await Promise.all([
    prisma.raceParticipant.findMany({
      where: {
        userId: { in: ordered }, status: "ACCEPTED", finishedAt: null, forfeitedAt: null,
        race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
      },
      select: {
        userId: true,
        fundedExposureMillicoins: true,
        fundedExposureRateMillicoinsPerDay: true,
        race: {
          select: {
            maxDurationDays: true,
            teamPoolMultBps: true,
            prizeCoinUnit: true,
            prizePoolMaxCoins: true,
            prizeCalculationVersion: true,
          },
        },
      },
    }),
    prisma.tournamentParticipant.findMany({
      where: {
        userId: { in: ordered }, status: "ACCEPTED", eliminatedInRound: null,
        tournament: {
          fundedPrize: true, seedId: null, status: { in: ["PENDING", "ACTIVE"] },
        },
      },
      select: {
        userId: true,
        fundedExposureMillicoins: true,
        fundedExposureRateMillicoinsPerDay: true,
        tournament: {
          select: {
            bracketSize: true,
            totalRounds: true,
            matchupDurationDays: true,
            prizeCoinUnit: true,
            tournamentChampionMaxCoins: true,
            prizeCalculationVersion: true,
          },
        },
      },
    }),
  ]);

  for (const row of races) {
    const stamp = row.fundedExposureMillicoins != null &&
        row.fundedExposureRateMillicoinsPerDay != null
      ? row
      : computeRaceExposureStamp({
          maxDurationDays: row.race.maxDurationDays,
          prizeCoinUnit: resolveRacePrizeStamp(row.race).prizeCoinUnit,
          teamPoolMultBps: row.race.teamPoolMultBps,
        });
    const total = totals.get(row.userId);
    total.exposureMillicoins += stamp.fundedExposureMillicoins ?? stamp.exposureMillicoins;
    total.exposureRateMillicoinsPerDay += stamp.fundedExposureRateMillicoinsPerDay ?? stamp.exposureRateMillicoinsPerDay;
  }
  for (const row of tournaments) {
    const stamp = row.fundedExposureMillicoins != null &&
        row.fundedExposureRateMillicoinsPerDay != null
      ? row
      : computeTournamentExposureStamp({
          bracketSize: row.tournament.bracketSize,
          totalRounds: row.tournament.totalRounds,
          matchupDurationDays: row.tournament.matchupDurationDays,
          prizeCoinUnit: resolveTournamentPrizeStamp(row.tournament).prizeCoinUnit,
          tournamentChampionMaxCoins: resolveTournamentPrizeStamp(row.tournament).tournamentChampionMaxCoins,
        });
    const total = totals.get(row.userId);
    total.exposureMillicoins += stamp.fundedExposureMillicoins ?? stamp.exposureMillicoins;
    total.exposureRateMillicoinsPerDay += stamp.fundedExposureRateMillicoinsPerDay ?? stamp.exposureRateMillicoinsPerDay;
  }
  return totals;
}

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

function windowLockKey(seedId, windowStart) {
  return `seeded-bucket:${seedId}:${new Date(windowStart).toISOString()}`;
}

// A window-mode row is immutable (`stampWindowMode` deliberately uses an empty
// update), so positive reads can live for the worker lifetime. Missing rows are
// not cached because another worker may stamp one immediately afterwards.
const windowModeReadsByPrisma = new WeakMap();

async function acquireSeededWindowLock(tx, seedId, windowStart) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${windowLockKey(seedId, windowStart)}))`;
}

// Ledger-only operations take this window lock directly. Operations that also
// mutate race/tournament membership must first take the universal sequence
// (C0 -> global event -> sorted users -> sorted competitions), then this lock,
// and re-read durable window policy and membership while all locks are held.
async function withSeededWindowLock({ prisma, seedId, windowStart, fn }) {
  return prisma.$transaction(async (tx) => {
    await acquireSeededWindowLock(tx, seedId, windowStart);
    return fn(tx);
  });
}

async function readWindowMode({ prisma, seedId, windowStart }) {
  if (!prisma.seededRaceWindowModeRecord) return "LEGACY";
  let reads = windowModeReadsByPrisma.get(prisma);
  if (!reads) {
    reads = new Map();
    windowModeReadsByPrisma.set(prisma, reads);
  }
  const normalizedWindowStart = new Date(windowStart);
  const key = `${seedId}:${normalizedWindowStart.toISOString()}`;
  let read = reads.get(key);
  if (!read) {
    read = prisma.seededRaceWindowModeRecord.findUnique({
      where: { seedId_windowStart: { seedId, windowStart: normalizedWindowStart } },
      select: { mode: true },
    }).then((row) => {
      if (!row?.mode) reads.delete(key);
      return row;
    }).catch((error) => {
      reads.delete(key);
      throw error;
    });
    reads.set(key, read);
  }
  const row = await read;
  // Mixed deploy safe default: code may arrive before the migration backfill
  // has touched a row, and that row must remain on the legacy path.
  return row?.mode || "LEGACY";
}

async function stampWindowMode({ prisma, seedId, windowStart, windowEnd, mode }) {
  return withSeededWindowLock({ prisma, seedId, windowStart, fn: async (tx) => {
    if (!tx.seededRaceWindowModeRecord) return { mode: "LEGACY" };
    return tx.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId, windowStart } },
      create: { seedId, windowStart, windowEnd, mode },
      update: {},
    });
  }});
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
  return withSeededWindowLock({ prisma, seedId: race.seedId, windowStart, fn: async (tx) => {
    const membership = await tx.seededRaceWindowMembership.upsert({
      where: { seedId_windowStart_userId: { seedId: race.seedId, windowStart: new Date(windowStart), userId } },
      create: { seedId: race.seedId, windowStart: new Date(windowStart), userId, stream: "LEGACY", raceId: race.id },
      update: {},
    });
    return membership.stream === "LEGACY";
  }});
}

function skillBand(a, b) {
  return Math.abs(a - b) <= Math.max(2000, 0.5 * Math.max(a, b));
}

// Deterministic, batch-only clustering. It starts with qualifying friendship
// components, packs them in stable skill order, and merges only an impossible
// undersized trailing component remainder.
function planBuckets(
  candidates,
  friendships = [],
  minimum = BUCKET_CAPACITY,
  maximum = Infinity,
) {
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
    groups.push(group);
  }
  groups.sort((a, b) =>
    a[0].matchSteps - b[0].matchSteps || String(a[0].userId).localeCompare(String(b[0].userId))
  );
  const bucketCount = cohortCountForSize(sorted.length, minimum, maximum);
  const targetSizes = Array.from({ length: bucketCount }, (_, index) =>
    Math.floor(sorted.length / bucketCount) + (index < sorted.length % bucketCount ? 1 : 0));

  // Cadence policies with a finite maximum are balance-first. Friendship
  // components remain contiguous where possible. Oversized components use a
  // deterministic breadth-first graph order before the exact-size cuts, which
  // retains dense direct-friend neighborhoods instead of shredding them by a
  // pure skill-order slice. A transitive friendship chain is still an affinity
  // hint, not authority to create a 97-person Daily or unbounded Weekly field.
  if (Number.isFinite(maximum)) {
    const graphOrderedGroups = groups.map((group) => {
      if (group.length <= 1) return group;
      const memberIds = new Set(group.map((candidate) => candidate.userId));
      const remaining = new Set(memberIds);
      const ordered = [];
      while (remaining.size) {
        const start = group.find((candidate) => remaining.has(candidate.userId));
        const queue = [start.userId];
        remaining.delete(start.userId);
        while (queue.length) {
          const id = queue.shift();
          ordered.push(byId.get(id));
          const neighbors = [...adjacent.get(id)]
            .filter((neighborId) => memberIds.has(neighborId) && remaining.has(neighborId))
            .sort((left, right) => {
              const a = byId.get(left);
              const b = byId.get(right);
              return a.matchSteps - b.matchSteps || String(a.userId).localeCompare(String(b.userId));
            });
          for (const neighborId of neighbors) {
            remaining.delete(neighborId);
            queue.push(neighborId);
          }
        }
      }
      return ordered;
    });
    const ordered = graphOrderedGroups.flat();
    const buckets = [];
    let offset = 0;
    for (const targetSize of targetSizes) {
      buckets.push(ordered.slice(offset, offset + targetSize));
      offset += targetSize;
    }
    return buckets;
  }

  const buckets = [];
  // Pack whole friendship components in skill order. Singleton components
  // therefore remain contiguous skill bands; a component is allowed to make a
  // bucket slightly larger than target when splitting it would be worse.
  for (const group of groups) {
    let bucket = buckets.at(-1);
    const targetSize = targetSizes[buckets.length - 1] ?? targetSizes.at(-1);
    if (!bucket || (bucket.length >= minimum && bucket.length + group.length > targetSize)) {
      bucket = [];
      buckets.push(bucket);
    }
    bucket.push(...group);
  }
  // An indivisible friendship component can leave a short trailing remainder
  // (for example, three 10-person components). Merge it into the nearest
  // skill-adjacent cohort rather than creating an undersized field.
  while (buckets.length > 1) {
    const undersizedIndex = buckets.findIndex((bucket) => bucket.length < minimum);
    if (undersizedIndex < 0) break;
    const targetIndex = undersizedIndex === 0 ? 1 : undersizedIndex - 1;
    buckets[targetIndex].push(...buckets[undersizedIndex]);
    buckets.splice(undersizedIndex, 1);
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
  const samples = await prisma.stepSample.findMany({
    where: { userId: { in: userIds }, periodEnd: { gt: rangeStart }, periodStart: { lt: rangeEnd } },
    select: { userId: true, periodStart: true, periodEnd: true, steps: true },
  });
  const daily = await prisma.step.findMany({
    where: { userId: { in: userIds }, date: { gte: new Date(rangeStart.toISOString().slice(0, 10)), lt: new Date(rangeEnd.toISOString().slice(0, 10)) } },
    select: { userId: true, steps: true },
  });
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
  const acquireWriteFence =
    dependencies.acquireRaceWriteFence || acquireRaceWriteFence;
  const acquireWriteFences =
    dependencies.acquireRaceWriteFences ||
    (dependencies.acquireRaceWriteFence
      ? async (tx, raceIds) => {
          const ordered = [...new Set(raceIds)].sort();
          for (const raceId of ordered) await acquireWriteFence(tx, raceId);
          return ordered;
        }
      : acquireRaceWriteFences);
  const lockUsers =
    dependencies.lockFundedExposureUsers || lockFundedExposureUsers;
  const lockCompetitions =
    dependencies.lockCompetitionRows || lockCompetitionRows;
  const acquireGlobalLock =
    dependencies.acquireGlobalEnrollmentLock || acquireGlobalEnrollmentLock;

  async function automaticCandidates(tx) {
    const users = await tx.user.findMany({
      where: {
        autoJoinFeaturedRaces: true,
        clientFeatures: { has: BUCKET_FEATURE },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const ids = users.map((user) => user.id);
    if (!ids.length) return ids;
    if ((await settings.getFlag("seededInactivityPruneEnabled")) !== true) return ids;
    try {
      const inactive = await filterInactiveUserIds({ userIds: ids, now: now(), prisma: tx });
      return ids.filter((id) => !inactive.has(id));
    } catch (error) {
      // Preserve the legacy enrollment policy's fail-open availability rule.
      return ids;
    }
  }

  async function electAutomatic({ seed, windowStart, windowEnd }) {
    return withSeededWindowLock({ prisma, seedId: seed.id, windowStart, fn: async (tx) => {
      if (await readWindowMode({ prisma: tx, seedId: seed.id, windowStart }) !== "BUCKET") return 0;
      if (now() >= windowStart) return 0;
      const finalized = await tx.seededRaceBucket.count({ where: { seedId: seed.id, windowStart } });
      if (finalized > 0) return 0;
      const userIds = await automaticCandidates(tx);
      if (!userIds.length) return 0;
      const existing = await tx.seededRaceWindowMembership.findMany({
        where: { seedId: seed.id, windowStart, userId: { in: userIds } },
        select: { userId: true, stream: true },
      });
      const taken = new Set(existing.map((row) => row.userId));
      const candidates = userIds.filter((id) => !taken.has(id));
      if (!candidates.length) return 0;
      await tx.seededRaceWindowMembership.createMany({
        data: candidates.map((userId) => ({ seedId: seed.id, windowStart, userId, stream: "BUCKET" })),
        skipDuplicates: true,
      });
      return candidates.length;
    }});
  }

  async function reconcileFeatured({ userId, seed, windowStart, capable, autoJoinFeaturedRaces }) {
    if (!capable || !autoJoinFeaturedRaces || now() >= windowStart) return false;
    const candidate = await prisma.raceParticipant.findFirst({
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
    if (!candidate) return false;
    return prisma.$transaction(async (tx) => {
      await acquireWriteFence(tx, candidate.raceId);
      await acquireGlobalLock(tx);
      await lockUsers(tx, [userId]);
      await lockCompetitions(tx, { raceIds: [candidate.raceId] });
      await acquireSeededWindowLock(tx, seed.id, windowStart);
      if (await readWindowMode({ prisma: tx, seedId: seed.id, windowStart }) !== "BUCKET") return false;
      if (now() >= windowStart) return false;
      const bucketCount = await tx.seededRaceBucket.count({
        where: { seedId: seed.id, windowStart },
      });
      const membership = await tx.seededRaceWindowMembership.findUnique({
        where: {
          seedId_windowStart_userId: { seedId: seed.id, windowStart, userId },
        },
      });
      if (bucketCount || membership?.stream === "BUCKET") return false;
      const participant = await tx.raceParticipant.findFirst({
        where: {
          userId,
          status: "ACCEPTED",
          race: { seedId: seed.id, seededBucketId: null, status: "PENDING", scheduledStartAt: windowStart },
        },
        select: { id: true, raceId: true },
      });
      if (
        !participant ||
        participant.raceId !== candidate.raceId ||
        membership?.stream !== "LEGACY"
      ) {
        return false;
      }
      await tx.raceParticipant.delete({ where: { id: participant.id } });
      await tx.seededRaceWindowMembership.update({
        where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId } },
        data: { stream: "BUCKET", raceId: null },
      });
      return true;
    }, { timeout: 15_000, maxWait: 10_000 });
  }

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
    await withSeededWindowLock({ prisma, seedId: seed.id, windowStart, fn: async (tx) => {
      if (now() >= windowStart) {
        throw new SeededBucketError("Window is finalized", 409, "WINDOW_FINALIZED");
      }
      if (await readWindowMode({ prisma: tx, seedId: seed.id, windowStart }) !== "BUCKET") {
        throw new SeededBucketError("Seeded bucket matching is unavailable", 503, "MATCHING_UNAVAILABLE");
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
    }});
    return { elected: true, raceId: null, finalizesAt: windowStart, windowEnd };
  }

  async function finalise({ seed, windowStart, windowEnd }) {
    // Elections close at windowStart, but materialization may safely recover
    // later in the same window: it consumes only durable BUCKET memberships
    // elected before the boundary. This prevents a missed cron tick or rolled-
    // back transaction from stranding the cohort for the entire day/week.
    const recovering = now() >= windowStart;
    if (now() >= windowEnd) return [];
    if (
      (await readWindowMode({ prisma, seedId: seed.id, windowStart })) !==
      "BUCKET"
    ) return [];
    const seededChallenge = ["DAILY_10K", "WEEKLY_50K"].includes(seed.kind);
    // These values are stamped exactly as the legacy renewal path stamps
    // them. Bucket matching must never silently alter a seeded race's payout
    // economics merely because its participant field is private.
    const fundedPrizePools = await settings.getFlag("fundedPrizePoolsEnabled");
    const geometricPayouts = await settings.getFlag(
      "seededGeometricPayoutsEnabled",
    );
    const payoutRoundingV1Enabled = await settings.getFlag(
      "payoutRoundingV1Enabled",
    );
    const prizeStamp = newRacePrizeStamp();

    const alreadyFinalized = await prisma.seededRaceBucket.findMany({
      where: { seedId: seed.id, windowStart },
    });
    if (alreadyFinalized.length) return recovering ? [] : alreadyFinalized;

    // Matching history and friendship reads are immutable inputs for this
    // window but can be large. Build the plan outside the lock-holding write
    // transaction, then compare the elected-user snapshot under the window
    // advisory lock. A concurrent election causes one fresh-plan retry rather
    // than extending the transaction or committing a stale plan.
    async function snapshotPlan() {
      const elected = await prisma.seededRaceWindowMembership.findMany({
        where: { seedId: seed.id, windowStart, stream: "BUCKET" },
        select: { userId: true }, orderBy: { userId: "asc" },
      });
      if (!elected.length) return { elected, allElected: elected, plan: [] };
      // Seeded daily/weekly challenges are guaranteed featured benefits. The
      // funded-exposure caps apply to user-created funded races only.
      const eligible = elected;
      if (!eligible.length) return { elected, allElected: elected, plan: [] };
      const candidates = await matchStepsForCandidates({
        prisma,
        candidates: eligible,
        seed,
        windowStart,
      });
      const friendships = await prisma.friendship.findMany({
        where: { status: "ACCEPTED", OR: [{ requesterId: { in: eligible.map((e) => e.userId) } }, { addresseeId: { in: eligible.map((e) => e.userId) } }] },
        select: { requesterId: true, addresseeId: true },
      });
      return {
        elected: eligible,
        allElected: elected,
          plan: planBuckets(
          candidates,
          friendships.map((row) => ({
            userAId: row.requesterId,
            userBId: row.addresseeId,
          })),
          cohortMinimumForSeed(seed),
          cohortMaximumForSeed(seed),
        ),
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await snapshotPlan();
      if (!snapshot.elected.length) return [];
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          const maxDurationDays = seed.cadence === "WEEKLY" ? 7 : 1;
          const fundedExposureStamp = computeRaceExposureStamp({
            maxDurationDays,
            prizeCoinUnit: prizeStamp.prizeCoinUnit,
            teamPoolMultBps: null,
          });
          const rows = snapshot.plan.map((group) => ({
            id: randomUUID(),
            raceId: randomUUID(),
            seedId: seed.id,
            windowStart,
            windowEnd,
            status: "PENDING",
            group,
          }));

          // Create the empty competitions first, then take the universal lock
          // sequence once for the whole deterministic cohort: every race C0 in
          // lexical order, global-event lock, sorted users, sorted competition
          // rows. Participant membership is not written until all are held.
          await tx.race.createMany({
            data: rows.map(({ raceId, group }) => ({
              id: raceId,
              seedId: seed.id,
              name: seed.name,
              targetSteps: seed.targetSteps,
              status: "PENDING",
              isPublic: false,
              maxParticipants: cohortMaximumForSeed(seed),
              powerupsEnabled: seed.powerupsEnabled,
              timeBased: seed.timeBased,
              timezone: SEED_TIMEZONE,
              scheduledStartAt: windowStart,
              endsAt: windowEnd,
              maxDurationDays,
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
              payoutRoundingVersion:
                payoutRoundingV1Enabled === true ? 1 : 0,
              powerupStepInterval: normalizePowerupConfig({
                powerupsEnabled: seed.powerupsEnabled ?? false,
              }),
            })),
          });
          await acquireWriteFences(
            tx,
            rows.map((row) => row.raceId),
          );
          await acquireGlobalLock(tx);
          const userIds = snapshot.elected.map((row) => row.userId);
          if (fundedPrizePools === true) {
            await reserveFundedExposures({
              tx,
              reservations: rows.flatMap((row) =>
                row.group.map((candidate) => ({
                  userId: candidate.userId,
                  stamp: fundedExposureStamp,
                  competition: { raceId: row.raceId },
                })),
              ),
              enforceLimits: !seededChallenge,
            });
          } else {
            await lockUsers(tx, userIds);
            await lockCompetitions(tx, {
              raceIds: rows.map((row) => row.raceId),
            });
          }

          // Window arbitration comes only AFTER the universal membership lock
          // sequence. reconcileFeatured takes C0 -> global -> user ->
          // competition -> window; taking window first here deadlocked the two
          // paths on staging. Empty races and any exposure heals above remain
          // uncommitted until this recheck passes. A stale/existing outcome is
          // signalled by throwing so the whole transaction rolls back.
          await acquireSeededWindowLock(tx, seed.id, windowStart);
          if (now() >= windowEnd) {
            const error = new Error("Seeded bucket window ended");
            error.seededFinalizationOutcome = "WINDOW_ENDED";
            throw error;
          }
          if (
            (await readWindowMode({ prisma: tx, seedId: seed.id, windowStart })) !==
            "BUCKET"
          ) {
            const error = new Error("Seeded bucket mode changed");
            error.seededFinalizationOutcome = "MODE_CHANGED";
            throw error;
          }
          const existing = await tx.seededRaceBucket.findMany({
            where: { seedId: seed.id, windowStart },
          });
          if (existing.length) {
            const error = new Error("Seeded buckets already finalized");
            error.seededFinalizationOutcome = "EXISTING";
            error.rows = existing;
            throw error;
          }
          const lockedElected = await tx.seededRaceWindowMembership.findMany({
            where: { seedId: seed.id, windowStart, stream: "BUCKET" },
            select: { userId: true },
            orderBy: { userId: "asc" },
          });
          const remainingElected = lockedElected;
          if (
            remainingElected.length !== snapshot.elected.length ||
            remainingElected.some(
              (row, index) => row.userId !== snapshot.elected[index].userId,
            )
          ) {
            const error = new Error("Seeded bucket election changed");
            error.seededFinalizationOutcome = "RETRY";
            throw error;
          }

          await tx.seededRaceBucket.createMany({
            data: rows.map(({ id, raceId }) => ({
              id,
              seedId: seed.id,
              windowStart,
              windowEnd,
              raceId,
              status: "PENDING",
            })),
          });
          for (const row of rows) {
            await tx.race.update({
              where: { id: row.raceId },
              data: { seededBucketId: row.id },
            });
          }

          const participantRows = rows.flatMap((row) =>
            row.group.map((candidate) => ({
              id: randomUUID(),
              raceId: row.raceId,
              userId: candidate.userId,
              status: "ACCEPTED",
              ...(fundedPrizePools === true
                ? {
                    fundedExposureMillicoins:
                      fundedExposureStamp.exposureMillicoins,
                    fundedExposureRateMillicoinsPerDay:
                      fundedExposureStamp.exposureRateMillicoinsPerDay,
                  }
                : {}),
              bucketId: row.id,
              matchSteps: candidate.matchSteps,
            })),
          );
          await tx.raceParticipant.createMany({
            data: participantRows.map(
              ({ bucketId: _bucketId, matchSteps: _matchSteps, ...row }) => row,
            ),
          });
          await tx.seededRaceBucketAssignment.createMany({
            data: participantRows.map((participant) => ({
              bucketId: participant.bucketId,
              userId: participant.userId,
              seedId: seed.id,
              windowStart,
              raceParticipantId: participant.id,
              matchSteps: participant.matchSteps,
              state: "FINAL",
            })),
          });
          for (const row of rows) {
            const updated = await tx.seededRaceWindowMembership.updateMany({
              where: {
                seedId: seed.id,
                windowStart,
                stream: "BUCKET",
                userId: { in: row.group.map((candidate) => candidate.userId) },
                raceId: null,
              },
              data: { raceId: row.raceId },
            });
            if (updated.count !== row.group.length) {
              throw new Error("Seeded bucket membership snapshot changed during finalization");
            }
          }
          return {
            rows: rows.map(({ group: _group, ...row }) => row),
          };
        }, FINALIZATION_TRANSACTION_OPTIONS);
        const finalizedRows = outcome.rows;
        // This worker writes race and participant rows inside its own
        // transaction, so no command event is emitted for the new members.
        // Invalidate only after commit to prevent a cache refresh from racing
        // the transaction and caching an incomplete membership set.
        await Promise.all(
          snapshot.elected.map((candidate) =>
            invalidateRaceListUser(candidate.userId).catch(() => false)
          ),
        );
        return finalizedRows;
      } catch (error) {
        if (error?.seededFinalizationOutcome === "EXISTING") return error.rows;
        if (error?.seededFinalizationOutcome === "MODE_CHANGED") return [];
        if (error?.seededFinalizationOutcome === "WINDOW_ENDED") return [];
        if (error?.code === "FUNDED_EXPOSURE_LIMIT") continue;
        if (error?.seededFinalizationOutcome !== "RETRY") throw error;
        if (now() >= windowEnd) return [];
      }
    }
    return [];
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
      const currentMode = await readWindowMode({
        prisma,
        seedId: seed.id,
        windowStart: current.windowStart,
      });
      const upcomingMode = await readWindowMode({
        prisma,
        seedId: seed.id,
        windowStart: upcoming.windowStart,
      });
      if (currentMode !== "BUCKET" && upcomingMode !== "BUCKET") continue;
      // Membership predicate is the privacy boundary: never select another
      // player's bucket merely to discover that this viewer has no row. Read
      // each window independently; combining them and ordering by windowStart
      // can incorrectly reuse the current race for the upcoming projection
      // when the viewer belongs to both windows.
      const bucketInclude = {
        race: {
          include: {
            participants: { where: { userId }, select: { status: true } },
          },
        },
      };
      const [currentBucket, upcomingBucket] = await Promise.all([
        currentMode === "BUCKET"
          ? prisma.seededRaceBucket.findFirst({
              where: {
                seedId: seed.id,
                windowStart: current.windowStart,
                OR: [
                  { assignments: { some: { userId } } },
                  {
                    race: {
                      participants: {
                        some: { userId, status: "ACCEPTED" },
                      },
                    },
                  },
                ],
              },
              include: bucketInclude,
            })
          : null,
        upcomingMode === "BUCKET"
          ? prisma.seededRaceBucket.findFirst({
              where: {
                seedId: seed.id,
                windowStart: upcoming.windowStart,
                assignments: { some: { userId } },
              },
              include: bucketInclude,
            })
          : null,
      ]);
      const elected = await prisma.seededRaceWindowMembership.findUnique({
        where: { seedId_windowStart_userId: { seedId: seed.id, windowStart: upcoming.windowStart, userId } },
      });
      const race = currentBucket?.race || null;
      const upcomingRace = upcomingBucket?.race || null;
      const mine = race?.participants?.[0] || null;
      cards.push({
        raceId: race?.id ?? null,
        seedKind: seed.kind,
        name: seed.name,
        endsAt: race?.endsAt ?? current.windowEnd,
        participantCount: mine ? await prisma.raceParticipant.count({ where: { raceId: race.id, status: "ACCEPTED" } }) : 0,
        maxParticipants: race?.maxParticipants ?? cohortMaximumForSeed(seed),
        isFull: false,
        myStatus: mine?.status ?? (elected?.stream === "BUCKET" ? "ELECTED" : null),
        bucketPrivate: true,
        upcoming: {
          raceId: upcomingRace?.status === "PENDING" ? upcomingRace.id : null,
          scheduledStartAt: upcoming.windowStart,
          participantCount: 0,
          maxParticipants: upcomingRace?.status === "PENDING"
            ? (upcomingRace.maxParticipants ?? cohortMaximumForSeed(seed))
            : cohortMaximumForSeed(seed),
          isFull: false,
          myStatus: elected?.stream === "BUCKET" ? "ELECTED" : null,
          bucketPrivate: true,
        },
      });
    }
    return cards;
  }

  async function reconcileFeaturedUser({ userId, capable, autoJoinFeaturedRaces }) {
    if (!capable || !autoJoinFeaturedRaces) return 0;
    const seeds = await prisma.raceSeed.findMany({
      where: { active: true, kind: { in: ["DAILY_10K", "WEEKLY_50K"] } },
    });
    let moved = 0;
    for (const seed of seeds) {
      const upcoming = upcomingWindowFor(seed, now());
      if (await reconcileFeatured({ userId, seed, windowStart: upcoming.windowStart, capable, autoJoinFeaturedRaces })) moved += 1;
    }
    return moved;
  }

  async function selectedBucketSeedKinds(userId) {
    const seeds = await prisma.raceSeed.findMany({
      where: { active: true, kind: { in: ["DAILY_10K", "WEEKLY_50K"] } },
      select: { id: true, kind: true, cadence: true },
    });
    const keys = [];
    for (const seed of seeds) {
      const current = windowFor(seed, now());
      const upcoming = upcomingWindowFor(seed, now());
      keys.push({ seedId: seed.id, windowStart: current.windowStart });
      keys.push({ seedId: seed.id, windowStart: upcoming.windowStart });
    }
    if (!keys.length) return new Set();
    const rows = await prisma.seededRaceWindowMembership.findMany({
      where: { userId, stream: "BUCKET", OR: keys },
      select: { seedId: true },
    });
    const selected = new Set(rows.map((row) => row.seedId));
    return new Set(seeds.filter((seed) => selected.has(seed.id)).map((seed) => seed.kind));
  }

  async function bucketModeWindowKeys({ userId = null } = {}) {
    const seeds = await prisma.raceSeed.findMany({
      where: { active: true, kind: { in: ["DAILY_10K", "WEEKLY_50K"] } },
      select: { id: true, cadence: true },
    });
    const windows = [];
    for (const seed of seeds) {
      for (const period of [windowFor(seed, now()), upcomingWindowFor(seed, now())]) {
        if (await readWindowMode({ prisma, seedId: seed.id, windowStart: period.windowStart }) === "BUCKET") {
          windows.push({ seedId: seed.id, windowStart: period.windowStart });
        }
      }
    }
    if (!userId || !windows.length) return windows;
    const selected = await prisma.seededRaceWindowMembership.findMany({
      where: { userId, stream: "BUCKET", OR: windows },
      select: { seedId: true, windowStart: true },
    });
    const selectedKeys = new Set(selected.map((row) => `${row.seedId}:${new Date(row.windowStart).toISOString()}`));
    return windows.filter((row) => selectedKeys.has(`${row.seedId}:${new Date(row.windowStart).toISOString()}`));
  }

  return { elect, electAutomatic, finalise, featuredCards, reconcileFeatured, reconcileFeaturedUser, selectedBucketSeedKinds, bucketModeWindowKeys };
}

module.exports = { buildSeededRaceBuckets, SeededBucketError, windowFor, upcomingWindowFor, supportsBuckets, claimLegacyStream, planBuckets, matchStepsForCandidates, BUCKET_CAPACITY, DAILY_COHORT_MINIMUM, DAILY_COHORT_MAXIMUM, WEEKLY_COHORT_MINIMUM, WEEKLY_COHORT_MAXIMUM, cohortMinimumForSeed, cohortMaximumForSeed, BUCKET_FEATURE, SEED_TIMEZONE, acquireSeededWindowLock, withSeededWindowLock, readWindowMode, stampWindowMode, splitFundedExposureCandidates };
