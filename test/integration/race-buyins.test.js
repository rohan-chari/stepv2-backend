const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { resolveExpiredRaces } = require("../../src/jobs/raceExpiry");

let server;
let nextAppleId = 0;

async function createUser(displayName, coins = 0) {
  const appleId = `apple-race-buyin-${++nextAppleId}`;
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

  if (coins > 0) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { coins },
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
      name: "Paid Race",
      targetSteps: 100000,
      maxDurationDays: 7,
      ...overrides,
    },
    token,
  });
}

async function fetchMe(token) {
  const res = await request(server.baseUrl, "GET", "/auth/me", { token });
  return res.json();
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

describe("race buy-ins", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("creating a paid race reserves the creator buy-in and reports held coins", async () => {
    const alice = await createUser("AlicePaid", 500);

    const res = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    const me = await fetchMe(alice.token);
    assert.equal(me.user.coins, 400);
    assert.equal(me.user.heldCoins, 100);

    const participant = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: {
          raceId: body.race.id,
          userId: alice.userId,
        },
      },
    });
    assert.equal(participant.buyInAmount, 100);
    assert.equal(participant.buyInStatus, "HELD");
  });

  it("accepting a paid invite holds coins and starting the race commits the pot", async () => {
    const alice = await createUser("AliceStart", 500);
    const bob = await createUser("BobbyStart", 500);
    await makeFriends(alice, bob);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
    });
    const raceId = (await createRes.json()).race.id;

    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId] },
      token: alice.token,
    });

    const acceptRes = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
    });
    assert.equal(acceptRes.status, 200);

    const bobBeforeStart = await fetchMe(bob.token);
    assert.equal(bobBeforeStart.user.coins, 400);
    assert.equal(bobBeforeStart.user.heldCoins, 100);

    const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
    });
    assert.equal(startRes.status, 200);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.potCoins, 200);

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    assert.deepEqual(
      participants.map((participant) => participant.buyInStatus),
      ["COMMITTED", "COMMITTED"]
    );

    const aliceMe = await fetchMe(alice.token);
    const bobMe = await fetchMe(bob.token);
    assert.equal(aliceMe.user.heldCoins, 0);
    assert.equal(bobMe.user.heldCoins, 0);
  });

  it("blocks top-3 payout presets from starting with only three accepted runners", async () => {
    const alice = await createUser("AliceTop3", 500);
    const bob = await createUser("BobbyTop3", 500);
    const charlie = await createUser("CharlieTop", 500);
    await makeFriends(alice, bob);
    await makeFriends(alice, charlie);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "TOP3_70_20_10",
    });
    const raceId = (await createRes.json()).race.id;

    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId, charlie.userId] },
      token: alice.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: charlie.token,
    });

    const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
    });
    assert.equal(startRes.status, 400);
    assert.match((await startRes.json()).error, /only supports races with at least 4 accepted participants/i);
  });

  it("late joiners in paid active races go straight into the live pot", async () => {
    const alice = await createUser("AliceLateBuy", 500);
    const bob = await createUser("BobbyLateBuy", 500);
    const charlie = await createUser("CharlieLate", 500);
    await makeFriends(alice, bob);
    await makeFriends(alice, charlie);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
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

    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [charlie.userId] },
      token: alice.token,
    });
    const acceptRes = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: charlie.token,
    });
    assert.equal(acceptRes.status, 200);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.potCoins, 300);

    const charlieMe = await fetchMe(charlie.token);
    assert.equal(charlieMe.user.coins, 400);
    assert.equal(charlieMe.user.heldCoins, 0);

    const charlieParticipant = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: {
          raceId,
          userId: charlie.userId,
        },
      },
    });
    assert.equal(charlieParticipant.buyInStatus, "COMMITTED");
  });

  it("refunds all charged runners when a paid race is cancelled", async () => {
    const alice = await createUser("AliceRefund", 500);
    const bob = await createUser("BobbyRefund", 500);
    await makeFriends(alice, bob);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
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

    const cancelRes = await request(server.baseUrl, "DELETE", `/races/${raceId}`, {
      token: alice.token,
    });
    assert.equal(cancelRes.status, 200);

    const aliceMe = await fetchMe(alice.token);
    const bobMe = await fetchMe(bob.token);
    assert.equal(aliceMe.user.coins, 500);
    assert.equal(bobMe.user.coins, 500);
    assert.equal(aliceMe.user.heldCoins, 0);
    assert.equal(bobMe.user.heldCoins, 0);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.potCoins, 0);
  });

  it("pays the winner the full pot in a two-person paid race", async () => {
    const alice = await createUser("AliceWinner", 500);
    const bob = await createUser("BobbyLoser", 500);
    await makeFriends(alice, bob);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
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

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: twoHoursAgo },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: twoHoursAgo },
    });

    await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            periodEnd: new Date().toISOString(),
            steps: 120000,
          },
        ],
      },
      token: alice.token,
    });

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerUserId, alice.userId);

    const aliceMe = await fetchMe(alice.token);
    const bobMe = await fetchMe(bob.token);
    assert.equal(aliceMe.user.coins, 600);
    assert.equal(bobMe.user.coins, 400);

    const winnerParticipant = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: {
          raceId,
          userId: alice.userId,
        },
      },
    });
    assert.equal(winnerParticipant.payoutCoins, 200);
  });

  it("settles expired paid races from final standings and pays the configured top-3 split", async () => {
    const alice = await createUser("AliceExpiry", 500);
    const bob = await createUser("BobbyExpiry", 500);
    const charlie = await createUser("CharlieExpr", 500);
    const dana = await createUser("DanaExpiry", 500);
    await makeFriends(alice, bob);
    await makeFriends(alice, charlie);
    await makeFriends(alice, dana);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "TOP3_70_20_10",
    });
    const raceId = (await createRes.json()).race.id;

    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId, charlie.userId, dana.userId] },
      token: alice.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: charlie.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: dana.token,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
    });

    const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const endsAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt, endsAt },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: startedAt },
    });

    await recordSamples(alice.token, [
      {
        periodStart: new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        steps: 80000,
      },
    ]);
    await recordSamples(bob.token, [
      {
        periodStart: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
        steps: 70000,
      },
    ]);
    await recordSamples(charlie.token, [
      {
        periodStart: new Date(Date.now() - 2.75 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 2.25 * 60 * 60 * 1000).toISOString(),
        steps: 60000,
      },
    ]);
    await recordSamples(dana.token, [
      {
        periodStart: new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 2.1 * 60 * 60 * 1000).toISOString(),
        steps: 50000,
      },
    ]);

    await resolveExpiredRaces();

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerUserId, alice.userId);

    const placements = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
    });
    assert.deepEqual(
      placements.map((participant) => ({ userId: participant.userId, placement: participant.placement })),
      [
        { userId: alice.userId, placement: 1 },
        { userId: bob.userId, placement: 2 },
        { userId: charlie.userId, placement: 3 },
        { userId: dana.userId, placement: 4 },
      ]
    );

    const aliceMe = await fetchMe(alice.token);
    const bobMe = await fetchMe(bob.token);
    const charlieMe = await fetchMe(charlie.token);
    const danaMe = await fetchMe(dana.token);
    assert.equal(aliceMe.user.coins, 680);
    assert.equal(bobMe.user.coins, 480);
    assert.equal(charlieMe.user.coins, 440);
    assert.equal(danaMe.user.coins, 400);
  });

  it("breaks expiry ties by who reached the tied total first", async () => {
    const alice = await createUser("AliceTieExp", 500);
    const bob = await createUser("BobbyTieExp", 500);
    await makeFriends(alice, bob);

    const createRes = await createRace(alice.token, {
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
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

    const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const endsAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt, endsAt },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: startedAt },
    });

    await recordSamples(alice.token, [
      {
        periodStart: new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        steps: 70000,
      },
    ]);
    await recordSamples(bob.token, [
      {
        periodStart: new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        steps: 70000,
      },
    ]);

    await resolveExpiredRaces();

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.winnerUserId, alice.userId);

    const placements = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
    });
    assert.equal(placements[0].userId, alice.userId);
    assert.equal(placements[1].userId, bob.userId);
  });
});
