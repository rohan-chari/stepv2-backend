const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");
const { upcomingWindowFor } = require("../../src/modules/races/services/seededRaceBuckets");

const BUCKET_HEADERS = { "X-Client-Features": "seeded_race_buckets" };

async function stampMode(seedId, windowStart, windowEnd, mode) {
  return prisma.seededRaceWindowModeRecord.upsert({
    where: { seedId_windowStart: { seedId, windowStart } },
    create: { seedId, windowStart, windowEnd, mode },
    update: {},
  });
}

async function createPendingLegacyRace(seed, windowStart, windowEnd) {
  return prisma.race.create({
    data: {
      seedId: seed.id,
      name: seed.name,
      targetSteps: seed.targetSteps,
      status: "PENDING",
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: seed.cadence === "WEEKLY" ? 7 : 1,
      scheduledStartAt: windowStart,
      endsAt: windowEnd,
    },
  });
}

describe("seeded race durable window modes (integration)", () => {
  let baseUrl;

  before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
  });

  it("stamps a new BUCKET window once and bulk-elects capable auto-join users while legacy users stay in its public race", async () => {
    const capable = await createTestUser({
      autoJoinFeaturedRaces: true,
      clientFeatures: ["seeded_race_buckets"],
    });
    const legacy = await createTestUser({ autoJoinFeaturedRaces: true });
    const renew = buildRenewSeededRaces({ prisma, logger: { log() {}, error() {} } });

    await renew();

    const daily = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart } = upcomingWindowFor(daily, new Date());
    const mode = await prisma.seededRaceWindowModeRecord.findUnique({
      where: { seedId_windowStart: { seedId: daily.id, windowStart } },
    });
    assert.equal(mode?.mode, "BUCKET");
    const memberships = await prisma.seededRaceWindowMembership.findMany({
      where: { seedId: daily.id, windowStart, userId: { in: [capable.user.id, legacy.user.id] } },
      orderBy: { userId: "asc" },
    });
    assert.equal(memberships.find((row) => row.userId === capable.user.id)?.stream, "BUCKET");
    assert.equal(memberships.find((row) => row.userId === legacy.user.id)?.stream, "LEGACY");
    const nextLegacy = await prisma.race.findFirst({
      where: { seedId: daily.id, status: "PENDING", scheduledStartAt: windowStart, seededBucketId: null },
    });
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: nextLegacy.id, userId: capable.user.id } }), 0);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: nextLegacy.id, userId: legacy.user.id } }), 1);
  });

  it("moves a capable auto-join PENDING legacy membership into the stamped BUCKET stream on Featured retrieval and is idempotent", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const legacyRace = await createPendingLegacyRace(seed, windowStart, windowEnd);
    await stampMode(seed.id, windowStart, windowEnd, "BUCKET");
    const account = await createTestUser({ autoJoinFeaturedRaces: true });
    await prisma.raceParticipant.create({
      data: { raceId: legacyRace.id, userId: account.user.id, status: "ACCEPTED" },
    });
    await prisma.seededRaceWindowMembership.create({
      data: { seedId: seed.id, windowStart, userId: account.user.id, stream: "LEGACY", raceId: legacyRace.id },
    });

    const first = await request(baseUrl, "GET", "/races/featured", {
      token: account.token,
      headers: BUCKET_HEADERS,
    });
    assert.equal(first.status, 200);
    const membership = await prisma.seededRaceWindowMembership.findUnique({
      where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: account.user.id } },
    });
    assert.equal(membership.stream, "BUCKET");
    assert.equal(membership.raceId, null);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: account.user.id } }), 0);

    const repeat = await request(baseUrl, "GET", "/races/featured", {
      token: account.token,
      headers: BUCKET_HEADERS,
    });
    assert.equal(repeat.status, 200);
    assert.equal(await prisma.seededRaceWindowMembership.count({ where: { seedId: seed.id, windowStart, userId: account.user.id } }), 1);
  });

  it("uses stored capability, rather than the token on the preference write, for a stamped BUCKET window", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const legacyRace = await createPendingLegacyRace(seed, windowStart, windowEnd);
    await stampMode(seed.id, windowStart, windowEnd, "BUCKET");
    const capable = await createTestUser({ clientFeatures: ["seeded_race_buckets"] });
    const legacy = await createTestUser();

    assert.equal((await request(baseUrl, "PUT", "/auth/me/featured-auto-join", {
      token: capable.token, body: { enabled: true },
    })).status, 200);
    assert.equal((await request(baseUrl, "PUT", "/auth/me/featured-auto-join", {
      token: legacy.token, body: { enabled: true },
    })).status, 200);

    const rows = await prisma.seededRaceWindowMembership.findMany({
      where: { seedId: seed.id, windowStart, userId: { in: [capable.user.id, legacy.user.id] } },
    });
    assert.equal(rows.find((row) => row.userId === capable.user.id)?.stream, "BUCKET");
    assert.equal(rows.find((row) => row.userId === legacy.user.id)?.stream, "LEGACY");
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: capable.user.id } }), 0);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: legacy.user.id } }), 1);
  });

  it("keeps a stamped BUCKET window private and electable after the live flag is rolled back", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    await createPendingLegacyRace(seed, windowStart, windowEnd);
    await stampMode(seed.id, windowStart, windowEnd, "BUCKET");
    await appSettings.setFlag("seededRaceBucketsEnabled", false);
    const account = await createTestUser({ clientFeatures: ["seeded_race_buckets"] });

    const response = await request(baseUrl, "PUT", "/auth/me/featured-auto-join", {
      token: account.token, body: { enabled: true },
    });
    assert.equal(response.status, 200);
    const membership = await prisma.seededRaceWindowMembership.findUnique({
      where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: account.user.id } },
    });
    assert.equal(membership?.stream, "BUCKET");
    const featured = await request(baseUrl, "GET", "/races/featured", {
      token: account.token, headers: BUCKET_HEADERS,
    });
    assert.equal(featured.status, 200);
    assert.equal((await featured.json()).races.find((row) => row.seedKind === "DAILY_10K")?.bucketPrivate, true);
  });

  it("treats an unstamped mixed-deploy window as LEGACY even with the runtime flag enabled", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const legacyRace = await createPendingLegacyRace(seed, windowStart, windowEnd);
    const account = await createTestUser({ clientFeatures: ["seeded_race_buckets"] });

    const response = await request(baseUrl, "PUT", "/auth/me/featured-auto-join", {
      token: account.token, body: { enabled: true },
    });
    assert.equal(response.status, 200);
    const membership = await prisma.seededRaceWindowMembership.findUnique({
      where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: account.user.id } },
    });
    assert.equal(membership.stream, "LEGACY");
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: account.user.id } }), 1);
  });
});
