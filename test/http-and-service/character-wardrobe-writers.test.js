const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
let server, userId, token;
async function equip(slot, itemId) {
  const r = await request(server.baseUrl, "PUT", `/shop/equipment/${slot}`, {
    token,
    headers: { "X-Client-Features": "characters" },
    body: { itemId },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function item(slot) {
  const i = await prisma.shopItem.create({
    data: {
      sku: crypto.randomUUID(),
      name: slot,
      slot,
      assetKey: slot,
      priceCoins: 0,
    },
  });
  await prisma.userShopItem.create({ data: { userId, shopItemId: i.id } });
  return i;
}
describe("release A compatible writers", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const r = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "apple-wardrobe-a" },
    });
    const b = await r.json();
    userId = b.user.id;
    token = b.sessionToken;
  });
  it("dual-writes carry-over and null without changing legacy response keys or untouched equipment timestamps", async () => {
    const h = await item("HEAD"),
      c = await item("CHARACTER");
    let r = await equip("HEAD", h.id);
    assert.deepEqual(Object.keys(r), ["equipped"]);
    const row = await prisma.userEquippedAccessory.findFirst({
      where: { userId, slot: "HEAD" },
    });
    await equip("CHARACTER", c.id);
    await equip("CHARACTER", null);
    assert.deepEqual(
      await prisma.userEquippedAccessory.findUnique({ where: { id: row.id } }),
      row,
    );
    const outfits = await prisma.characterWardrobe.findMany({
      where: { userId },
      include: { items: true },
    });
    assert.equal(outfits.length, 2);
    assert.ok(outfits.every((w) => w.items[0].shopItemId === h.id));
    assert.equal(
      (await prisma.user.findUnique({ where: { id: userId } }))
        .appearanceRevision,
      3,
    );
    await equip("HEAD", null);
    assert.equal(
      (
        await prisma.characterWardrobe.findFirst({
          where: { userId, characterKey: "default" },
          include: { items: true },
        })
      ).items.length,
      0,
    );
    assert.equal(
      (await prisma.user.findUnique({ where: { id: userId } }))
        .appearanceRevision,
      4,
    );
  });
  it("same legacy item and absent-slot unequip are no-ops", async () => {
    const h = await item("HEAD");
    await equip("HEAD", h.id);
    const row = await prisma.userEquippedAccessory.findFirst({
      where: { userId },
    });
    await equip("HEAD", h.id);
    await equip("FACE", null);
    assert.deepEqual(
      await prisma.userEquippedAccessory.findUnique({ where: { id: row.id } }),
      row,
    );
    assert.equal(
      (await prisma.user.findUnique({ where: { id: userId } }))
        .appearanceRevision,
      1,
    );
  });
});
