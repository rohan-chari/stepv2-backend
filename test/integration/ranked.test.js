const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-ranked-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;

  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });

  return { userId, token };
}

describe("ranked", () => {
  before(async () => {
    server = await getSharedServer(authOverrides());
  });

  after(async () => {
    await cleanDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("includes equipped accessories for ranked podium rows", async () => {
    const alice = await createUser("AliceRanked");
    const latestSeason = await prisma.season.findFirst({
      orderBy: { index: "desc" },
      select: { index: true },
    });
    const season = await prisma.season.create({
      data: {
        index: (latestSeason?.index ?? 0) + 1,
        startsAt: new Date("2026-05-01T00:00:00.000Z"),
        endsAt: new Date("2026-06-30T00:00:00.000Z"),
        status: "ACTIVE",
      },
    });
    await prisma.seasonScore.create({
      data: {
        userId: alice.userId,
        seasonId: season.id,
        points: 100,
        earnedPoints: 100,
        carryOverSeed: 0,
        provisionalRank: 1,
        provisionalTier: "BRONZE",
        provisionalDivision: 2,
      },
    });
    const item = await prisma.shopItem.create({
      data: {
        sku: "ranked-head",
        name: "Ranked Hat",
        slot: "HEAD",
        priceCoins: 25,
        assetKey: "cowboy_hat",
        renderMetadata: { offsetX: 1, offsetY: 2 },
      },
    });
    await prisma.userEquippedAccessory.create({
      data: { userId: alice.userId, slot: "HEAD", shopItemId: item.id },
    });

    const res = await request(server.baseUrl, "GET", "/ranked", {
      token: alice.token,
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body.ladder[0].equippedAccessories, [
      {
        id: item.id,
        sku: item.sku,
        name: item.name,
        slot: item.slot,
        assetKey: item.assetKey,
        renderMetadata: { offsetX: 1, offsetY: 2 },
        bobble: false,
      },
    ]);
  });
});
