const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require("./setup");

let server;
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);

async function owned(userId, data) {
  const item = await prisma.shopItem.create({ data: { priceCoins: 0, active: true, sortOrder: 0, ...data } });
  await prisma.userShopItem.create({ data: { userId, shopItemId: item.id } });
  return item;
}

describe("Bara Gold character compatibility policy", () => {
  it("rejects a Football Helmet on Mouse and keeps Knight/Football helmets incompatible with face items", async () => {
    const user = await createTestUser();
    const mouse = await owned(user.user.id, { sku: "mouse", name: "Mouse", slot: "CHARACTER", assetKey: "mouse" });
    const football = await owned(user.user.id, { sku: "football_helmet", name: "Football Helmet", slot: "HEAD", assetKey: "football_helmet" });
    const knight = await owned(user.user.id, { sku: "knight_helmet", name: "Knight Helmet", slot: "HEAD", assetKey: "knight_helmet" });
    const glasses = await owned(user.user.id, { sku: "face-glasses", name: "Glasses", slot: "FACE", assetKey: "glasses" });
    const headers = { "X-Client-Features": "characters,bara_gold_v1" };
    assert.equal((await request(server.baseUrl, "PUT", "/shop/equipment/CHARACTER", { token: user.token, headers, body: { itemId: mouse.id } })).status, 200);
    assert.equal((await request(server.baseUrl, "PUT", "/shop/equipment/HEAD", { token: user.token, headers, body: { itemId: football.id } })).status, 409);
    assert.equal((await request(server.baseUrl, "PUT", "/shop/equipment/HEAD", { token: user.token, headers, body: { itemId: knight.id } })).status, 200);
    assert.equal((await request(server.baseUrl, "PUT", "/shop/equipment/FACE", { token: user.token, headers, body: { itemId: glasses.id } })).status, 409);
  });
});
