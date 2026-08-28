const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildSeededRaceBuckets,
  upcomingWindowFor,
} = require("../../src/modules/races/services/seededRaceBuckets");
const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const {
  acquireGlobalEnrollmentLock,
} = require("../../src/modules/steps/services/globalEventEnrollment");
const {
  acquireRaceWriteFences,
} = require("../../src/modules/races/services/raceWriteFence");

const FEATURES = { "X-Client-Features": "seeded_race_buckets" };

describe("private seeded race buckets (integration)", () => {
  let baseUrl;
  before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
    // The runtime flag selects only a newly-created window. Existing test
    // fixtures are intentionally explicit about their durable mode.
    for (const kind of ["DAILY_10K", "WEEKLY_50K"]) {
      const seed = await prisma.raceSeed.findUnique({ where: { kind } });
      const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
      await prisma.seededRaceWindowModeRecord.create({
        data: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      });
    }
  });

  it("keeps GET virtual, elects only through explicit UPCOMING POST, and persists ELECTED", async () => {
    const { user, token } = await createTestUser();
    const before = await request(baseUrl, "GET", "/races/featured", { token, headers: FEATURES });
    assert.equal(before.status, 200);
    const card = (await before.json()).races.find((row) => row.seedKind === "DAILY_10K");
    assert.equal(card.raceId, null);
    assert.equal(card.bucketPrivate, true);
    assert.equal(card.maxParticipants, 35);
    assert.equal(card.myStatus, null);
    const weeklyCard = (await request(baseUrl, "GET", "/races/featured", {
      token,
      headers: FEATURES,
    }).then((response) => response.json())).races.find((row) => row.seedKind === "WEEKLY_50K");
    assert.equal(weeklyCard.maxParticipants, 100);
    const countBefore = await prisma.seededRaceWindowMembership.count();
    assert.equal(countBefore, 0, "GET has no election side effect");

    const elected = await request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
      token, headers: FEATURES, body: { window: "UPCOMING" },
    });
    assert.equal(elected.status, 202);
    assert.deepEqual(Object.keys(await elected.json()).sort(), ["elected", "finalizesAt", "raceId"]);
    const membership = await prisma.seededRaceWindowMembership.findFirst({ where: { userId: user.id } });
    assert.equal(membership.stream, "BUCKET");
    const after = await request(baseUrl, "GET", "/races/featured", { token, headers: FEATURES });
    const electedCard = (await after.json()).races.find((row) => row.seedKind === "DAILY_10K");
    assert.equal(electedCard.raceId, null);
    assert.equal(electedCard.myStatus, "ELECTED");
  });

  it("rejects missing capability and invalid requested window without durable election", async () => {
    const { token } = await createTestUser();
    const noFeature = await request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
      token, body: { window: "UPCOMING" },
    });
    assert.equal(noFeature.status, 503);
    assert.equal((await noFeature.json()).code, "MATCHING_UNAVAILABLE");
    const invalid = await request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
      token, headers: FEATURES, body: { window: "NOW" },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "INVALID_WINDOW");
    assert.equal(await prisma.seededRaceWindowMembership.count(), 0);
  });

  it("makes concurrent explicit elections idempotent in one authoritative bucket stream", async () => {
    const { user, token } = await createTestUser();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
          token,
          headers: FEATURES,
          body: { window: "UPCOMING" },
        })
      )
    );
    assert.deepEqual(responses.map((response) => response.status), [202, 202, 202, 202]);
    assert.equal(
      await prisma.seededRaceWindowMembership.count({ where: { userId: user.id } }),
      1
    );
  });

  it("does not overwrite a pre-existing legacy stream election", async () => {
    const { user, token } = await createTestUser();
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart } = upcomingWindowFor(seed, new Date());
    await prisma.seededRaceWindowMembership.create({
      data: { seedId: seed.id, windowStart, userId: user.id, stream: "LEGACY" },
    });
    const response = await request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
      token,
      headers: FEATURES,
      body: { window: "UPCOMING" },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LEGACY_STREAM_ELECTED");
  });

  it("reconcile waits for the legacy race C0 before deleting membership", async () => {
    const { user, token } = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { autoJoinFeaturedRaces: true },
    });
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const race = await prisma.race.create({
      data: {
        seedId: seed.id,
        name: "Legacy reconcile",
        targetSteps: seed.targetSteps,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        timezone: "America/New_York",
        maxParticipants: 100,
        maxDurationDays: 1,
        scheduledStartAt: windowStart,
        endsAt: windowEnd,
      },
    });
    const participant = await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED" },
    });
    await prisma.seededRaceWindowMembership.create({
      data: {
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "LEGACY",
        raceId: race.id,
      },
    });

    let releaseFence;
    let markFence;
    const fenced = new Promise((resolve) => { markFence = resolve; });
    const release = new Promise((resolve) => { releaseFence = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await RaceResolutionJobV2.acquireForWrite(tx, { raceId: race.id });
      markFence();
      await release;
    }, { timeout: 15_000 });
    await fenced;
    const featured = request(baseUrl, "GET", "/races/featured", {
      token,
      headers: FEATURES,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        await prisma.raceParticipant.count({ where: { id: participant.id } }),
        1,
      );
    } finally {
      releaseFence();
      await holder;
    }
    assert.equal((await featured).status, 200);
    assert.equal(await prisma.raceParticipant.count({ where: { id: participant.id } }), 0);
  });

  it("finalization cannot deadlock with legacy reconciliation at the window lock", async () => {
    const legacy = await createTestUser({ autoJoinFeaturedRaces: true });
    const bucketUsers = await Promise.all([createTestUser(), createTestUser()]);
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const legacyRace = await prisma.race.create({
      data: {
        seedId: seed.id,
        name: "Legacy reconcile lock-order fixture",
        targetSteps: seed.targetSteps,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        timezone: "America/New_York",
        maxParticipants: 100,
        maxDurationDays: 1,
        scheduledStartAt: windowStart,
        endsAt: windowEnd,
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: legacyRace.id, userId: legacy.user.id, status: "ACCEPTED" },
    });
    await prisma.seededRaceWindowMembership.createMany({
      data: [
        {
          seedId: seed.id,
          windowStart,
          userId: legacy.user.id,
          stream: "LEGACY",
          raceId: legacyRace.id,
        },
        ...bucketUsers.map(({ user }) => ({
          seedId: seed.id,
          windowStart,
          userId: user.id,
          stream: "BUCKET",
        })),
      ],
    });

    let signalGlobalHeld;
    let releaseGlobal;
    const globalHeld = new Promise((resolve) => { signalGlobalHeld = resolve; });
    const release = new Promise((resolve) => { releaseGlobal = resolve; });
    let signalFencesHeld;
    const fencesHeld = new Promise((resolve) => { signalFencesHeld = resolve; });
    const reconciler = buildSeededRaceBuckets({
      prisma,
      appSettings,
      acquireGlobalEnrollmentLock: async (tx) => {
        await acquireGlobalEnrollmentLock(tx);
        signalGlobalHeld();
        await release;
      },
    });
    const finalizer = buildSeededRaceBuckets({
      prisma,
      now: () => new Date(windowStart.getTime() - 2 * 60 * 1000),
      appSettings,
      acquireRaceWriteFences: async (tx, raceIds) => {
        const locked = await acquireRaceWriteFences(tx, raceIds);
        signalFencesHeld();
        return locked;
      },
    });

    const reconciling = reconciler.reconcileFeatured({
      userId: legacy.user.id,
      seed,
      windowStart,
      capable: true,
      autoJoinFeaturedRaces: true,
    });
    await globalHeld;
    const finalizing = finalizer.finalise({ seed, windowStart, windowEnd });
    await fencesHeld;
    releaseGlobal();

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("finalise/reconcile lock-order timeout")), 4_000);
    });
    const [reconciled, buckets] = await Promise.race([
      Promise.all([reconciling, finalizing]),
      timeout,
    ]);
    assert.equal(reconciled, true);
    assert.ok(buckets.length > 0);
  });

  it("finalizes the next ET window before its boundary and creates no online bucket at or after it", async () => {
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const [alice, bob] = await Promise.all([createTestUser(), createTestUser()]);
    // 23:58 ET: renewal's five-minute pre-boundary pass targets the following
    // day, so the deterministic plan exists before the card becomes live.
    const beforeBoundary = new Date("2026-08-12T03:58:00.000Z");
    const { windowStart, windowEnd } = upcomingWindowFor(seed, beforeBoundary);
    await prisma.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      create: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      update: {},
    });
    await prisma.seededRaceWindowMembership.createMany({
      data: [alice, bob].map(({ user }) => ({
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "BUCKET",
      })),
    });
    const matcher = buildSeededRaceBuckets({
      prisma,
      now: () => beforeBoundary,
      appSettings,
    });
    const buckets = await matcher.finalise({ seed, windowStart, windowEnd });
    assert.equal(buckets.length, 1);
    const persisted = await prisma.seededRaceBucket.findUnique({
      where: { raceId: buckets[0].raceId },
      include: { race: true, assignments: true },
    });
    assert.equal(persisted.race.isPublic, false);
    assert.equal(persisted.race.maxParticipants, 35);
    assert.equal(persisted.assignments.length, 2);
    assert.equal(persisted.race.prizeCalculationVersion, 2);
    assert.equal(persisted.race.prizeCoinUnit, 10);
    assert.equal(persisted.race.prizePoolMaxCoins, 8000);
    const exposureRows = await prisma.raceParticipant.findMany({
      where: { raceId: persisted.race.id },
      orderBy: { userId: "asc" },
    });
    assert.equal(exposureRows.length, 2);
    for (const row of exposureRows) {
      assert.equal(row.fundedExposureMillicoins, 10_000);
      assert.equal(row.fundedExposureRateMillicoinsPerDay, 10_000);
    }

    const afterBoundary = buildSeededRaceBuckets({
      prisma,
      now: () => windowStart,
      appSettings,
    });
    assert.deepEqual(
      await afterBoundary.finalise({ seed, windowStart, windowEnd }),
      [],
      "the boundary never mints an online/late bucket"
    );
  });

  it("gives a 16-person Daily cohort bounded onboarding headroom up to 35", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const beforeBoundary = new Date("2026-08-12T03:58:00.000Z");
    const { windowStart, windowEnd } = upcomingWindowFor(seed, beforeBoundary);
    await prisma.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      create: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      update: {},
    });
    const users = await Promise.all(Array.from({ length: 16 }, () => createTestUser()));
    await prisma.seededRaceWindowMembership.createMany({
      data: users.map(({ user }) => ({
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "BUCKET",
      })),
    });
    const matcher = buildSeededRaceBuckets({
      prisma,
      now: () => beforeBoundary,
      appSettings,
    });
    const buckets = await matcher.finalise({ seed, windowStart, windowEnd });
    assert.equal(buckets.length, 1);
    const persisted = await prisma.seededRaceBucket.findUnique({
      where: { raceId: buckets[0].raceId },
      include: { race: true, assignments: true },
    });
    assert.equal(persisted.race.maxParticipants, 35);
    assert.equal(persisted.assignments.length, 16);
  });

  it("splits a 97-person Daily friendship chain into capped balanced cohorts", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const beforeBoundary = new Date(windowStart.getTime() - 2 * 60 * 1000);
    await prisma.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      create: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      update: {},
    });
    const users = await Promise.all(Array.from({ length: 97 }, () => createTestUser()));
    await prisma.seededRaceWindowMembership.createMany({
      data: users.map(({ user }) => ({
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "BUCKET",
      })),
    });
    await prisma.friendship.createMany({
      data: Array.from({ length: 96 }, (_, index) => ({
        requesterId: users[index].user.id,
        addresseeId: users[index + 1].user.id,
        status: "ACCEPTED",
      })),
    });

    const matcher = buildSeededRaceBuckets({
      prisma,
      now: () => beforeBoundary,
      appSettings,
    });
    const buckets = await matcher.finalise({ seed, windowStart, windowEnd });
    assert.equal(buckets.length, 3);
    const persisted = await prisma.seededRaceBucket.findMany({
      where: { id: { in: buckets.map(({ id }) => id) } },
      include: { race: true, assignments: true },
      orderBy: { race: { createdAt: "asc" } },
    });
    assert.deepEqual(
      persisted.map(({ assignments }) => assignments.length),
      [33, 32, 32],
    );
    assert.deepEqual(
      persisted.map(({ race }) => race.maxParticipants),
      [35, 35, 35],
    );
  });

  it("finalizes Daily 61 into 31/30 assignments with a hard capacity of 35", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const realNow = new Date();
    const { windowStart, windowEnd } = upcomingWindowFor(seed, realNow);
    const beforeBoundary = new Date(windowStart.getTime() - 2 * 60 * 1000);
    await prisma.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      create: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      update: {},
    });
    const users = await Promise.all(Array.from({ length: 61 }, () => createTestUser()));
    await prisma.seededRaceWindowMembership.createMany({
      data: users.map(({ user }) => ({
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "BUCKET",
      })),
    });
    const legacy = await createTestUser();
    await prisma.seededRaceWindowMembership.create({
      data: {
        seedId: seed.id,
        windowStart,
        userId: legacy.user.id,
        stream: "LEGACY",
      },
    });

    const renew = buildRenewSeededRaces({
      prisma,
      now: () => beforeBoundary,
      appSettings,
      logger: { log() {}, error() {} },
    });
    const renewalResults = await renew();
    assert.equal(
      renewalResults.filter(({ action, seedKind }) =>
        action === "finalized-buckets" && seedKind === "DAILY_10K").length,
      1,
    );
    const buckets = await prisma.seededRaceBucket.findMany({
      where: { seedId: seed.id, windowStart },
      select: { id: true, raceId: true },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map(({ raceId }) => raceId).sort(),
      (await prisma.race.findMany({
        where: { id: { in: buckets.map(({ raceId }) => raceId) } },
        select: { id: true },
      })).map(({ id }) => id).sort(),
    );
    const persisted = await prisma.seededRaceBucket.findMany({
      where: { seedId: seed.id, windowStart },
      include: { race: true, assignments: true },
      orderBy: { race: { createdAt: "asc" } },
    });
    assert.deepEqual(persisted.map(({ race }) => race.maxParticipants), [35, 35]);
    assert.deepEqual(persisted.map(({ assignments }) => assignments.length), [31, 30]);

    await renew();
    assert.deepEqual(
      (await prisma.seededRaceBucket.findMany({
        where: { seedId: seed.id, windowStart },
        orderBy: { createdAt: "asc" },
        select: { id: true, raceId: true },
      })).map(({ id, raceId }) => ({ id, raceId })),
      buckets.map(({ id, raceId }) => ({ id, raceId })),
      "repeated renewal reuses the finalized rows",
    );

    const late = await createTestUser();
    await prisma.seededRaceWindowMembership.create({
      data: { seedId: seed.id, windowStart, userId: late.user.id, stream: "BUCKET" },
    });
    await prisma.raceParticipant.create({
      data: { raceId: buckets[0].raceId, userId: late.user.id, status: "ACCEPTED" },
    });
    await renew();
    assert.deepEqual(
      (await prisma.seededRaceBucket.findMany({
        where: { seedId: seed.id, windowStart },
        select: { id: true },
      })).map(({ id }) => id).sort(),
      buckets.map(({ id }) => id).sort(),
      "late membership cannot repack finalized rows",
    );
    assert.equal(
      await prisma.seededRaceBucketAssignment.count({
        where: { seedId: seed.id, windowStart, userId: late.user.id },
      }),
      0,
      "late users never enter finalized private bucket assignments",
    );
    assert.equal(
      await prisma.seededRaceBucketAssignment.count({
        where: { seedId: seed.id, windowStart, userId: legacy.user.id },
      }),
      0,
      "legacy stream users never enter private bucket assignments",
    );

    const featured = await request(baseUrl, "GET", "/races/featured", {
      token: users[0].token,
      headers: FEATURES,
    });
    assert.equal(featured.status, 200);
    const dailyCard = (await featured.json()).races.find((row) => row.seedKind === "DAILY_10K");
    assert.equal(dailyCard.maxParticipants, 35);
    assert.ok(
      buckets.some(({ raceId }) => raceId === dailyCard.upcoming.raceId),
      "featured upcoming card points at one of the viewer's persisted buckets",
    );
    const upcomingPersisted = persisted.find(
      ({ race }) => race.id === dailyCard.upcoming.raceId,
    );
    assert.equal(
      dailyCard.upcoming.maxParticipants,
      upcomingPersisted?.race.maxParticipants,
    );

    const legacyFeatured = await request(baseUrl, "GET", "/races/featured", {
      token: users[0].token,
    });
    assert.equal(legacyFeatured.status, 200);
    assert.equal(
      (await legacyFeatured.json()).races.some((row) => row.raceId === buckets[0].raceId),
      false,
      "legacy clients never receive a private bucket race",
    );
  });

  it("uses a 75-person Weekly target with a hard capacity of 100", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "WEEKLY_50K" } });
    const beforeBoundary = new Date("2026-08-10T03:58:00.000Z");
    const { windowStart, windowEnd } = upcomingWindowFor(seed, beforeBoundary);
    await prisma.seededRaceWindowModeRecord.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      create: { seedId: seed.id, windowStart, windowEnd, mode: "BUCKET" },
      update: {},
    });
    const users = await Promise.all(Array.from({ length: 151 }, () => createTestUser()));
    await prisma.seededRaceWindowMembership.createMany({
      data: users.map(({ user }) => ({
        seedId: seed.id,
        windowStart,
        userId: user.id,
        stream: "BUCKET",
      })),
    });
    const renew = buildRenewSeededRaces({
      prisma,
      now: () => beforeBoundary,
      appSettings,
      logger: { log() {}, error() {} },
    });
    const renewalResults = await renew();
    assert.equal(
      renewalResults.filter(({ action, seedKind }) => action === "finalized-buckets" && seedKind === "WEEKLY_50K").length,
      1
    );
    const buckets = await prisma.seededRaceBucket.findMany({
      where: { seedId: seed.id, windowStart },
      select: { id: true },
    });
    assert.equal(buckets.length, 2);
    const persisted = await prisma.seededRaceBucket.findMany({
      where: { id: { in: buckets.map(({ id }) => id) } },
      include: { race: true, assignments: true },
      orderBy: { race: { createdAt: "asc" } },
    });
    assert.deepEqual(persisted.map(({ race }) => race.maxParticipants), [100, 100]);
    assert.deepEqual(persisted.map(({ assignments }) => assignments.length), [76, 75]);
    await renew();
    assert.equal(
      await prisma.seededRaceBucket.count({ where: { seedId: seed.id, windowStart } }),
      2
    );
  });

  it("finalizes a production-sized 450-user funded cohort inside the 5s budget without concurrent-query warnings", async () => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      await appSettings.setFlag("fundedPrizePoolsEnabled", true);
      const seed = await prisma.raceSeed.findUnique({
        where: { kind: "DAILY_10K" },
      });
      const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
      const userIds = Array.from({ length: 450 }, () => randomUUID());
      await prisma.user.createMany({
        data: userIds.map((id, index) => ({
          id,
          appleId: `seeded-finalise-scale-${index}`,
          autoJoinFeaturedRaces: true,
          clientFeatures: ["seeded_race_buckets"],
        })),
      });
      await prisma.seededRaceWindowMembership.createMany({
        data: userIds.map((userId) => ({
          seedId: seed.id,
          windowStart,
          userId,
          stream: "BUCKET",
        })),
      });
      const matcher = buildSeededRaceBuckets({
        prisma,
        now: () => new Date(windowStart.getTime() - 2 * 60 * 1000),
        appSettings,
      });

      const startedAt = performance.now();
      const buckets = await matcher.finalise({ seed, windowStart, windowEnd });
      const durationMs = performance.now() - startedAt;
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(buckets.length, 15);
      assert.equal(
        await prisma.raceParticipant.count({
          where: { raceId: { in: buckets.map((bucket) => bucket.raceId) } },
        }),
        450,
      );
      assert.ok(
        durationMs < 5_000,
        `production-sized finalization took ${durationMs.toFixed(1)}ms`,
      );
      assert.equal(
        warnings.some((warning) =>
          /already executing a query|Client\.query/i.test(warning.message),
        ),
        false,
        `unexpected Prisma/pg warning: ${warnings.map((warning) => warning.stack).join("\n")}`,
      );
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("keeps capable cards private and never leaks another user's bucket through public browsing", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await request(baseUrl, "POST", "/races/seeded/DAILY_10K/assign", {
      token: alice.token, headers: FEATURES, body: { window: "UPCOMING" },
    });
    const membership = await prisma.seededRaceWindowMembership.findFirst({ where: { userId: alice.user.id } });
    const seed = await prisma.raceSeed.findUnique({ where: { id: membership.seedId } });
    const race = await prisma.race.create({
      data: {
        seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps, status: "PENDING",
        isPublic: false, timeBased: true, timezone: "America/New_York", maxParticipants: 15,
        maxDurationDays: 1, scheduledStartAt: membership.windowStart,
        endsAt: new Date(membership.windowStart.getTime() + 86_400_000),
      },
    });
    const bucket = await prisma.seededRaceBucket.create({
      data: { seedId: seed.id, windowStart: membership.windowStart, windowEnd: race.endsAt, raceId: race.id },
    });
    await prisma.race.update({ where: { id: race.id }, data: { seededBucketId: bucket.id } });
    const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: alice.user.id, status: "ACCEPTED" } });
    await prisma.seededRaceBucketAssignment.create({
      data: { bucketId: bucket.id, userId: alice.user.id, seedId: seed.id, windowStart: membership.windowStart, raceParticipantId: participant.id, matchSteps: 0, state: "FINAL" },
    });
    await prisma.seededRaceWindowMembership.update({
      where: { seedId_windowStart_userId: { seedId: seed.id, windowStart: membership.windowStart, userId: alice.user.id } },
      data: { raceId: race.id },
    });
    const bobFeatured = await request(baseUrl, "GET", "/races/featured", { token: bob.token, headers: FEATURES });
    const bobCard = (await bobFeatured.json()).races.find((row) => row.seedKind === "DAILY_10K");
    assert.equal(bobCard.raceId, null, "another user's bucket id never reaches this viewer");
    const publicRes = await request(baseUrl, "GET", "/races/public", { token: bob.token, headers: FEATURES });
    assert.equal(publicRes.status, 200);
    assert.equal((await publicRes.json()).races.some((race) => race.seededBucketId), false);
    const discovery = await request(baseUrl, "GET", "/races/discovery-summary", {
      token: bob.token,
      headers: FEATURES,
    });
    assert.equal(discovery.status, 200);
    const discoveryBody = await discovery.json();
    assert.equal(discoveryBody.publicRaceCount, 0);
    assert.equal(
      discoveryBody.featuredRaces.some((card) => card.raceId === race.id),
      false,
      "discovery summary never receives another member's bucket id"
    );
    const frozenFeatured = await request(baseUrl, "GET", "/races/featured", {
      token: bob.token,
    });
    assert.equal(frozenFeatured.status, 200);
    assert.equal(
      (await frozenFeatured.json()).races.some((card) => card.raceId === race.id),
      false,
      "frozen clients never receive a private bucket through the legacy serializer"
    );
    const frozenDiscovery = await request(baseUrl, "GET", "/races/discovery-summary", {
      token: bob.token,
    });
    assert.equal(frozenDiscovery.status, 200);
    assert.equal(
      (await frozenDiscovery.json()).featuredRaces.some((card) => card.raceId === race.id),
      false,
      "frozen discovery cannot select a private bucket as its legacy featured row"
    );
    const frozenHomeSuggestions = await request(baseUrl, "GET", "/home/suggested-races", {
      token: bob.token,
    });
    assert.equal(frozenHomeSuggestions.status, 200);
    assert.equal(
      (await frozenHomeSuggestions.json()).suggestions.some((card) => card.id === race.id),
      false,
      "legacy Home suggestions exclude private bucket rows in SQL"
    );
    const guessedDetail = await request(baseUrl, "GET", `/races/${race.id}`, {
      token: bob.token,
      headers: FEATURES,
    });
    assert.equal(guessedDetail.status, 403, "a guessed bucket id remains member-only");
    const guessedJoin = await request(baseUrl, "POST", `/races/${race.id}/join`, {
      token: bob.token,
      headers: FEATURES,
      body: {},
    });
    assert.equal(guessedJoin.status, 403);
    assert.equal((await guessedJoin.json()).code, "RACE_PRIVATE");

    const frozenOwnDetail = await request(baseUrl, "GET", `/races/${race.id}`, {
      token: alice.token,
    });
    assert.equal(frozenOwnDetail.status, 404);
    assert.deepEqual(await frozenOwnDetail.json(), {
      error: "Race not found",
      code: "RACE_NOT_FOUND",
    });
    const capableOwnDetail = await request(baseUrl, "GET", `/races/${race.id}`, {
      token: alice.token,
      headers: FEATURES,
    });
    assert.equal(capableOwnDetail.status, 200);
    const frozenList = await request(baseUrl, "GET", "/races", {
      token: alice.token,
    });
    assert.equal(frozenList.status, 200);
    assert.equal(
      (await frozenList.json()).active.some((row) => row.id === race.id),
      false,
      "a durable BUCKET member on a tokenless device never receives an unusable bucket card"
    );
    for (const suffix of ["progress", "inventory", "feed", "messages"]) {
      const response = await request(baseUrl, "GET", `/races/${race.id}/${suffix}`, {
        token: alice.token,
      });
      assert.equal(response.status, 404, `tokenless bucket ${suffix} is non-revealing`);
      assert.deepEqual(await response.json(), { error: "Race not found", code: "RACE_NOT_FOUND" });
    }

    // Durable PRUNED assignments retain an audit participant row, but that row
    // must not authorize a former member to read private activity/chat/inventory.
    await prisma.raceParticipant.update({
      where: { id: participant.id },
      data: { status: "DECLINED" },
    });
    await prisma.seededRaceBucketAssignment.update({
      where: { bucketId_userId: { bucketId: bucket.id, userId: alice.user.id } },
      data: { state: "PRUNED" },
    });
    await prisma.race.update({ where: { id: race.id }, data: { status: "ACTIVE" } });
    for (const path of [
      `/races/${race.id}`,
      `/races/${race.id}/feed`,
      `/races/${race.id}/messages`,
      `/races/${race.id}/inventory`,
      `/races/${race.id}/powerups/sneaky-swap-targets`,
    ]) {
      const response = await request(baseUrl, "GET", path, {
        token: alice.token,
        headers: FEATURES,
      });
      assert.equal(response.status, 403, `pruned member must not read ${path}`);
    }
  });
});
