const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createAdmin() {
  const appleId = `apple-tuner-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await prisma.user.update({
    where: { id: body.user.id },
    data: { email: ADMIN_EMAIL },
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function createSkateboard() {
  return prisma.shopItem.create({
    data: {
      sku: "skateboard-test",
      name: "Skateboard",
      slot: "FEET",
      priceCoins: 750,
      assetKey: "skateboard",
      active: true,
      testOnly: true,
      renderMetadata: {
        offsetX: 0,
        offsetY: 0.05,
        rotation: 0,
        scale: 1.3,
        perFoot: false,
      },
    },
  });
}

describe("accessory tuner perFoot preservation", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("keeps perFoot:false when the tuner echoes it back in a save", async () => {
    const admin = await createAdmin();
    const item = await createSkateboard();

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      {
        token: admin.token,
        body: {
          renderMetadata: {
            offsetX: 0.1,
            offsetY: 0.02,
            rotation: 0.1,
            scale: 1.4,
            perFoot: false,
          },
        },
      }
    );
    assert.equal(res.status, 200);

    const after = await prisma.shopItem.findUnique({ where: { id: item.id } });
    assert.equal(after.renderMetadata.perFoot, false);
    assert.equal(after.renderMetadata.scale, 1.4);
  });

  it("keeps perFoot:false when a save omits it (older tuner client)", async () => {
    const admin = await createAdmin();
    const item = await createSkateboard();

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      {
        token: admin.token,
        body: {
          renderMetadata: { offsetX: 0.1, offsetY: 0.02, rotation: 0, scale: 1.4 },
        },
      }
    );
    assert.equal(res.status, 200);

    const after = await prisma.shopItem.findUnique({ where: { id: item.id } });
    assert.equal(after.renderMetadata.perFoot, false);
  });

  it("rejects a non-boolean perFoot with 400", async () => {
    const admin = await createAdmin();
    const item = await createSkateboard();

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      {
        token: admin.token,
        body: { renderMetadata: { scale: 1.4, perFoot: "nope" } },
      }
    );
    assert.equal(res.status, 400);
  });
});
