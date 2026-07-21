const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const execFileAsync = promisify(execFile);

let server;
let nextAppleId = 0;

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser() {
  const appleId = `apple-pwshop-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function createAdmin() {
  const admin = await createUser();
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

async function seedItem(overrides = {}) {
  const sku = overrides.sku || `POWERUP_TEST_${Math.random().toString(36).slice(2, 8)}`;
  return prisma.powerupShopItem.upsert({
    where: { sku },
    update: {},
    create: {
      sku,
      name: overrides.name || "Test Powerup",
      description: overrides.description || "desc",
      priceCoins: overrides.priceCoins ?? 75,
      powerupType: overrides.powerupType || "RAINSTORM",
      active: overrides.active ?? true,
      testOnly: overrides.testOnly ?? false,
      sortOrder: overrides.sortOrder ?? 0,
    },
  });
}

describe("admin powerup shop items (§5.1)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({
      where: { sku: { startsWith: "POWERUP_TEST_" } },
    });
  });

  it("non-admin gets 403 on GET and PATCH", async () => {
    const user = await createUser();
    const item = await seedItem();

    const listRes = await request(
      server.baseUrl,
      "GET",
      "/admin/powerup-shop/items",
      { token: user.token }
    );
    assert.equal(listRes.status, 403);

    const patchRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: user.token, body: { priceCoins: 10 } }
    );
    assert.equal(patchRes.status, 403);
  });

  it("GET lists items with the §5.1 shape", async () => {
    const admin = await createAdmin();
    const item = await seedItem({ priceCoins: 123, sortOrder: 9 });

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/powerup-shop/items",
      { token: admin.token }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    const found = body.items.find((i) => i.id === item.id);
    assert.ok(found, "seeded item should be listed");
    for (const key of [
      "id",
      "sku",
      "name",
      "powerupType",
      "priceCoins",
      "active",
      "testOnly",
      "sortOrder",
    ]) {
      assert.ok(key in found, `missing key ${key}`);
    }
    assert.equal(found.priceCoins, 123);
    assert.equal(found.sortOrder, 9);
  });

  // Test #8
  it("PATCH changes the price and GET reflects it", async () => {
    const admin = await createAdmin();
    const item = await seedItem({ priceCoins: 75 });

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: admin.token, body: { priceCoins: 250 } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.item.priceCoins, 250);

    const listRes = await request(
      server.baseUrl,
      "GET",
      "/admin/powerup-shop/items",
      { token: admin.token }
    );
    const list = await listRes.json();
    assert.equal(list.items.find((i) => i.id === item.id).priceCoins, 250);
  });

  it("PATCH toggles active / testOnly / sortOrder", async () => {
    const admin = await createAdmin();
    const item = await seedItem({ active: true, testOnly: false, sortOrder: 1 });

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      {
        token: admin.token,
        body: { active: false, testOnly: true, sortOrder: 4 },
      }
    );
    assert.equal(res.status, 200);
    const { item: updated } = await res.json();
    assert.equal(updated.active, false);
    assert.equal(updated.testOnly, true);
    assert.equal(updated.sortOrder, 4);
  });

  it("PATCH rejects an empty body and bad types with 400", async () => {
    const admin = await createAdmin();
    const item = await seedItem();

    const empty = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: admin.token, body: {} }
    );
    assert.equal(empty.status, 400);

    for (const body of [
      { priceCoins: -1 },
      { priceCoins: 1.5 },
      { priceCoins: "free" },
      { active: "yes" },
      { testOnly: 1 },
    ]) {
      const res = await request(
        server.baseUrl,
        "PATCH",
        `/admin/powerup-shop/items/${item.id}`,
        { token: admin.token, body }
      );
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  it("PATCH on an unknown itemId is 404", async () => {
    const admin = await createAdmin();
    const res = await request(
      server.baseUrl,
      "PATCH",
      "/admin/powerup-shop/items/00000000-0000-0000-0000-000000000000",
      { token: admin.token, body: { priceCoins: 5 } }
    );
    assert.equal(res.status, 404);
  });

  // Test #9 — THE regression test for the Leech price drift (audit §2.1).
  it("an admin-set price survives a re-run of prisma/seed.js", async () => {
    const admin = await createAdmin();

    // Use a real seeded sku so the seed script actually upserts over it.
    const sku = "POWERUP_RAINSTORM";
    await prisma.powerupShopItem.upsert({
      where: { sku },
      update: {},
      create: {
        sku,
        name: "Rainstorm",
        description: "seeded",
        priceCoins: 75,
        powerupType: "RAINSTORM",
        active: true,
        sortOrder: 5,
      },
    });
    const before = await prisma.powerupShopItem.findUnique({ where: { sku } });

    const patchRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${before.id}`,
      { token: admin.token, body: { priceCoins: 999, active: false } }
    );
    assert.equal(patchRes.status, 200);

    await execFileAsync(
      process.execPath,
      [path.join(__dirname, "..", "..", "prisma", "seed.js")],
      {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      }
    );

    const after = await prisma.powerupShopItem.findUnique({ where: { sku } });
    assert.equal(
      after.priceCoins,
      999,
      "seed.js must NOT clobber an admin-set priceCoins"
    );
    assert.equal(
      after.active,
      false,
      "seed.js must NOT clobber an admin-set active flag"
    );
  });
});
