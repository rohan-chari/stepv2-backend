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
const { filterInactiveUserIds } = require("./seededInactivity");
const {
  computeRaceExposureStamp,
  isFundedPrizeV2Enabled,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  reserveFundedExposures,
  resolveRacePrizeStamp,
} = require("./fundedExposure");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("./raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");

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

function windowLockKey(seedId, windowStart) {
  return `seeded-bucket:${seedId}:${new Date(windowStart).toISOString()}`;
}

// Lock ordering is intentional and shared by every cross-stream operation:
// take the window advisory lock before touching a race/participant row, then
// re-read durable policy and membership while that lock is held.
async function withSeededWindowLock({ prisma, seedId, windowStart, fn }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${windowLockKey(seedId, windowStart)}))`;
    return fn(tx);
  });
}

async function readWindowMode({ prisma, seedId, windowStart }) {
  if (!prisma.seededRaceWindowModeRecord) return "LEGACY";
  const row = await prisma.seededRaceWindowModeRecord.findUnique({
    where: { seedId_windowStart: { seedId, windowStart: new Date(windowStart) } },
    select: { mode: true },
  });
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${windowLockKey(seed.id, windowStart)}))`;
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
    if (now() >= windowStart) return [];
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
    const prizeStamp = isFundedPrizeV2Enabled()
      ? newRacePrizeStamp()
      : resolveRacePrizeStamp({ prizeCalculationVersion: 1 });
    return withSeededWindowLock({ prisma, seedId: seed.id, windowStart, fn: async (tx) => {
      if (await readWindowMode({ prisma: tx, seedId: seed.id, windowStart }) !== "BUCKET") return [];
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
        const maxDurationDays = seed.cadence === "WEEKLY" ? 7 : 1;
        const fundedExposureStamp = computeRaceExposureStamp({
          maxDurationDays,
          prizeCoinUnit: prizeStamp.prizeCoinUnit,
          teamPoolMultBps: null,
        });
        const race = await tx.race.create({
          data: {
            seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps, status: "PENDING", isPublic: false,
            maxParticipants: BUCKET_CAPACITY, powerupsEnabled: seed.powerupsEnabled,
            timeBased: seed.timeBased, timezone: SEED_TIMEZONE, scheduledStartAt: windowStart, endsAt: windowEnd,
            maxDurationDays, payoutPreset: "TOP_HALF",
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
            powerupStepInterval: normalizePowerupConfig({
              powerupsEnabled: seed.powerupsEnabled ?? false,
            }),
          },
        });
        const userIds = group.map((candidate) => candidate.userId).sort();
        await acquireWriteFence(tx, race.id);
        await acquireGlobalLock(tx);
        await lockUsers(tx, userIds);
        if (fundedPrizePools === true) {
          await reserveFundedExposures({
            tx,
            reservations: group.map((candidate) => ({
              userId: candidate.userId,
              stamp: fundedExposureStamp,
              competition: { raceId: race.id },
            })),
          });
        } else {
          await lockCompetitions(tx, { raceIds: [race.id] });
        }
        const bucket = await tx.seededRaceBucket.create({ data: { seedId: seed.id, windowStart, windowEnd, raceId: race.id, status: "PENDING" } });
        await tx.race.update({ where: { id: race.id }, data: { seededBucketId: bucket.id } });
        for (const candidate of group) {
          const participant = await tx.raceParticipant.create({ data: {
            raceId: race.id,
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
          } });
          await tx.seededRaceBucketAssignment.create({ data: { bucketId: bucket.id, userId: candidate.userId, seedId: seed.id, windowStart, raceParticipantId: participant.id, matchSteps: candidate.matchSteps, state: "FINAL" } });
          await tx.seededRaceWindowMembership.update({ where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: candidate.userId } }, data: { raceId: race.id } });
        }
        rows.push(bucket);
      }
      return rows;
    }});
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

module.exports = { buildSeededRaceBuckets, SeededBucketError, windowFor, upcomingWindowFor, supportsBuckets, claimLegacyStream, planBuckets, matchStepsForCandidates, BUCKET_CAPACITY, BUCKET_FEATURE, withSeededWindowLock, readWindowMode, stampWindowMode };
