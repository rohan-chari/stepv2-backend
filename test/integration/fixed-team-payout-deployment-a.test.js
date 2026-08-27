const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const TEAM_HEADERS = { "X-Client-Features": "team_races" };
let server;
let sequence = 0;

async function makeUser() {
  sequence += 1;
  const { user, token } = await createTestUser({
    appleId: `deployment-a-team-payout-${sequence}`,
    displayName: `Deployment A ${sequence}`,
  });
  return { user, token };
}

async function pendingTeamRace({ creatorId, version, reward, durationDays = 14 }) {
  return prisma.race.create({
    data: {
      creatorId,
      name: "Deployment A mixed-worker race",
      targetSteps: 0,
      status: "PENDING",
      isPublic: true,
      timeBased: true,
      maxParticipants: 2,
      maxDurationDays: durationDays,
      payoutPreset: "WINNER_TAKES_ALL",
      fundedPrize: true,
      prizeCalculationVersion: 2,
      prizeCoinUnit: 10,
      prizePoolMaxCoins: 8000,
      payoutRoundingVersion: 1,
      isTeamRace: true,
      teamSize: 1,
      teamAName: "Reds",
      teamBName: "Blues",
      teamPoolMultBps: 18750,
      teamPayoutVersion: version,
      teamWinnerRewardCoins: reward,
    },
  });
}

async function addTeams(raceId, creatorId, opponentId) {
  await prisma.raceParticipant.createMany({
    data: [
      { raceId, userId: creatorId, status: "ACCEPTED", team: "TEAM_A" },
      { raceId, userId: opponentId, status: "ACCEPTED", team: "TEAM_B" },
    ],
  });
}

describe("fixed team payout Deployment A compatibility", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    sequence = 0;
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("teamRacesEnabled", true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  after(async () => {
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("teamRacesEnabled", true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  it("atomically reprices an already-valid V1 row on PATCH and custom start", async () => {
    const creator = await makeUser();
    const opponent = await makeUser();
    const race = await pendingTeamRace({
      creatorId: creator.user.id,
      version: 1,
      reward: 1000,
    });
    await addTeams(race.id, creator.user.id, opponent.user.id);

    const edit = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: { maxDurationDays: 7 },
    });
    assert.equal(edit.status, 200);
    let stored = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(stored.maxDurationDays, 7);
    assert.equal(stored.teamPayoutVersion, 1);
    assert.equal(stored.teamWinnerRewardCoins, 500);

    await prisma.race.update({
      where: { id: race.id },
      data: { scheduledEndAt: new Date(Date.now() + 25 * 60 * 60 * 1000) },
    });
    const start = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/start`,
      { token: creator.token, headers: TEAM_HEADERS },
    );
    assert.equal(start.status, 200, await start.text());
    stored = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(stored.maxDurationDays, 1);
    assert.equal(stored.teamPayoutVersion, 1);
    assert.equal(stored.teamWinnerRewardCoins, 100);
  });

  it("keeps legacy null and partial rows unstamped during Deployment A", async () => {
    const creator = await makeUser();
    for (const [version, reward] of [[null, null], [1, null]]) {
      const race = await pendingTeamRace({
        creatorId: creator.user.id,
        version,
        reward,
      });
      const edit = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
        token: creator.token,
        headers: TEAM_HEADERS,
        body: { maxDurationDays: 7 },
      });
      assert.equal(edit.status, 200);
      const stored = await prisma.race.findUnique({ where: { id: race.id } });
      assert.equal(stored.teamPayoutVersion, version);
      assert.equal(stored.teamWinnerRewardCoins, reward);
      const payload = (await edit.json()).race;
      assert.equal(payload.teamPayoutVersion, null);
      assert.equal(payload.teamWinnerRewardCoins, null);
    }
  });
});
