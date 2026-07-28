const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser({ admin = false } = {}) {
  const appleId = `apple-shop-create-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (admin) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { email: ADMIN_EMAIL },
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

const FULL_BODY = {
  sku: "wizard_hat",
  name: "Wizard Hat",
  description: "A pointy hat crackling with step magic.",
  slot: "HEAD",
  priceCoins: 750,
  assetKey: "wizard_hat",
  bobble: true,
  sortOrder: 120,
  renderMetadata: {
    offsetX: -0.05,
    offsetY: -0.1,
    rotation: 0.1,
    scale: 1.2,
    renderLayer: "front",
  },
};

describe("POST /admin/shop/items (create cosmetic)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates the item end-to-end and reports peer-mirror status", async () => {
    const admin = await createUser({ admin: true });

    const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: FULL_BODY,
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.equal(body.item.sku, "wizard_hat");
    assert.equal(body.item.name, "Wizard Hat");
    assert.equal(body.item.priceCoins, 750);
    assert.equal(body.item.active, true);
    // No PEER_DATABASE_URL in the test env → mirror is a clean no-op.
    assert.deepEqual(body.mirror, {
      attempted: false,
      ok: false,
      reason: "no_peer_configured",
    });

    const row = await prisma.shopItem.findUnique({ where: { sku: "wizard_hat" } });
    assert.ok(row);
    assert.equal(row.slot, "HEAD");
    assert.equal(row.bobble, true);
    assert.equal(row.sortOrder, 120);
    assert.equal(row.renderMetadata.scale, 1.2);
    assert.equal(row.renderMetadata.renderLayer, "front");
  });

  it("defaults a minimal create to testOnly:true, active:true, earnOnly:false", async () => {
    const admin = await createUser({ admin: true });

    const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: {
        sku: "plain_cap",
        name: "Plain Cap",
        slot: "HEAD",
        priceCoins: 100,
        assetKey: "plain_cap",
      },
    });
    assert.equal(res.status, 201);

    const row = await prisma.shopItem.findUnique({ where: { sku: "plain_cap" } });
    assert.equal(row.active, true);
    // Safe default: a brand-new item's PNG isn't in frozen binaries yet.
    assert.equal(row.testOnly, true);
    assert.equal(row.earnOnly, false);
    assert.equal(row.bobble, false);
    assert.equal(row.sortOrder, 0);
    assert.equal(row.description, null);
    assert.equal(row.renderMetadata, null);
  });

  it("honors explicit flag values", async () => {
    const admin = await createUser({ admin: true });

    const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: {
        sku: "legend_crown",
        name: "Legend Crown",
        slot: "HEAD",
        priceCoins: 0,
        assetKey: "legend_crown",
        active: false,
        testOnly: false,
        earnOnly: true,
      },
    });
    assert.equal(res.status, 201);

    const row = await prisma.shopItem.findUnique({ where: { sku: "legend_crown" } });
    assert.equal(row.active, false);
    assert.equal(row.testOnly, false);
    assert.equal(row.earnOnly, true);
  });

  it("rejects a duplicate sku with 409 and leaves the existing row intact", async () => {
    const admin = await createUser({ admin: true });

    const first = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: FULL_BODY,
    });
    assert.equal(first.status, 201);

    const dupe = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: { ...FULL_BODY, name: "Impostor Hat", priceCoins: 1 },
    });
    assert.equal(dupe.status, 409);

    const row = await prisma.shopItem.findUnique({ where: { sku: "wizard_hat" } });
    assert.equal(row.name, "Wizard Hat");
    assert.equal(row.priceCoins, 750);
  });

  it("validates required fields, slot, price, and renderMetadata", async () => {
    const admin = await createUser({ admin: true });

    const cases = [
      { ...FULL_BODY, sku: undefined },
      { ...FULL_BODY, sku: "   " },
      { ...FULL_BODY, name: undefined },
      { ...FULL_BODY, assetKey: undefined },
      { ...FULL_BODY, slot: "HAT" },
      { ...FULL_BODY, priceCoins: -5 },
      { ...FULL_BODY, priceCoins: 1.5 },
      { ...FULL_BODY, priceCoins: undefined },
      { ...FULL_BODY, renderMetadata: { scale: "big" } },
      { ...FULL_BODY, renderMetadata: { renderLayer: "middle" } },
      { ...FULL_BODY, bobble: "yes" },
      { ...FULL_BODY, testOnly: "no" },
    ];
    for (const body of cases) {
      const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
        token: admin.token,
        body,
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    assert.equal(await prisma.shopItem.count(), 0);
  });

  it("rejects non-admin users", async () => {
    const user = await createUser();
    const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: user.token,
      body: FULL_BODY,
    });
    assert.equal(res.status, 403);
    assert.equal(await prisma.shopItem.count(), 0);
  });
});
