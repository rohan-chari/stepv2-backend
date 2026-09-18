const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const {
  POWERUP_COPY_SEED,
} = require("../../src/modules/powerups/constants/powerupCopySeed");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");

const FULL_POWERUP_HEADERS = {
  "X-Client-Features": [
    "characters",
    "jammer",
    "powerups2",
    "powerups3",
    "powerups4",
    "powerups5",
    "powerup_stacking_guide_v1",
  ].join(","),
};

let server;

async function createActiveRace(users, overrides = {}) {
  const now = Date.now();
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: `Powerup clarity ${now}`,
      targetSteps: 200_000,
      status: "ACTIVE",
      startedAt: new Date(now - 2 * 60 * 60 * 1000),
      endsAt: new Date(now + 4 * 60 * 60 * 1000),
      timezone: "UTC",
      powerupsEnabled: true,
      powerupStepInterval: 5_000,
      ...overrides,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map(({ user }) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      joinedAt: race.startedAt,
    })),
  });
  return race;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
}

async function givePowerup(raceId, userId, type, status = "HELD", extra = {}) {
  const owner = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: owner.id,
      userId,
      type,
      rarity: "COMMON",
      status,
      ...extra,
    },
  });
}

async function giveEffect({
  raceId,
  sourceUserId,
  targetUserId,
  type,
  status = "ACTIVE",
  startsAt = new Date(Date.now() - 60_000),
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
  metadata = {},
}) {
  const target = await participant(raceId, targetUserId);
  const backing = await givePowerup(raceId, sourceUserId, type, "USED");
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: target.id,
      targetUserId,
      sourceUserId,
      powerupId: backing.id,
      type,
      status,
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

async function progressFor(user, raceId, headers = FULL_POWERUP_HEADERS) {
  const response = await request(
    server.baseUrl,
    "GET",
    `/races/${raceId}/progress`,
    { token: user.token, headers },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).progress;
}

async function usePowerup(user, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    {
      token: user.token,
      headers: FULL_POWERUP_HEADERS,
      body,
    },
  );
}

async function seedCopyCatalog() {
  for (const row of POWERUP_COPY_SEED) {
    await prisma.powerupCopy.upsert({
      where: { powerupType: row.powerupType },
      update: row,
      create: row,
    });
  }
}

async function seedShopItem(type, { testOnly = false, active = true } = {}) {
  return prisma.powerupShopItem.create({
    data: {
      sku: `clarity-${type.toLowerCase()}-${testOnly ? "tf" : "prod"}`,
      name: type,
      description: type,
      priceCoins: 100,
      powerupType: type,
      active,
      testOnly,
      sortOrder: 1,
    },
  });
}

