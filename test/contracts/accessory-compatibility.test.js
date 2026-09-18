const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanupAccessoryCompatibility,
} = require("../../src/modules/cosmetics/cleanupAccessoryCompatibility");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser() {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-accessory-compat-${++nextAppleId}` },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function createOwnedItem(userId, data) {
  const item = await prisma.shopItem.create({
    data: {
      priceCoins: 0,
      active: true,
      sortOrder: 0,
      ...data,
    },
  });
  await prisma.userShopItem.create({ data: { userId, shopItemId: item.id } });
  return item;
}

async function equip(token, slot, itemId) {
  return request(server.baseUrl, "PUT", `/shop/equipment/${slot}`, {
    token,
    body: { itemId },
  });
}

describe("accessory compatibility enforcement", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a conflicting cross-slot equip with an additive 409 body and preserves the old loadout", async () => {
    const user = await createUser();
    const helmet = await createOwnedItem(user.userId, {
      sku: "knight_helmet",
      name: "Knight Helmet",
      slot: "HEAD",
      assetKey: "knight_helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const glasses = await createOwnedItem(user.userId, {
      sku: "glasses_3d",
      name: "3D Glasses",
      slot: "FACE",
      assetKey: "glasses_3d",
      compatibility: { tags: ["eyewear"] },
    });

    assert.equal((await equip(user.token, "HEAD", helmet.id)).status, 200);

    const conflict = await equip(user.token, "FACE", glasses.id);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: "That accessory conflicts with Knight Helmet.",
      code: "ACCESSORY_CONFLICT",
      conflictingItemIds: [helmet.id],
      conflictingSlots: ["HEAD"],
    });

    const rows = await prisma.userEquippedAccessory.findMany({
      where: { userId: user.userId },
      orderBy: { slot: "asc" },
    });
    assert.deepEqual(rows.map((row) => [row.slot, row.shopItemId]), [["HEAD", helmet.id]]);
  });

  it("permanently rejects conflicting cross-slot equipment and accepts compatible equipment", async () => {
    const user = await createUser();
    const helmet = await createOwnedItem(user.userId, {
      sku: "flag_off_helmet",
      name: "Flag Off Helmet",
      slot: "HEAD",
      assetKey: "flag_off_helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const glasses = await createOwnedItem(user.userId, {
      sku: "flag_off_glasses",
      name: "Flag Off Glasses",
      slot: "FACE",
      assetKey: "flag_off_glasses",
      compatibility: { tags: ["eyewear"] },
    });
    const chain = await createOwnedItem(user.userId, {
      sku: "gold_chain",
      name: "Gold Chain",
      slot: "NECK",
      assetKey: "gold_chain",
      compatibility: null,
    });

    assert.equal((await equip(user.token, "HEAD", helmet.id)).status, 200);
    assert.equal((await equip(user.token, "FACE", glasses.id)).status, 409);
    const compatible = await equip(user.token, "NECK", chain.id);
    assert.equal(compatible.status, 200);
    assert.deepEqual(Object.keys((await compatible.json()).equipped).sort(), ["HEAD", "NECK"]);
  });

  it("serializes racing cross-slot equips so exactly one conflicting request succeeds", async () => {
    const user = await createUser();
    const helmet = await createOwnedItem(user.userId, {
      sku: "racing_knight_helmet",
      name: "Racing Knight Helmet",
      slot: "HEAD",
      assetKey: "racing_knight_helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const glasses = await createOwnedItem(user.userId, {
      sku: "racing_glasses_3d",
      name: "Racing 3D Glasses",
      slot: "FACE",
      assetKey: "racing_glasses_3d",
      compatibility: { tags: ["eyewear"] },
    });

    const results = await Promise.all([
      equip(user.token, "HEAD", helmet.id),
      equip(user.token, "FACE", glasses.id),
    ]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409]);

    const rows = await prisma.userEquippedAccessory.findMany({
      where: { userId: user.userId },
    });
    assert.equal(rows.length, 1);
    assert.ok([helmet.id, glasses.id].includes(rows[0].shopItemId));
  });

  it("cleans a legacy conflicting loadout idempotently, retaining its most recently updated item", async () => {
    const user = await createUser();
    const helmet = await createOwnedItem(user.userId, {
      sku: "legacy_knight_helmet",
      name: "Legacy Knight Helmet",
      slot: "HEAD",
      assetKey: "legacy_knight_helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const glasses = await createOwnedItem(user.userId, {
      sku: "legacy_glasses_3d",
      name: "Legacy 3D Glasses",
      slot: "FACE",
      assetKey: "legacy_glasses_3d",
      compatibility: { tags: ["eyewear"] },
    });
    await prisma.userEquippedAccessory.createMany({
      data: [
        { userId: user.userId, slot: "HEAD", shopItemId: helmet.id },
        { userId: user.userId, slot: "FACE", shopItemId: glasses.id },
      ],
    });
    await prisma.userEquippedAccessory.update({
      where: { userId_slot: { userId: user.userId, slot: "HEAD" } },
      data: { updatedAt: new Date("2026-08-12T12:00:00.000Z") },
    });
    await prisma.userEquippedAccessory.update({
      where: { userId_slot: { userId: user.userId, slot: "FACE" } },
      data: { updatedAt: new Date("2026-08-12T11:00:00.000Z") },
    });

    assert.deepEqual(await cleanupAccessoryCompatibility({ apply: false }), {
      usersChecked: 1,
      conflictingRows: 1,
      removed: 0,
    });
    assert.deepEqual(await cleanupAccessoryCompatibility({ apply: true }), {
      usersChecked: 1,
      conflictingRows: 1,
      removed: 1,
    });
    assert.deepEqual(await cleanupAccessoryCompatibility({ apply: true }), {
      usersChecked: 1,
      conflictingRows: 0,
      removed: 0,
    });
    const remaining = await prisma.userEquippedAccessory.findMany({
      where: { userId: user.userId },
    });
    assert.deepEqual(remaining.map((row) => row.shopItemId), [helmet.id]);
  });

  it("validates compatibility metadata through the admin create and PATCH API without leaking it into the public catalog", async () => {
    const user = await createUser();
    const adminEmail = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
    await prisma.user.update({ where: { id: user.userId }, data: { email: adminEmail } });

    const create = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: user.token,
      body: {
        sku: "compatibility_admin_hat",
        name: "Compatibility Admin Hat",
        slot: "HEAD",
        priceCoins: 25,
        assetKey: "compatibility_admin_hat",
        testOnly: false,
        compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
      },
    });
    assert.equal(create.status, 201, await create.clone().text());
    const created = (await create.json()).item;
    assert.deepEqual(created.compatibility, {
      tags: ["full_face"],
      blocksTags: ["eyewear"],
    });

    const publicCatalog = await request(server.baseUrl, "GET", "/shop/catalog", { token: user.token });
    const publicItem = (await publicCatalog.json()).items.find((item) => item.id === created.id);
    assert.ok(publicItem);
    assert.equal("compatibility" in publicItem, false);

    for (const compatibility of [
      { tags: ["unknown"] },
      { tags: ["eyewear", "eyewear"] },
      { tags: [42] },
      ["eyewear"],
    ]) {
      const patch = await request(
        server.baseUrl,
        "PATCH",
        `/admin/shop/items/${created.id}`,
        { token: user.token, body: { compatibility } }
      );
      assert.equal(patch.status, 400, JSON.stringify(compatibility));
    }

    const patch = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${created.id}`,
      { token: user.token, body: { compatibility: { tags: ["eyewear"] } } }
    );
    assert.equal(patch.status, 200);
    assert.deepEqual((await patch.json()).item.compatibility, { tags: ["eyewear"] });
  });
});
