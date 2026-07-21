const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");

// End-to-end coverage for the auto-join-featured-races preference:
//   * PUT /auth/me/featured-auto-join persists the flag and (on enable)
//     immediately opts the user into any existing PENDING seeded "next" races,
//     so the toggle takes effect starting with the next daily/weekly challenge.
//   * The seeded-race renewal cron enrolls every opted-in user into each newly
//     created seeded race (both the upcoming PENDING and a cold-start ACTIVE).
//   * Everything is idempotent and capacity-respecting.

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

async function getDailySeed() {
  // race_seeds survive cleanDatabase (not truncated); seeded by migrations.
  const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
  assert.ok(seed, "DAILY_10K seed should exist from migrations");
  return seed;
}

describe("featured races auto-join", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects a non-boolean enabled", async () => {
    const { token } = await createTestUser();
    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/featured-auto-join",
      { token, body: { enabled: "yes" } }
    );
    assert.equal(res.status, 400);
  });

  it("persists the flag, echoes it on /auth/me, and opts into the existing PENDING race on enable", async () => {
    const seed = await getDailySeed();
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

    const { user, token } = await createTestUser();

    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/featured-auto-join",
      { token, body: { enabled: true } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.autoJoinFeaturedRaces, true);

    // Echoed by /auth/me for app-restart hydration.
    const meRes = await request(server.baseUrl, "GET", "/auth/me", { token });
    const meBody = await meRes.json();
    assert.equal(meBody.user.autoJoinFeaturedRaces, true);

    // Enable opts the user into the PENDING "next" race only — the mid-flight
    // ACTIVE race is untouched (auto-join starts with the next challenge).
    const pendingParticipant = await prisma.raceParticipant.findFirst({
      where: { raceId: upcoming.id, userId: user.id },
    });
    assert.ok(pendingParticipant, "should be opted into the PENDING race");
    assert.equal(pendingParticipant.status, "ACCEPTED");
    const activeParticipant = await prisma.raceParticipant.findFirst({
      where: { raceId: active.id, userId: user.id },
    });
    assert.equal(activeParticipant, null);

    // The featured card reflects the opt-in for the new-client UI.
    const featRes = await request(server.baseUrl, "GET", "/races/featured", {
      token,
    });
    const featBody = await featRes.json();
    const featured = featBody.races || featBody;
    const dailyCard = featured.find((c) => c.raceId === active.id);
    assert.ok(dailyCard?.upcoming, "featured card should carry upcoming");
    assert.equal(dailyCard.upcoming.myStatus, "ACCEPTED");

    // Enabling twice is idempotent (no duplicate participant, still 200).
    const res2 = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/featured-auto-join",
      { token, body: { enabled: true } }
    );
    assert.equal(res2.status, 200);
    const count = await prisma.raceParticipant.count({
      where: { raceId: upcoming.id, userId: user.id },
    });
    assert.equal(count, 1);

    // Disable flips the flag but does not remove the existing opt-in.
    const offRes = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/featured-auto-join",
      { token, body: { enabled: false } }
    );
    const offBody = await offRes.json();
    assert.equal(offBody.user.autoJoinFeaturedRaces, false);
    const stillThere = await prisma.raceParticipant.findFirst({
      where: { raceId: upcoming.id, userId: user.id },
    });
    assert.ok(stillThere, "disable must not kick the user out of the race");
  });

  it("does not opt into a PENDING race that is already full", async () => {
    const seed = await getDailySeed();
    const now = Date.now();
    const upcoming = await createSeededRace(seed.id, {
      status: "PENDING",
      startedAt: null,
      scheduledStartAt: new Date(now + 23 * 60 * 60 * 1000),
      endsAt: new Date(now + 47 * 60 * 60 * 1000),
      maxParticipants: 1,
    });
    const { user: occupant } = await createTestUser();
    await prisma.raceParticipant.create({
      data: { raceId: upcoming.id, userId: occupant.id, status: "ACCEPTED" },
    });

    const { user, token } = await createTestUser();
    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/featured-auto-join",
      { token, body: { enabled: true } }
    );
    // The toggle itself still succeeds — the opt-in is best-effort.
    assert.equal(res.status, 200);
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId: upcoming.id, userId: user.id },
    });
    assert.equal(participant, null);
  });

  it("cron enrolls opted-in users (and only them) into newly created seeded races, idempotently", async () => {
    const { user: optedIn } = await createTestUser({
      autoJoinFeaturedRaces: true,
    });
    const { user: optedOut } = await createTestUser();

    // Cold start: no seeded races exist. The cron creates, per active seed, an
    // ACTIVE race covering now plus the upcoming PENDING race — the opted-in
    // user must be enrolled in all of them.
    const renew = buildRenewSeededRaces({ prisma, logger: { log() {}, error() {} } });
    const results = await renew();
    const createdIds = results.map((r) => r.race.id);
    assert.ok(createdIds.length >= 2, "cold start should create seeded races");

    for (const raceId of createdIds) {
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: optedIn.id },
      });
      assert.ok(p, `opted-in user should be enrolled in ${raceId}`);
      assert.equal(p.status, "ACCEPTED");
      const other = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: optedOut.id },
      });
      assert.equal(other, null, "non-opted user must not be enrolled");
    }

    // Second tick is a steady-state no-op: no new races, no duplicate rows.
    const secondResults = await renew();
    assert.equal(secondResults.length, 0);
    const rows = await prisma.raceParticipant.count({
      where: { userId: optedIn.id },
    });
    assert.equal(rows, createdIds.length);
  });

  it("cron respects race capacity when enrolling", async () => {
    // Shrink the daily seed's capacity to 1 for this test; two opted-in users
    // compete for the slot. Restore afterwards (race_seeds survive clean).
    const seed = await getDailySeed();
    const originalMax = seed.maxParticipants;
    await prisma.raceSeed.update({
      where: { id: seed.id },
      data: { maxParticipants: 1 },
    });
    try {
      await createTestUser({ autoJoinFeaturedRaces: true });
      await createTestUser({ autoJoinFeaturedRaces: true });

      const renew = buildRenewSeededRaces({
        prisma,
        logger: { log() {}, error() {} },
      });
      const results = await renew();
      const dailyRaces = results.filter((r) => r.seedKind === "DAILY_10K");
      assert.ok(dailyRaces.length >= 1);
      for (const r of dailyRaces) {
        const count = await prisma.raceParticipant.count({
          where: { raceId: r.race.id, status: "ACCEPTED" },
        });
        assert.equal(count, 1, "enrollment must not exceed maxParticipants");
      }
    } finally {
      await prisma.raceSeed.update({
        where: { id: seed.id },
        data: { maxParticipants: originalMax },
      });
    }
  });
});
