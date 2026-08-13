const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
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

const FEATURES = { "X-Client-Features": "seeded_race_buckets" };

describe("private seeded race buckets (integration)", () => {
  let baseUrl;
  before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
  });

  it("keeps GET virtual, elects only through explicit UPCOMING POST, and persists ELECTED", async () => {
    const { user, token } = await createTestUser();
    const before = await request(baseUrl, "GET", "/races/featured", { token, headers: FEATURES });
    assert.equal(before.status, 200);
    const card = (await before.json()).races.find((row) => row.seedKind === "DAILY_10K");
    assert.equal(card.raceId, null);
    assert.equal(card.bucketPrivate, true);
    assert.equal(card.myStatus, null);
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

  it("finalizes the next ET window before its boundary and creates no online bucket at or after it", async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const [alice, bob] = await Promise.all([createTestUser(), createTestUser()]);
    // 23:58 ET: renewal's five-minute pre-boundary pass targets the following
    // day, so the deterministic plan exists before the card becomes live.
    const beforeBoundary = new Date("2026-08-12T03:58:00.000Z");
    const { windowStart, windowEnd } = upcomingWindowFor(seed, beforeBoundary);
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
    assert.equal(persisted.race.maxParticipants, 15);
    assert.equal(persisted.assignments.length, 2);

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
