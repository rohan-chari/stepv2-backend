const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-race-list-${++nextAppleId}`;
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

async function createActiveRace(opts = {}) {
  const alice = await createUser(opts.aliceName || "AliceListAA");
  const bob = await createUser(opts.bobName || "BobListAAAAA");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: opts.name || "Race Card Sync",
      targetSteps: opts.targetSteps || 100000,
      maxDurationDays: 7,
      powerupsEnabled: opts.powerupsEnabled ?? true,
      powerupStepInterval: opts.interval || 2000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });

  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt },
  });

  return { alice, bob, raceId };
}

async function postSamples(token, steps) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const response = await request(server.baseUrl, "POST", "/steps/samples", {
    body: {
      samples: [
        {
          periodStart: oneHourAgo.toISOString(),
          periodEnd: now.toISOString(),
          steps,
        },
      ],
    },
    token,
  });
  assert.equal(response.status, 200);
}

describe("race list sync", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("POST /steps/samples earns queued boxes on write and exposes them in GET /races", async () => {
    const { alice, raceId } = await createActiveRace();

    await postSamples(alice.token, 9000);

    const powerups = await prisma.racePowerup.findMany({
      where: { raceId, userId: alice.userId },
      orderBy: { earnedAtSteps: "asc" },
    });
    assert.equal(powerups.length, 4);
    assert.deepEqual(
      powerups.map((powerup) => powerup.status),
      ["MYSTERY_BOX", "MYSTERY_BOX", "MYSTERY_BOX", "QUEUED"]
    );

    const racesRes = await request(server.baseUrl, "GET", "/races", {
      token: alice.token,
    });
    assert.equal(racesRes.status, 200);

    const body = await racesRes.json();
    assert.equal(body.active.length, 1);
    assert.equal(body.active[0].queuedBoxCount, 1);
  });

  it("POST /races/:raceId/powerups/:powerupId/discard promotes queued boxes on write", async () => {
    const { alice, raceId } = await createActiveRace();

    await postSamples(alice.token, 9000);

    const firstBox = await prisma.racePowerup.findFirst({
      where: {
        raceId,
        userId: alice.userId,
        status: "MYSTERY_BOX",
      },
      orderBy: { earnedAtSteps: "asc" },
    });
    assert.ok(firstBox);

    const discardRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${firstBox.id}/discard`,
      { token: alice.token }
    );
    assert.equal(discardRes.status, 200);

    const counts = await prisma.racePowerup.groupBy({
      by: ["status"],
      where: { raceId, userId: alice.userId },
      _count: true,
    });
    const countByStatus = Object.fromEntries(
      counts.map((entry) => [entry.status, entry._count])
    );
    assert.equal(countByStatus.MYSTERY_BOX, 3);
    assert.equal(countByStatus.QUEUED || 0, 0);
    assert.equal(countByStatus.DISCARDED, 1);

    const racesRes = await request(server.baseUrl, "GET", "/races", {
      token: alice.token,
    });
    assert.equal(racesRes.status, 200);

    const body = await racesRes.json();
    assert.equal(body.active[0].queuedBoxCount, 0);
  });

  it("GET /races returns current myPlacement for active races without progress reads", async () => {
    const { alice, bob } = await createActiveRace({
      powerupsEnabled: false,
      name: "Placement Race",
    });

    await postSamples(alice.token, 6000);
    await postSamples(bob.token, 3000);

    const aliceRacesRes = await request(server.baseUrl, "GET", "/races", {
      token: alice.token,
    });
    assert.equal(aliceRacesRes.status, 200);
    const aliceBody = await aliceRacesRes.json();
    assert.equal(aliceBody.active[0].myPlacement, 1);

    const bobRacesRes = await request(server.baseUrl, "GET", "/races", {
      token: bob.token,
    });
    assert.equal(bobRacesRes.status, 200);
    const bobBody = await bobRacesRes.json();
    assert.equal(bobBody.active[0].myPlacement, 2);
  });
});
