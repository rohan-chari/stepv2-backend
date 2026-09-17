const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, startServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { PowerupUsageState } = require("../../src/modules/powerups/models/powerupUsageState");

let server;
let identity = 0;
let clockNow = null;
const HEADERS = { "X-Client-Features": "characters,powerups3" };

async function user(name) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `cooldown-${++identity}` },
  });
  const body = await response.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName: name }, token: body.sessionToken, headers: HEADERS,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function raceWith(owner, opponent) {
  const opponents = Array.isArray(opponent) ? opponent : [opponent];
  for (const participant of opponents) {
    const friendship = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: participant.userId }, token: owner.token, headers: HEADERS,
    });
    await request(server.baseUrl, "PUT", `/friends/request/${(await friendship.json()).friendship.id}`, {
      body: { accept: true }, token: participant.token, headers: HEADERS,
    });
  }
  const created = await request(server.baseUrl, "POST", "/races", {
    body: { name: "Cooldown scope", isPublic: true, targetSteps: 100000,
      maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: owner.token, headers: HEADERS,
  });
  const raceId = (await created.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((participant) => participant.userId) }, token: owner.token, headers: HEADERS,
  });
  for (const participant of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true }, token: participant.token, headers: HEADERS,
    });
  }
  const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token, headers: HEADERS,
  });
  assert.equal(started.status, 200);
  return raceId;
}

async function held(raceId, owner, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId: owner.userId } },
  });
  return prisma.racePowerup.create({
    data: { raceId, participantId: participant.id, userId: owner.userId,
      type, rarity: "RARE", status: "HELD", earnedAtSteps },
  });
}

async function use(owner, raceId, item, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, {
    body: { targetUserId }, token: owner.token, headers: HEADERS,
  });
}

async function redeem(owner, raceId) {
  const response = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS,
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result?.powerup || body.powerup;
}

async function seedGlobalLeech(userId, quantity) {
  await prisma.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType: "LEECH" } },
    create: { userId, powerupType: "LEECH", quantity },
    update: { quantity },
  });
}

