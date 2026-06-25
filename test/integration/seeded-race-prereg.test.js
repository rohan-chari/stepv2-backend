const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

// End-to-end compat guard for pre-registration: a PENDING seeded "next" race must
// NEVER leak into /races/public (old clients would mis-render a not-yet-started
// race), but MUST be reachable via /races/featured -> card.upcoming for new
// clients. Exercises the real findPublicPending / getFeaturedRaces Prisma paths.

let server;

async function createSeededRace(seedId, overrides) {
  return prisma.race.create({
    data: {
      seedId,
      creatorId: null,
      name: "Daily 10K",
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: 1,
      ...overrides,
    },
    select: { id: true },
  });
}

describe("seeded race pre-registration compat", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("hides the PENDING next race from /races/public but exposes it via featured.upcoming", async () => {
    // race_seeds survive cleanDatabase (not truncated); seeded by migrations.
    const seed = await prisma.raceSeed.findUnique({
      where: { kind: "DAILY_10K" },
    });
    assert.ok(seed, "DAILY_10K seed should exist from migrations");

    const now = Date.now();
    const active = await createSeededRace(seed.id, {
      status: "ACTIVE",
      startedAt: new Date(now - 60 * 60 * 1000),
      endsAt: new Date(now + 23 * 60 * 60 * 1000),
    });
    const upcoming = await createSeededRace(seed.id, {
      status: "PENDING",
      startedAt: null,
      scheduledStartAt: new Date(now + 23 * 60 * 60 * 1000),
      endsAt: new Date(now + 47 * 60 * 60 * 1000),
    });

    const { token } = await createTestUser();

    // /races/public must include the ACTIVE seeded race but NOT the PENDING one.
    const publicRes = await request(server.baseUrl, "GET", "/races/public", {
      token,
    });
    assert.equal(publicRes.status, 200);
    const publicBody = await publicRes.json();
    const publicRaces = publicBody.races || publicBody;
    const publicIds = publicRaces.map((r) => r.id);
    assert.ok(
      publicIds.includes(active.id),
      "ACTIVE seeded race should be browsable"
    );
    assert.ok(
      !publicIds.includes(upcoming.id),
      "PENDING seeded race must NOT leak into /races/public"
    );

    // /races/featured must pin the ACTIVE card and carry the PENDING race in
    // `upcoming`, never as its own array entry.
    const featRes = await request(server.baseUrl, "GET", "/races/featured", {
      token,
    });
    assert.equal(featRes.status, 200);
    const featBody = await featRes.json();
    const featured = featBody.races || featBody;
    const featuredIds = featured.map((c) => c.raceId);
    assert.ok(
      featuredIds.includes(active.id),
      "ACTIVE seeded race should be the featured card"
    );
    assert.ok(
      !featuredIds.includes(upcoming.id),
      "PENDING seeded race must NOT be its own featured card"
    );

    const dailyCard = featured.find((c) => c.raceId === active.id);
    assert.ok(dailyCard.upcoming, "featured card should carry upcoming");
    assert.equal(dailyCard.upcoming.raceId, upcoming.id);
    assert.equal(dailyCard.upcoming.myStatus, null); // not opted in -> "Opt in"
  });
});
