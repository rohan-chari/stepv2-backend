// Local/test-only two-checkout HTTP verification of release A + B coexistence.
const path = require("node:path");
const dbName = decodeURIComponent(
  new URL(process.env.DATABASE_URL || "postgresql://localhost/invalid")
    .pathname,
);
if (!dbName.endsWith("_test"))
  throw new Error(
    "Release protocol verification requires a dedicated *_test database.",
  );
if (!process.argv[2])
  throw new Error(
    "Pass the absolute path to a checkout of compatible-writer release A.",
  );
const assert = require("node:assert/strict");
const A = require(process.argv[2] + "/test/integration/setup");
const B = require(path.join(__dirname, "../test/integration/setup"));
(async () => {
  await B.cleanDatabase();
  const a = await A.getSharedServer(),
    b = await B.getSharedServer();
  try {
    let response = await B.request(b.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "apple-mixed-wardrobe" },
    });
    const user = await response.json(),
      userId = user.user.id,
      token = user.sessionToken;
    const h = await B.prisma.shopItem.create({
      data: {
        sku: "mixed_hat",
        name: "Hat",
        slot: "HEAD",
        assetKey: "birthday_hat",
        priceCoins: 0,
      },
    });
    const c = await B.prisma.shopItem.create({
      data: {
        sku: "mixed_character",
        name: "Character",
        slot: "CHARACTER",
        assetKey: "corgi_puppy",
        priceCoins: 0,
      },
    });
    await B.prisma.userShopItem.createMany({
      data: [h, c].map((i) => ({ userId, shopItemId: i.id })),
    });
    await B.prisma.shopItemCharacterFit.create({
      data: {
        accessoryShopItemId: h.id,
        characterKey: c.id,
        characterShopItemId: c.id,
      },
    });
    const call = async (server, method, path, body) => {
      const r = await B.request(server.baseUrl, method, path, {
        token,
        body,
        headers: { "X-Client-Features": "characters,remote_assets" },
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await call(a, "GET", "/shop/characters")).status, 404);
    assert.equal((await call(b, "GET", "/shop/characters")).status, 200);
    assert.equal(
      (await call(a, "PUT", "/shop/equipment/HEAD", { itemId: h.id })).status,
      200,
    );
    let read = await call(b, "GET", "/shop/characters/default/wardrobe");
    assert.equal(read.body.outfit.slots.HEAD, h.id);
    assert.equal(read.body.appearanceRevision, 1);
    assert.equal(
      (
        await call(b, "PUT", `/shop/characters/${c.id}/outfit`, {
          expectedOutfitRevision: 0,
          slots: { HEAD: h.id, FACE: null, NECK: null, BACK: null, FEET: null },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(b, "PUT", "/shop/active-character", {
          characterKey: c.id,
          expectedOutfitRevision: 1,
          expectedAppearanceRevision: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(a, "PUT", "/shop/equipment/CHARACTER", { itemId: null }))
        .status,
      200,
    );
    read = await call(b, "GET", "/shop/characters/default/wardrobe");
    assert.equal(read.body.activeCharacterKey, "default");
    assert.equal(read.body.outfit.slots.HEAD, h.id);
    assert.equal(read.body.appearanceRevision, 3);
    // Rollback-to-A still has no new endpoints and continues the writer protocol.
    assert.equal((await call(a, "GET", "/shop/characters")).status, 404);
    assert.equal(
      (await call(a, "PUT", "/shop/equipment/HEAD", { itemId: null })).status,
      200,
    );
    read = await call(b, "GET", "/shop/characters/default/wardrobe");
    assert.equal(read.body.outfit.slots.HEAD, null);
    assert.equal(read.body.appearanceRevision, 4);
    console.log(
      JSON.stringify({
        aOnly: true,
        mixedWriters: true,
        rollbackToA: true,
        finalAppearanceRevision: 4,
      }),
    );
  } finally {
    await a.close();
    await b.close();
    await A.prisma.$disconnect();
    await B.prisma.$disconnect();
  }
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
