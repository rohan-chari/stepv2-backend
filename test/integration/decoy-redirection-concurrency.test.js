const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const POWERUPS5 = {
  "X-Client-Features": "characters,powerups5",
};
const TEAM_POWERUPS5 = {
  "X-Client-Features": "characters,team_races,powerups5",
};

async function createUser(displayName, headers = POWERUPS5) {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-decoy-${++nextAppleId}` },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
    headers,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b, headers = POWERUPS5) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers,
  });
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function createSoloRace(users) {
  const [creator, ...opponents] = users;
  for (const opponent of opponents) await makeFriends(creator, opponent);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Decoy Solo",
      isPublic: true,
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: POWERUPS5,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((user) => user.userId) },
    token: creator.token,
    headers: POWERUPS5,
  });
  for (const opponent of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: opponent.token,
      headers: POWERUPS5,
    });
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: POWERUPS5,
  });
  assert.equal(startRes.status, 200);
  return raceId;
}

async function createTeamRace(users) {
  const [creator, ...opponents] = users;
  for (const opponent of opponents) await makeFriends(creator, opponent, TEAM_POWERUPS5);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Decoy Teams",
      maxDurationDays: 7,
      isPublic: true,
      isTeamRace: true,
      teamSize: 2,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((user) => user.userId) },
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  const teams = ["TEAM_A", "TEAM_B", "TEAM_B"];
  for (const [index, opponent] of opponents.entries()) {
    const response = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team: teams[index] },
      token: opponent.token,
      headers: TEAM_POWERUPS5,
    });
    assert.equal(response.status, 200);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  assert.equal(startRes.status, 200);
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveActiveEffect(raceId, userId, type, powerupId, expiresAt) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId: userId,
      sourceUserId: userId,
      powerupId,
      type,
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt,
    },
  });
}

async function usePowerup(user, raceId, powerupId, body = {}, headers = POWERUPS5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token: user.token,
    headers,
  });
}

async function activeEffects(raceId, type) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, type, status: "ACTIVE" },
    orderBy: [{ targetUserId: "asc" }, { id: "asc" }],
  });
}

describe("Decoy redirection and concurrency — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a second active Decoy with DECOY_ACTIVE and retains the held item", async () => {
    const alice = await createUser("DecoyOwner");
    const bob = await createUser("DecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const first = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    const second = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    assert.equal((await usePowerup(alice, raceId, first.id)).status, 200);
    const rejected = await usePowerup(alice, raceId, second.id);
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "You already have an active Decoy in this race",
      code: "DECOY_ACTIVE",
    });

    const held = await prisma.racePowerup.findUnique({ where: { id: second.id } });
    assert.equal(held.status, "HELD");
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
      })),
      1,
    );
  });

  it("treats an expired ACTIVE Decoy as inactive and permits re-arming", async () => {
    const alice = await createUser("ExpiredDecoyOwner");
    const bob = await createUser("ExpiredDecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const expiredPowerup = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    await giveActiveEffect(
      raceId,
      alice.userId,
      "DECOY",
      expiredPowerup.id,
      new Date(Date.now() - 1000),
    );
    const fresh = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    const response = await usePowerup(alice, raceId, fresh.id);
    assert.equal(response.status, 200);
    const live = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
    });
    assert.equal(live.length, 2, "historical expired row is preserved and fresh row is active");
    assert.equal(live.filter((row) => row.expiresAt > new Date()).length, 1);
  });

  it("serializes concurrent Decoy activation so exactly one row is active", async () => {
    const alice = await createUser("ConcurrentDecoyOwner");
    const bob = await createUser("ConcurrentDecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const first = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    const second = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    const responses = await Promise.all([
      usePowerup(alice, raceId, first.id),
      usePowerup(alice, raceId, second.id),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const active = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
    });
    assert.equal(active.length, 1);
    const held = await prisma.racePowerup.count({
      where: { raceId, userId: alice.userId, type: "DECOY", status: "HELD" },
    });
    assert.equal(held, 1);
  });

  it("redirects Rainstorm per victim in a 3-runner solo race and applies once", async () => {
    const alice = await createUser("RainSoloCaster");
    const bob = await createUser("RainSoloDecoy");
    const carol = await createUser("RainSoloDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 2000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.redirected, true);
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.redirectedToUserId, carol.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    const effects = await activeEffects(raceId, "RAINSTORM");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [carol.userId]);
    assert.equal(effects.filter((effect) => effect.targetUserId === bob.userId).length, 0);
  });

  it("redirects Power Outage per victim in a 3-runner solo race", async () => {
    const alice = await createUser("OutageSoloCaster");
    const bob = await createUser("OutageSoloDecoy");
    const carol = await createUser("OutageSoloDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 2000);

    const response = await usePowerup(alice, raceId, outage.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.redirectedToUserId, carol.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    const effects = await activeEffects(raceId, "POWER_OUTAGE");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [carol.userId]);
  });

  it("consumes a Decoy as a block for Rainstorm and Power Outage when head-to-head has no destination", async () => {
    const alice = await createUser("TwoWayCaster");
    const bob = await createUser("TwoWayDecoy");
    const raceId = await createSoloRace([alice, bob]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 2000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.affected, 0);
    assert.equal(body.result.decoyBlockedCount, 1);
    assert.equal(body.result.redirected, undefined);
    assert.equal((await activeEffects(raceId, "RAINSTORM")).length, 0);
    const decoy = await prisma.raceActiveEffect.findFirst({
      where: { raceId, targetUserId: bob.userId, type: "DECOY" },
    });
    assert.equal(decoy.status, "EXPIRED");

    const secondDecoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 3000);
    await giveActiveEffect(
      raceId,
      bob.userId,
      "DECOY",
      secondDecoyPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 4000);
    const outageResponse = await usePowerup(alice, raceId, outage.id);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.equal(outageBody.result.affected, 0);
    assert.equal(outageBody.result.decoyBlockedCount, 1);
    assert.equal((await activeEffects(raceId, "POWER_OUTAGE")).length, 0);
  });

  it("uses existing team eligibility, supports duplicate destinations, and does not chain Decoys", async () => {
    const alice = await createUser("TeamCaster", TEAM_POWERUPS5);
    const erin = await createUser("TeamTeammate", TEAM_POWERUPS5);
    const bob = await createUser("TeamDecoyOne", TEAM_POWERUPS5);
    const carol = await createUser("TeamDecoyTwo", TEAM_POWERUPS5);
    const raceId = await createTeamRace([alice, erin, bob, carol]);
    const bobDecoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const carolDecoy = await giveHeldPowerup(raceId, carol.userId, "DECOY", 2000);
    const teammateDecoy = await giveHeldPowerup(raceId, erin.userId, "DECOY", 2500);
    await giveActiveEffect(raceId, bob.userId, "DECOY", bobDecoy.id, new Date(Date.now() + 86400000));
    await giveActiveEffect(raceId, carol.userId, "DECOY", carolDecoy.id, new Date(Date.now() + 86400000));
    const teammateDecoyEffect = await giveActiveEffect(
      raceId,
      erin.userId,
      "DECOY",
      teammateDecoy.id,
      new Date(Date.now() + 86400000),
    );
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 3000);

    const response = await usePowerup(alice, raceId, storm.id, {}, TEAM_POWERUPS5);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [erin.userId]);
    assert.equal(body.result.redirectedToUserId, erin.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    assert.equal(body.result.affected, 1, "duplicate destination receives one effect");
    const effects = await activeEffects(raceId, "RAINSTORM");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [erin.userId]);
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, type: "RAINSTORM", targetUserId: alice.userId },
      })),
      0,
      "caster teammate is not an AoE victim before redirection",
    );
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, type: "DECOY", status: "ACTIVE" },
      })),
      1,
      "victim Decoys are consumed exactly once and destination Decoy is not chained",
    );
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: teammateDecoyEffect.id } })).status,
      "ACTIVE",
    );

    const bobOutageDecoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 4000);
    const carolOutageDecoy = await giveHeldPowerup(raceId, carol.userId, "DECOY", 5000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", bobOutageDecoy.id, new Date(Date.now() + 86400000));
    await giveActiveEffect(raceId, carol.userId, "DECOY", carolOutageDecoy.id, new Date(Date.now() + 86400000));
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 6000);
    const outageResponse = await usePowerup(alice, raceId, outage.id, {}, TEAM_POWERUPS5);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.deepEqual(outageBody.result.redirectedToUserIds, [erin.userId]);
    assert.equal(outageBody.result.affected, 1);
    assert.deepEqual(
      (await activeEffects(raceId, "POWER_OUTAGE")).map((effect) => effect.targetUserId),
      [erin.userId],
    );
  });

  it("runs destination Umbrella and Socks defenses after an AoE Decoy redirect", async () => {
    const alice = await createUser("DefenseCaster");
    const bob = await createUser("DefenseDecoy");
    const carol = await createUser("DefenseDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const umbrellaPowerup = await giveHeldPowerup(raceId, carol.userId, "UMBRELLA", 2000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const umbrella = await giveActiveEffect(
      raceId,
      carol.userId,
      "UMBRELLA",
      umbrellaPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 3000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.affected, 0);
    assert.equal(body.result.blockedCount, 0);
    assert.equal((await activeEffects(raceId, "RAINSTORM")).length, 0);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: umbrella.id } })).status, "ACTIVE");

    const alice2 = await createUser("SocksDefenseCaster");
    const bob2 = await createUser("SocksDefenseDecoy");
    const carol2 = await createUser("SocksDefenseDestination");
    const raceId2 = await createSoloRace([alice2, bob2, carol2]);
    const decoy2 = await giveHeldPowerup(raceId2, bob2.userId, "DECOY", 4000);
    const socksPowerup = await giveHeldPowerup(raceId2, carol2.userId, "COMPRESSION_SOCKS", 5000);
    await giveActiveEffect(raceId2, bob2.userId, "DECOY", decoy2.id, new Date(Date.now() + 86400000));
    const socks = await giveActiveEffect(
      raceId2,
      carol2.userId,
      "COMPRESSION_SOCKS",
      socksPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const outage = await giveHeldPowerup(raceId2, alice2.userId, "POWER_OUTAGE", 6000);
    const outageResponse = await usePowerup(alice2, raceId2, outage.id);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.deepEqual(outageBody.result.redirectedToUserIds, [carol2.userId]);
    assert.equal(outageBody.result.affected, 0);
    assert.equal(outageBody.result.blockedCount, 1);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, "BLOCKED");
    assert.equal((await activeEffects(raceId2, "POWER_OUTAGE")).length, 0);
  });

  it("does not let an expired destination Socks row block a redirected Power Outage", async () => {
    const alice = await createUser("ExpiredSocksCaster");
    const bob = await createUser("ExpiredSocksDecoy");
    const carol = await createUser("ExpiredSocksDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const socksPowerup = await giveHeldPowerup(raceId, carol.userId, "COMPRESSION_SOCKS", 2000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoy.id, new Date(Date.now() + 86400000));
    await giveActiveEffect(
      raceId,
      carol.userId,
      "COMPRESSION_SOCKS",
      socksPowerup.id,
      new Date(Date.now() - 1000),
    );
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 3000);

    const response = await usePowerup(alice, raceId, outage.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.affected, 1);
    assert.equal(body.result.blockedCount, 0);
    assert.equal((await activeEffects(raceId, "POWER_OUTAGE")).length, 1);
  });
});