describe("power-up cooldown scope — HTTP integration", () => {
  before(async () => {
    await appSettings.setFlag("apiRaceBootstrapV1Enabled", true);
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({ sub: token, email: `${token}@example.com` }),
      now: () => clockNow || new Date(),
    });
  });
  after(async () => {
    await appSettings.setFlag("apiRaceBootstrapV1Enabled", false);
    await server.close();
  });
  beforeEach(async () => { await cleanDatabase(); identity = 0; clockNow = null; });

  it("enforces duration cooldown at the exact HTTP boundary without mutating rejected state", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("HTTP boundary owner");
    const victim = await user("HTTP boundary victim");
    const raceId = await raceWith(owner, victim);
    const existing = await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"),
      activeUntil: new Date("2026-09-17T14:00:00.000Z"),
      nextUsableAt: new Date("2026-09-17T15:00:00.000Z"),
    } });
    const heldItem = await held(raceId, owner, "LEECH", 1);
    clockNow = new Date("2026-09-17T14:59:59.999Z");
    const rejected = await use(owner, raceId, heldItem, victim.userId);
    assert.equal(rejected.status, 409);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: heldItem.id } })).status, "HELD");
    assert.deepEqual(await prisma.powerupUsageState.findUnique({ where: { id: existing.id } }), existing);
    clockNow = new Date("2026-09-17T15:00:00.000Z");
    const accepted = await use(owner, raceId, heldItem, victim.userId);
    assert.equal(accepted.status, 200);
  });

  it("enforces instant cooldown at the exact HTTP boundary", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_RAINSTORM" }, update: { active: true }, create: { sku: "POWERUP_RAINSTORM", name: "Rainstorm", priceCoins: 75, powerupType: "RAINSTORM", active: true } });
    const owner = await user("Instant boundary owner");
    const victim = await user("Instant boundary victim");
    const raceId = await raceWith(owner, victim);
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "RAINSTORM",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), nextUsableAt: new Date("2026-09-17T14:00:00.000Z"),
    } });
    const storm = await held(raceId, owner, "RAINSTORM", 1);
    clockNow = new Date("2026-09-17T13:59:59.999Z");
    assert.equal((await use(owner, raceId, storm, undefined)).status, 409);
    clockNow = new Date("2026-09-17T14:00:00.000Z");
    assert.equal((await use(owner, raceId, storm, undefined)).status, 200);
  });

  it("blocks a second same-type use in the same race without consuming it", async () => {
    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_LEECH" },
      update: { active: true },
      create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75,
        powerupType: "LEECH", active: true },
    });
    const owner = await user("Cooldown owner");
    const victim = await user("Cooldown victim");
    const secondVictim = await user("Cooldown second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    const first = await held(raceId, owner, "LEECH", 1);
    const second = await held(raceId, owner, "LEECH", 2);
    assert.equal((await use(owner, raceId, first, victim.userId)).status, 200);
    const rejected = await use(owner, raceId, second, secondVictim.userId);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "POWERUP_COOLDOWN");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: second.id } })).status, "HELD");
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId, powerupType: "LEECH" } }), 1);
  });

  it("keeps same-type cooldown state independent between races", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech",
      priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Cross race owner");
    const victimA = await user("Victim A");
    const victimB = await user("Victim B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    const first = await held(raceA, owner, "LEECH", 1);
    const second = await held(raceB, owner, "LEECH", 1);
    assert.equal((await use(owner, raceA, first, victimA.userId)).status, 200);
    assert.equal((await use(owner, raceB, second, victimB.userId)).status, 200);
    const rows = await prisma.powerupUsageState.findMany({
      where: { userId: owner.userId, powerupType: "LEECH" },
      orderBy: { raceId: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.raceId)), new Set([raceA, raceB]));
  });

  it("does not let Leech cooldown block a different shop powerup in the same race", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech",
      priceCoins: 75, powerupType: "LEECH", active: true } });
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_RAINSTORM" }, update: { active: true }, create: { sku: "POWERUP_RAINSTORM", name: "Rainstorm",
      priceCoins: 75, powerupType: "RAINSTORM", active: true } });
    const owner = await user("Type owner");
    const victim = await user("Type victim");
    const secondVictim = await user("Type second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    const leech = await held(raceId, owner, "LEECH", 1);
    const storm = await held(raceId, owner, "RAINSTORM", 2);
    assert.equal((await use(owner, raceId, leech, victim.userId)).status, 200);
    const stormResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${storm.id}/use`, {
      body: {}, token: owner.token, headers: HEADERS,
    });
    assert.equal(stormResponse.status, 200);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId } }), 2);
  });

  it("projects only the current race user's cooldown rows in bootstrap", async () => {
    const owner = await user("Projection owner");
    const victimA = await user("Projection A");
    const victimB = await user("Projection B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await prisma.powerupUsageState.create({ data: {
      raceId: raceA, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T12:00:00.000Z"),
      activeUntil: new Date("2026-09-17T14:00:00.000Z"),
      nextUsableAt: new Date("2026-09-17T15:00:00.000Z"),
    } });
    const bootstrap = async (raceId) => request(server.baseUrl, "GET", `/races/${raceId}/bootstrap`, {
      token: owner.token, headers: HEADERS,
    });
    const a = await bootstrap(raceA);
    const b = await bootstrap(raceB);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aRows = (await a.json()).powerupCooldowns;
    const bRows = (await b.json()).powerupCooldowns;
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0].powerupType, "LEECH");
    assert.deepEqual(bRows, []);
  });

  it("serializes same-race concurrent Leech uses", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent same race owner");
    const victim = await user("Concurrent same race victim");
    const secondVictim = await user("Concurrent same race second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    await seedGlobalLeech(owner.userId, 2);
    const [itemA, itemB] = await Promise.all([redeem(owner, raceId), redeem(owner, raceId)]);
    const responses = await Promise.all([
      use(owner, raceId, itemA, victim.userId),
      use(owner, raceId, itemB, secondVictim.userId),
    ]);
    const successes = responses.filter((response) => response.status === 200);
    assert.equal(successes.length, 1);
    // One redeemed item is consumed by the winner; the losing redeemed item is
    // returned by the existing rejection/refund path.
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 1);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId, powerupType: "LEECH" } }), 1);
  });

  it("allows cross-race concurrent Leech uses with quantity two", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent cross race owner");
    const victimA = await user("Concurrent cross race A");
    const victimB = await user("Concurrent cross race B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await seedGlobalLeech(owner.userId, 2);
    const [itemA, itemB] = await Promise.all([redeem(owner, raceA), redeem(owner, raceB)]);
    const responses = await Promise.all([use(owner, raceA, itemA, victimA.userId), use(owner, raceB, itemB, victimB.userId)]);
    assert.equal(responses.filter((response) => response.status === 200).length, 2);
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { userId: owner.userId, powerupType: "LEECH" } }), 2);
  });

  it("allows only one cross-race concurrent Leech use with quantity one", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent scarce owner");
    const victimA = await user("Concurrent scarce A");
    const victimB = await user("Concurrent scarce B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await seedGlobalLeech(owner.userId, 1);
    const responses = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceA}/powerups/redeem`, { body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS }),
      request(server.baseUrl, "POST", `/races/${raceB}/powerups/redeem`, { body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS }),
    ]);
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { userId: owner.userId, powerupType: "LEECH" } }), 0);
  });

  it("uses an injected comparison time for exact duration and instant boundaries", async () => {
    const owner = await user("Clock owner");
    const victim = await user("Clock victim");
    const raceId = await raceWith(owner, victim);
    const activeUntil = new Date("2026-09-17T14:00:00.000Z");
    const durationBoundary = new Date("2026-09-17T15:00:00.000Z");
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), activeUntil,
      nextUsableAt: durationBoundary,
    } });
    assert.ok(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "LEECH", new Date(durationBoundary.getTime() - 1)));
    assert.equal(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "LEECH", durationBoundary), null);
    await prisma.powerupUsageState.delete({ where: { raceId_userId_powerupType: { raceId, userId: owner.userId, powerupType: "LEECH" } } });
    const instantBoundary = new Date("2026-09-17T14:00:00.000Z");
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "RAINSTORM",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), nextUsableAt: instantBoundary,
    } });
    assert.ok(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "RAINSTORM", new Date(instantBoundary.getTime() - 1)));
    assert.equal(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "RAINSTORM", instantBoundary), null);
  });
});
