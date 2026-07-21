const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  prisma,
  cleanDatabase,
  startServer,
  createTestUser,
  request,
} = require("./setup");

describe("activation onboarding v2", () => {
  let server;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createActiveDailyFor(userId) {
    const seed = await prisma.raceSeed.upsert({
      where: { kind: "DAILY_10K" },
      update: { active: true },
      create: {
        id: `daily-seed-${Date.now()}`,
        kind: "DAILY_10K",
        name: "Daily 10K",
        targetSteps: 10000,
        durationHours: 24,
        cadence: "DAILY",
      },
    });
    const race = await prisma.race.create({
      data: {
        seedId: seed.id,
        name: "Today's Daily",
        targetSteps: 10000,
        maxDurationDays: 1,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
        timeBased: true,
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId, status: "ACCEPTED" },
    });
    return race;
  }

  it("grants one shared tutorial/Daily reward to an accepted active Daily racer", async () => {
    const { user, token } = await createTestUser();
    const race = await createActiveDailyFor(user.id);

    const eligibility = await request(
      server.baseUrl,
      "GET",
      "/onboarding/starter-reward",
      { token }
    );
    assert.deepEqual(await eligibility.json(), {
      eligible: true,
      claimed: false,
      amount: 100,
      raceId: race.id,
    });

    const claim = await request(
      server.baseUrl,
      "POST",
      "/onboarding/starter-reward/claim",
      { token }
    );
    assert.deepEqual(await claim.json(), { granted: true, coins: 100 });

    const legacyRetry = await request(
      server.baseUrl,
      "POST",
      "/tutorial/complete-reward",
      { token }
    );
    assert.deepEqual(await legacyRetry.json(), { granted: false, coins: 100 });
    assert.equal(
      await prisma.coinTransaction.count({
        where: {
          userId: user.id,
          reason: "tutorial_complete",
          refId: user.id,
        },
      }),
      1
    );
  });

  it("rejects a claim without accepted active Daily membership", async () => {
    const { token } = await createTestUser();
    const response = await request(
      server.baseUrl,
      "POST",
      "/onboarding/starter-reward/claim",
      { token }
    );
    assert.equal(response.status, 403);
  });

  it("deduplicates bounded analytics and cascades them on account deletion", async () => {
    const { user, token } = await createTestUser();
    const event = {
      id: `event-${Date.now()}`,
      onboardingSessionId: "session-integration",
      name: "daily_opened",
      context: { source: "onboarding", race_state: "active" },
      appVersion: "2.0.0+1",
      platform: "ios",
      timestamp: new Date().toISOString(),
    };
    for (const inserted of [1, 0]) {
      const response = await request(
        server.baseUrl,
        "POST",
        "/analytics/activation-events",
        { token, body: { events: [event] } }
      );
      assert.equal(response.status, 202);
      assert.equal((await response.json()).inserted, inserted);
    }
    const row = await prisma.activationEvent.findUnique({ where: { id: event.id } });
    assert.equal(row.userId, user.id);

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", { token });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.activationEvent.count({ where: { userId: user.id } }), 0);
  });
});
