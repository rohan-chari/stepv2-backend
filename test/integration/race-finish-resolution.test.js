const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-race-finish-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createRace(token, overrides = {}) {
  return request(server.baseUrl, "POST", "/races", {
    body: {
      name: overrides.name || "Finish Resolution Race",
      targetSteps: overrides.targetSteps || 10000,
      maxDurationDays: overrides.maxDurationDays || 7,
      powerupsEnabled: overrides.powerupsEnabled || false,
      ...overrides,
    },
    token,
  });
}

async function createActiveRaceWith(alice, bob, carol, overrides = {}) {
  await makeFriends(alice, bob);
  await makeFriends(alice, carol);

  const raceId = (await (await createRace(alice.token, overrides)).json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: carol.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });

  const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt },
  });

  return raceId;
}

describe("race finish resolution", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("POST /steps/samples resolves and completes a 3-person race on the first finish", async () => {
    const alice = await createUser("AliceFinishA");
    const bob = await createUser("BobFinishAAAA");
    const carol = await createUser("CarolFinishAA");
    const raceId = await createActiveRaceWith(alice, bob, carol);

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const syncRes = await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: oneHourAgo.toISOString(),
            periodEnd: now.toISOString(),
            steps: 12000,
          },
        ],
      },
      token: alice.token,
    });
    assert.equal(syncRes.status, 200);

    const aliceParticipant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.ok(aliceParticipant.finishedAt, "finishedAt should be set on write");
    assert.equal(aliceParticipant.finishTotalSteps, 10000);
    assert.equal(aliceParticipant.totalSteps, 10000);
    assert.equal(aliceParticipant.placement, 1);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerUserId, alice.userId);

    const progressRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: bob.token }
    );
    assert.equal(progressRes.status, 200);
    const progress = (await progressRes.json()).progress;
    const aliceEntry = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceEntry.totalSteps, 10000);
    assert.ok(aliceEntry.finishedAt);
  });

  it("finished participant stays frozen after later syncs and progress reads", async () => {
    const alice = await createUser("AliceFinishB");
    const bob = await createUser("BobFinishBBBB");
    const carol = await createUser("CarolFinishBB");
    const raceId = await createActiveRaceWith(alice, bob, carol);

    const now = new Date();
    const firstStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const firstMid = new Date(now.getTime() - 90 * 60 * 1000);
    const secondEnd = new Date(now.getTime() - 30 * 60 * 1000);

    await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: firstStart.toISOString(),
            periodEnd: firstMid.toISOString(),
            steps: 12000,
          },
        ],
      },
      token: alice.token,
    });

    const firstSnapshot = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(firstSnapshot.finishTotalSteps, 10000);
    assert.equal(firstSnapshot.totalSteps, 10000);
    assert.ok(firstSnapshot.finishedAt);

    await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: firstMid.toISOString(),
            periodEnd: secondEnd.toISOString(),
            steps: 4000,
          },
        ],
      },
      token: alice.token,
    });

    const secondSnapshot = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(secondSnapshot.finishTotalSteps, 10000);
    assert.equal(secondSnapshot.totalSteps, 10000);
    assert.equal(
      secondSnapshot.finishedAt.toISOString(),
      firstSnapshot.finishedAt.toISOString()
    );

    const progressRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: bob.token }
    );
    assert.equal(progressRes.status, 200);
    const progress = (await progressRes.json()).progress;
    const aliceEntry = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceEntry.totalSteps, 10000);
  });
});
