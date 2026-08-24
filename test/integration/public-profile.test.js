const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  getSharedServer,
} = require("./setup");

let server;

async function createCompletedRace(userId, placement, overrides = {}) {
  const participantForfeitedAt = overrides.forfeitedAt || null;
  const { forfeitedAt: _ignored, ...raceOverrides } = overrides;
  const race = await prisma.race.create({
    data: {
      name: `Profile race ${placement}`,
      targetSteps: 10_000,
      status: "COMPLETED",
      completedAt: new Date(),
      ...raceOverrides,
    },
  });
  await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      placement,
      forfeitedAt: participantForfeitedAt,
    },
  });
  return race;
}

async function seedEquippedPresentation(userId) {
  const character = await prisma.shopItem.create({
    data: {
      sku: "public-profile-corgi",
      name: "Corgi",
      description: "Test character",
      slot: "CHARACTER",
      priceCoins: 0,
      assetKey: "corgi_puppy",
      renderMetadata: { offsetX: 0, offsetY: 0 },
    },
  });
  const hat = await prisma.shopItem.create({
    data: {
      sku: "public-profile-hat",
      name: "Hat",
      description: "Test hat",
      slot: "HEAD",
      priceCoins: 0,
      assetKey: "cowboy_hat",
      renderMetadata: { offsetX: 0, offsetY: 0 },
    },
  });
  await prisma.userEquippedAccessory.createMany({
    data: [
      { userId, slot: "CHARACTER", shopItemId: character.id },
      { userId, slot: "HEAD", shopItemId: hat.id },
    ],
  });
}

describe("GET /friends/:userId/profile", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  it("requires authentication and preserves the public-profile-v1 response shape", async () => {
    const unauthenticated = await request(
      server.baseUrl,
      "GET",
      "/friends/00000000-0000-0000-0000-000000000000/profile"
    );
    assert.equal(unauthenticated.status, 401);

    const viewer = await createTestUser({ displayName: "Viewer" });
    const target = await createTestUser({
      displayName: "Profile Runner",
      profilePhotoUrl: "https://example.test/profile.png",
    });
    await seedEquippedPresentation(target.user.id);

    await prisma.step.createMany({
      data: [
        { userId: target.user.id, date: new Date("2026-08-20"), steps: 1_000 },
        { userId: target.user.id, date: new Date("2026-08-21"), steps: 3_000 },
        { userId: target.user.id, date: new Date("2026-08-22"), steps: 8_000 },
      ],
    });
    await createCompletedRace(target.user.id, 1);
    await createCompletedRace(target.user.id, 2);
    await createCompletedRace(target.user.id, 3);

    const response = await request(
      server.baseUrl,
      "GET",
      `/friends/${target.user.id}/profile`,
      {
        token: viewer.token,
        headers: {
          "X-Client-Features": "characters",
          "X-Release-Channel": "testflight",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contract: "public-profile-v1",
      user: {
        id: target.user.id,
        displayName: "Profile Runner",
        profilePhotoUrl: "https://example.test/profile.png",
        equippedAnimal: "corgi_puppy",
        equippedAccessories: [
          {
            id: (await prisma.shopItem.findUnique({
              where: { sku: "public-profile-hat" },
              select: { id: true },
            })).id,
            sku: "public-profile-hat",
            name: "Hat",
            slot: "HEAD",
            assetKey: "cowboy_hat",
            renderMetadata: { offsetX: 0, offsetY: 0 },
            bobble: false,
          },
        ],
      },
      stats: {
        racePodiums: { first: 1, second: 1, third: 1 },
        avgStepsPerDay: 4_000,
      },
    });
  });

  it("returns 404 for unknown, review, and undiscoverable users", async () => {
    const viewer = await createTestUser({ displayName: "Viewer" });
    const unknown = await request(
      server.baseUrl,
      "GET",
      "/friends/00000000-0000-0000-0000-000000000000/profile",
      { token: viewer.token }
    );
    assert.equal(unknown.status, 404);

    const review = await createTestUser({
      displayName: "Review User",
      isReviewAccount: true,
    });
    const reviewResponse = await request(
      server.baseUrl,
      "GET",
      `/friends/${review.user.id}/profile`,
      { token: viewer.token }
    );
    assert.equal(reviewResponse.status, 404);

    const noDisplayName = await createTestUser();
    const undiscoverable = await request(
      server.baseUrl,
      "GET",
      `/friends/${noDisplayName.user.id}/profile`,
      { token: viewer.token }
    );
    assert.equal(undiscoverable.status, 404);
  });

  it("uses safe presentation defaults and excludes incomplete or forfeited races", async () => {
    const viewer = await createTestUser({ displayName: "Viewer" });
    const target = await createTestUser({ displayName: "Minimal Runner" });

    await createCompletedRace(target.user.id, 1, {
      forfeitedAt: new Date(),
    });
    await prisma.race.create({
      data: {
        name: "Active race",
        targetSteps: 10_000,
        status: "ACTIVE",
      },
    });
    await prisma.step.create({
      data: { userId: target.user.id, date: new Date("2026-08-20"), steps: 2_001 },
    });

    const response = await request(
      server.baseUrl,
      "GET",
      `/friends/${target.user.id}/profile`,
      { token: viewer.token }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.user, {
      id: target.user.id,
      displayName: "Minimal Runner",
      profilePhotoUrl: null,
      equippedAnimal: null,
      equippedAccessories: [],
    });
    assert.deepEqual(body.stats, {
      racePodiums: { first: 0, second: 0, third: 0 },
      avgStepsPerDay: 2_001,
    });
  });
});
