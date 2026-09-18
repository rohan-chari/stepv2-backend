const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

const servers = [];

function settingsFor(parallel) {
  return {
    async getFlag(key) {
      if (key === "apiHomeShellV1Enabled") return true;
      if (key === "homeRaceCardParallelOptionalV1Enabled") return parallel;
      if (key === "homeRaceCardLeanLiveV1Enabled") return true;
      return false;
    },
  };
}

async function createPrivateActiveRace(users) {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: "Modern Home bypass race",
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt,
      endsAt: new Date(Date.now() + 60 * 60 * 1000),
      powerupsEnabled: false,
      isPublic: false,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map(({ user }, index) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      joinedAt: startedAt,
      totalSteps: index * 100,
    })),
  });
  await prisma.stepSample.createMany({
    data: users.map(({ user }, index) => ({
      userId: user.id,
      periodStart: startedAt,
      periodEnd: new Date(startedAt.getTime() + 30 * 60 * 1000),
      steps: 1000 + index,
    })),
  });
  return race;
}

describe("modern Home omits removed joined-race standings", () => {
  before(async () => {
    servers.push(
      { mode: "nonparallel", server: await startServer({ appSettings: settingsFor(false) }) },
      { mode: "parallel", server: await startServer({ appSettings: settingsFor(true) }) },
    );
  });
  after(async () => {
    await Promise.all(servers.map(({ server }) => server.close()));
  });
  beforeEach(async () => { await cleanDatabase(); });

  it("skips ACTIVE_RACES for 2.3.0+ while preserving the Home batch", async () => {
    const viewer = await createTestUser({ displayName: "Modern Viewer" });
    const rival = await createTestUser({ displayName: "Modern Rival" });
    await createPrivateActiveRace([viewer, rival]);

    for (const { mode, server } of servers) {
      for (const appVersion of ["2.3.0", "2.3.11"]) {
        const label = `${mode}:${appVersion}`;
        const response = await request(
          server.baseUrl,
          "GET",
          "/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=2026-09-04",
          {
            token: viewer.token,
            headers: { "X-App-Version": appVersion },
          },
        );

        assert.equal(response.status, 200, label);
        const body = await response.json();
        assert.equal(body.contract, "home-shell-v1", label);
        assert.deepEqual(body.resolved, {
          presentation: true,
          friends: true,
        }, label);
        assert.equal(body.state, "EMPTY", label);
        assert.deepEqual(body.data, {}, label);
        assert.deepEqual(body.dailyReward, {
          claimedToday: false,
          localDate: "2026-09-04",
        }, label);
      }
    }
  });

  it("retains the frozen-client ACTIVE_RACES contract below 2.3.0", async () => {
    const viewer = await createTestUser({ displayName: "Legacy Viewer" });
    const rival = await createTestUser({ displayName: "Legacy Rival" });
    const race = await createPrivateActiveRace([viewer, rival]);

    for (const { mode, server } of servers) {
      const response = await request(
        server.baseUrl,
        "GET",
        "/home/race-card?homeActiveRaces=1",
        {
          token: viewer.token,
          headers: { "X-App-Version": "2.2.4" },
        },
      );

      assert.equal(response.status, 200, mode);
      const body = await response.json();
      assert.equal(body.state, "ACTIVE_RACES", mode);
      assert.equal(body.data.races[0].raceId, race.id, mode);

      const unknownVersion = await request(
        server.baseUrl,
        "GET",
        "/home/race-card?homeActiveRaces=1",
        { token: viewer.token },
      );
      assert.equal(unknownVersion.status, 200, mode);
      assert.equal((await unknownVersion.json()).state, "ACTIVE_RACES", mode);
    }
  });
});
