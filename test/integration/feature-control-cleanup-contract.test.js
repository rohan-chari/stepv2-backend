const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const {
  appSettings,
} = require("../../src/shared/config/appSettings");

let server;
let userCounter = 0;

const RETIRED_IMPOSTER = {
  error: "This powerup has been retired.",
  code: "POWERUP_RETIRED",
  powerupType: "IMPOSTER",
};

async function createUser(coins = 0) {
  const identityToken = `cleanup-contract-${++userCounter}`;
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  if (coins > 0) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { coins },
    });
  }
  return { id: body.user.id, token: body.sessionToken };
}

async function seedImposterCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: "POWERUP_IMPOSTER" },
    update: { active: true, testOnly: false, priceCoins: 75 },
    create: {
      sku: "POWERUP_IMPOSTER",
      name: "Imposter",
      description: "Historical copy retained for old activity rows.",
      priceCoins: 75,
      powerupType: "IMPOSTER",
      active: true,
      testOnly: false,
    },
  });
}

describe("feature-control cleanup compatibility contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    userCounter = 0;
    await appSettings.setFlag("redisCacheAuthMeEnabled", false);
  });

  it("serves permanent /auth/me compatibility values independent of retired rows", async () => {
    const retiredRowOpposites = {
      teamRacesEnabled: false,
      customRaceWindowEnabled: false,
      onboardingV2Enabled: false,
      onboardingV3Enabled: false,
      onboardingInviteCodeEnabled: true,
      openUserRaceDiscoveryEnabled: false,
      quickCreateRaceCtaEnabled: false,
      setupInviteCodePromptEnabled: false,
      homeInviteModalEnabled: false,
      tutorialMandatoryEnabled: false,
      stepSampleBucketMinutes: 60,
    };
    for (const [key, value] of Object.entries(retiredRowOpposites)) {
      await appSettings.setFlag(key, value);
    }

    const user = await createUser();
    const response = await request(server.baseUrl, "GET", "/auth/me", {
      token: user.token,
      headers: { "X-App-Version": "99.0.0" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(
      {
        characterPowersEnabled: body.user.characterPowersEnabled,
        teamRacesEnabled: body.user.featureFlags.teamRacesEnabled,
        customRaceWindowEnabled:
          body.user.featureFlags.customRaceWindowEnabled,
        onboardingV2Enabled: body.user.featureFlags.onboardingV2Enabled,
        onboardingV3Enabled: body.user.featureFlags.onboardingV3Enabled,
        onboardingInviteCodeEnabled:
          body.user.featureFlags.onboardingInviteCodeEnabled,
        openUserRaceDiscoveryEnabled:
          body.user.featureFlags.openUserRaceDiscoveryEnabled,
        quickCreateRaceCtaEnabled:
          body.user.featureFlags.quickCreateRaceCtaEnabled,
        setupInviteCodePromptEnabled:
          body.user.featureFlags.setupInviteCodePromptEnabled,
        homeInviteModalEnabled: body.user.featureFlags.homeInviteModalEnabled,
        tutorialMandatoryEnabled:
          body.user.featureFlags.tutorialMandatoryEnabled,
        stepSampleBucketMinutes:
          body.user.featureFlags.stepSampleBucketMinutes,
      },
      {
        characterPowersEnabled: false,
        teamRacesEnabled: true,
        customRaceWindowEnabled: true,
        onboardingV2Enabled: true,
        onboardingV3Enabled: true,
        onboardingInviteCodeEnabled: false,
        openUserRaceDiscoveryEnabled: true,
        quickCreateRaceCtaEnabled: true,
        setupInviteCodePromptEnabled: true,
        homeInviteModalEnabled: true,
        tutorialMandatoryEnabled: true,
        stepSampleBucketMinutes: 5,
      },
    );
  });

  it("keeps the pre-1.7.1 five-minute-sample compatibility gate", async () => {
    const user = await createUser();
    const response = await request(server.baseUrl, "GET", "/auth/me", {
      token: user.token,
      headers: { "X-App-Version": "1.7.0" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      Object.hasOwn(body.user.featureFlags, "stepSampleBucketMinutes"),
      false,
    );
  });

  it("omits Imposter and tombstones crafted purchase/redeem requests without mutation", async () => {
    await seedImposterCatalog();
    const user = await createUser(500);
    await prisma.userPowerupItem.create({
      data: { userId: user.id, powerupType: "IMPOSTER", quantity: 2 },
    });

    const catalogResponse = await request(
      server.baseUrl,
      "GET",
      "/shop/powerups",
      { token: user.token },
    );
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(
      catalog.items.some((item) => item.powerupType === "IMPOSTER"),
      false,
    );

    const inventoryResponse = await request(
      server.baseUrl,
      "GET",
      "/powerups/inventory",
      { token: user.token },
    );
    assert.equal(inventoryResponse.status, 200);
    const inventory = await inventoryResponse.json();
    assert.equal(
      inventory.items.some((item) => item.powerupType === "IMPOSTER"),
      false,
    );

    const purchaseResponse = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/purchase",
      {
        token: user.token,
        headers: { "Idempotency-Key": "retired-imposter-purchase" },
        body: { sku: "POWERUP_IMPOSTER" },
      },
    );
    assert.equal(purchaseResponse.status, 410);
    assert.deepEqual(await purchaseResponse.json(), RETIRED_IMPOSTER);

    const redeemResponse = await request(
      server.baseUrl,
      "POST",
      "/races/not-a-real-race/powerups/redeem",
      {
        token: user.token,
        body: { powerupType: "IMPOSTER" },
      },
    );
    assert.equal(redeemResponse.status, 410);
    assert.deepEqual(await redeemResponse.json(), RETIRED_IMPOSTER);

    const [freshUser, freshInventory, purchaseRows, heldRows] =
      await Promise.all([
        prisma.user.findUnique({ where: { id: user.id } }),
        prisma.userPowerupItem.findUnique({
          where: {
            userId_powerupType: {
              userId: user.id,
              powerupType: "IMPOSTER",
            },
          },
        }),
        prisma.powerupPurchaseRequest.count({ where: { userId: user.id } }),
        prisma.racePowerup.count({
          where: { userId: user.id, type: "IMPOSTER" },
        }),
      ]);
    assert.equal(freshUser.coins, 500);
    assert.equal(freshInventory.quantity, 2);
    assert.equal(purchaseRows, 0);
    assert.equal(heldRows, 0);
  });

  it("tombstones an existing race-scoped Imposter without consuming it", async () => {
    const owner = await createUser();
    const opponent = await createUser();

    const createResponse = await request(server.baseUrl, "POST", "/races", {
      token: owner.token,
      body: {
        name: "Retired powerup contract",
        maxDurationDays: 1,
        maxParticipants: 2,
        isPublic: true,
        powerupsEnabled: true,
      },
    });
    assert.equal(createResponse.status, 201);
    const raceId = (await createResponse.json()).race.id;

    const joinResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join`,
      { token: opponent.token },
    );
    assert.equal(joinResponse.status, 201);
    const startResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/start`,
      { token: owner.token },
    );
    assert.equal(startResponse.status, 200);

    const participant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: owner.id },
    });
    const held = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: owner.id,
        type: "IMPOSTER",
        rarity: null,
        status: "HELD",
      },
    });

    const useResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${held.id}/use`,
      {
        token: owner.token,
        body: { targetUserId: opponent.id },
      },
    );
    assert.equal(useResponse.status, 410);
    assert.deepEqual(await useResponse.json(), RETIRED_IMPOSTER);

    const freshHeld = await prisma.racePowerup.findUnique({
      where: { id: held.id },
    });
    assert.equal(freshHeld.status, "HELD");
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: { raceId, type: "IMPOSTER" },
      }),
      0,
    );
  });
});