describe("powerup activation clarity and invariants — locked HTTP contracts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({
      where: { sku: { startsWith: "clarity-" } },
    });
    balanceConfig.bustCache();
  });

  it("GET progress returns an advisory viewer-specific Trail Mix count only to a holder", async () => {
    const alice = await createTestUser({ displayName: "Trail Alice" });
    const bob = await createTestUser({ displayName: "Trail Bob" });
    const carol = await createTestUser({ displayName: "Trail Carol" });
    const race = await createActiveRace([alice, bob, carol]);

    await givePowerup(race.id, alice.user.id, "PROTEIN_SHAKE", "USED");
    await givePowerup(race.id, alice.user.id, "RUNNERS_HIGH", "USED");
    await givePowerup(race.id, alice.user.id, "TRAIL_MIX", "HELD");
    await givePowerup(race.id, bob.user.id, "TRAIL_MIX", "HELD");
    await givePowerup(race.id, carol.user.id, "PROTEIN_SHAKE", "USED");

    const aliceProgress = await progressFor(alice, race.id);
    const bobProgress = await progressFor(bob, race.id);
    const carolProgress = await progressFor(carol, race.id);

    assert.deepEqual(aliceProgress.powerupData.trailMix, {
      uniqueTypesIfUsedNow: 3,
    });
    assert.deepEqual(bobProgress.powerupData.trailMix, {
      uniqueTypesIfUsedNow: 1,
    });
    assert.equal(
      Object.hasOwn(carolProgress.powerupData, "trailMix"),
      false,
      "a non-holder gets no hot-path preview query or field",
    );
  });

  it("POST Trail Mix use returns authoritative bonus, uniqueTypes, and perType", async () => {
    const alice = await createTestUser({ displayName: "Mix User" });
    const bob = await createTestUser({ displayName: "Mix Rival" });
    const race = await createActiveRace([alice, bob]);
    await givePowerup(race.id, alice.user.id, "PROTEIN_SHAKE", "USED");
    await givePowerup(race.id, alice.user.id, "RUNNERS_HIGH", "USED");
    const trailMix = await givePowerup(
      race.id,
      alice.user.id,
      "TRAIL_MIX",
      "HELD",
    );

    const response = await usePowerup(alice, race.id, trailMix.id);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.result.uniqueTypes, 3);
    assert.equal(body.result.perType, 100);
    assert.equal(body.result.bonus, 300);
  });

  it("a distinct second Leech gets the locked coded 409 before item or coin consumption", async () => {
    const first = await createTestUser({ displayName: "First Leech" });
    const second = await createTestUser({ displayName: "Second Leech" });
    const victim = await createTestUser({ displayName: "Leech Victim" });
    const race = await createActiveRace([first, second, victim]);
    await prisma.user.update({
      where: { id: second.user.id },
      data: { coins: 500 },
    });
    const firstItem = await givePowerup(race.id, first.user.id, "LEECH");
    const secondItem = await givePowerup(race.id, second.user.id, "LEECH");

    const accepted = await usePowerup(first, race.id, firstItem.id, {
      targetUserId: victim.user.id,
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());

    const rejected = await usePowerup(second, race.id, secondItem.id, {
      targetUserId: victim.user.id,
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "This rival is already being leeched",
      code: "LEECH_TARGET_ALREADY_ACTIVE",
    });
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: secondItem.id } })).status,
      "HELD",
    );
    assert.equal(
      (await prisma.user.findUnique({ where: { id: second.user.id } })).coins,
      500,
    );
  });

  it("the Leech rejection wrapper refunds a redeemed stash item", async () => {
    const first = await createTestUser({ displayName: "Stash First" });
    const second = await createTestUser({ displayName: "Stash Second" });
    const victim = await createTestUser({ displayName: "Stash Victim" });
    const race = await createActiveRace([first, second, victim]);
    const firstItem = await givePowerup(race.id, first.user.id, "LEECH");
    assert.equal(
      (await usePowerup(first, race.id, firstItem.id, {
        targetUserId: victim.user.id,
      })).status,
      200,
    );
    await prisma.userPowerupItem.create({
      data: { userId: second.user.id, powerupType: "LEECH", quantity: 1 },
    });
    const redeem = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/redeem`,
      {
        token: second.token,
        headers: FULL_POWERUP_HEADERS,
        body: { powerupType: "LEECH" },
      },
    );
    assert.equal(redeem.status, 200, await redeem.clone().text());
    const redeemed = (await redeem.json()).result.powerup;

    const rejected = await usePowerup(second, race.id, redeemed.id, {
      targetUserId: victim.user.id,
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "LEECH_TARGET_ALREADY_ACTIVE");
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: redeemed.id } })).status,
      "DISCARDED",
    );
    assert.equal(
      (await prisma.userPowerupItem.findUnique({
        where: {
          userId_powerupType: {
            userId: second.user.id,
            powerupType: "LEECH",
          },
        },
      })).quantity,
      1,
    );
  });

  for (const staleState of [
    { label: "expired ACTIVE", status: "ACTIVE", expiresAt: new Date(0) },
    {
      label: "future-dated non-active",
      status: "EXPIRED",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  ]) {
    it(`${staleState.label} Leech does not block a new activation`, async () => {
      const first = await createTestUser({ displayName: `Old ${staleState.label}` });
      const second = await createTestUser({ displayName: `New ${staleState.label}` });
      const victim = await createTestUser({ displayName: `Victim ${staleState.label}` });
      const race = await createActiveRace([first, second, victim]);
      await giveEffect({
        raceId: race.id,
        sourceUserId: first.user.id,
        targetUserId: victim.user.id,
        type: "LEECH",
        status: staleState.status,
        expiresAt: staleState.expiresAt,
      });
      const item = await givePowerup(race.id, second.user.id, "LEECH");

      const response = await usePowerup(second, race.id, item.id, {
        targetUserId: victim.user.id,
      });
      assert.equal(response.status, 200, await response.clone().text());
    });
  }

  it("simultaneous real-HTTP Leech activations leave exactly one success and one live row", async () => {
    const first = await createTestUser({ displayName: "Concurrent First" });
    const second = await createTestUser({ displayName: "Concurrent Second" });
    const victim = await createTestUser({ displayName: "Concurrent Victim" });
    const race = await createActiveRace([first, second, victim]);
    await prisma.user.updateMany({
      where: { id: { in: [first.user.id, second.user.id] } },
      data: { coins: 700 },
    });
    const firstItem = await givePowerup(race.id, first.user.id, "LEECH");
    const secondItem = await givePowerup(race.id, second.user.id, "LEECH");

    const responses = await Promise.all([
      usePowerup(first, race.id, firstItem.id, { targetUserId: victim.user.id }),
      usePowerup(second, race.id, secondItem.id, { targetUserId: victim.user.id }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 409],
    );
    assert.equal(
      bodies.filter((body) => body.code === "LEECH_TARGET_ALREADY_ACTIVE").length,
      1,
    );
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: {
          raceId: race.id,
          targetUserId: victim.user.id,
          type: "LEECH",
          status: "ACTIVE",
          expiresAt: { gt: new Date() },
        },
      }),
      1,
    );
    const items = await prisma.racePowerup.findMany({
      where: { id: { in: [firstItem.id, secondItem.id] } },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(items.map((item) => item.status).sort(), ["HELD", "USED"]);
    const users = await prisma.user.findMany({
      where: { id: { in: [first.user.id, second.user.id] } },
    });
    assert.ok(users.every((user) => user.coins === 700));
  });

  it("GET catalog emits availability v2 for shop-only, roll-only, both, and excludes neither", async () => {
    await seedCopyCatalog();
    await seedShopItem("LEECH");
    await seedShopItem("TRAIL_MIX");

    const response = await request(server.baseUrl, "GET", "/powerups/catalog", {
      headers: FULL_POWERUP_HEADERS,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.availabilityVersion, 2);
    const byType = new Map(body.powerups.map((row) => [row.type, row]));
    assert.deepEqual(byType.get("LEECH").availability, {
      shop: true,
      roll: false,
    });
    assert.deepEqual(byType.get("PROTEIN_SHAKE").availability, {
      shop: false,
      roll: true,
    });
    assert.deepEqual(byType.get("TRAIL_MIX").availability, {
      shop: true,
      roll: true,
    });
    assert.equal(byType.has("CAMPFIRE_REST"), false);
    assert.ok(!byType.has("IMPOSTER"));
  });

  it("GET catalog preserves capability gates and isolates prod from TestFlight shop availability", async () => {
    await seedCopyCatalog();
    await seedShopItem("LEECH", { testOnly: true });
    await seedShopItem("GHOST_PEPPER");

    const oldCapabilities = {
      "X-Client-Features": "characters,powerup_stacking_guide_v1",
    };
    const legacy = await request(server.baseUrl, "GET", "/powerups/catalog", {
      headers: oldCapabilities,
    });
    const legacyTypes = (await legacy.json()).powerups.map((row) => row.type);
    assert.ok(!legacyTypes.includes("GHOST_PEPPER"));

    const prod = await request(server.baseUrl, "GET", "/powerups/catalog", {
      headers: FULL_POWERUP_HEADERS,
    });
    const prodTypes = (await prod.json()).powerups.map((row) => row.type);
    assert.ok(!prodTypes.includes("LEECH"));

    const testflight = await request(server.baseUrl, "GET", "/powerups/catalog", {
      headers: {
        ...FULL_POWERUP_HEADERS,
        "X-Release-Channel": "testflight",
      },
    });
    const testflightBody = await testflight.json();
    assert.equal(testflightBody.availabilityVersion, 2);
    assert.deepEqual(
      testflightBody.powerups.find((row) => row.type === "LEECH").availability,
      { shop: true, roll: false },
    );
  });

  it("GET catalog fails open without availability when either source is non-authoritative", async (t) => {
    const copyRows = POWERUP_COPY_SEED.slice(0, 3).map((row, index) => ({
      ...row,
      updatedAt: new Date(1_700_000_000_000 + index),
    }));
    const isolated = await startServer({
      PowerupCopy: { async findAll() { return copyRows; } },
      PowerupShopItem: {
        async findActive() {
          throw new Error("shop source unavailable");
        },
      },
      powerupBalanceConfig: {
        async getAvailabilitySnapshot() {
          return { authoritative: true, config: {} };
        },
      },
    });
    t.after(() => isolated.close());

    const response = await request(
      isolated.baseUrl,
      "GET",
      "/powerups/catalog",
      { headers: FULL_POWERUP_HEADERS },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(Object.hasOwn(body, "availabilityVersion"), false);
    assert.equal(body.powerups.length, copyRows.length);
    assert.ok(body.powerups.every((row) => !Object.hasOwn(row, "availability")));
  });

  it("viewer-visible Ghost Pepper exposes only allowlisted phase timing fields", async () => {
    const alice = await createTestUser({ displayName: "Pepper Owner" });
    const bob = await createTestUser({ displayName: "Pepper Rival" });
    const race = await createActiveRace([alice, bob]);
    const startsAt = new Date(Date.now() - 10 * 60 * 1000);
    await giveEffect({
      raceId: race.id,
      sourceUserId: alice.user.id,
      targetUserId: alice.user.id,
      type: "GHOST_PEPPER",
      startsAt,
      expiresAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      metadata: {
        multiplier: 3,
        boostMs: 1_800_000,
        freezeMs: 1_800_000,
        secretInternalValue: "must-not-leak",
      },
    });

    const progress = await progressFor(alice, race.id);
    const pepper = progress.powerupData.activeEffects.find(
      (effect) => effect.type === "GHOST_PEPPER",
    );
    assert.ok(pepper);
    assert.equal(pepper.startsAt, startsAt.toISOString());
    assert.deepEqual(pepper.phaseDurations, {
      boostMs: 1_800_000,
      burnoutMs: 1_800_000,
    });
    assert.equal(Object.hasOwn(pepper, "metadata"), false);
    assert.equal(Object.hasOwn(pepper, "secretInternalValue"), false);
  });
});
