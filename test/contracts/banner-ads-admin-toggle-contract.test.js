const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

describe("banner ads admin toggle contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({
      where: { key: "bannerAdsEnabled" },
    });
    appSettings.bustCache();
  });

  it("serves true when the setting row is missing", async () => {
    const { token } = await createTestUser({ email: ADMIN_EMAIL });

    const me = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.featureFlags.bannerAdsEnabled, true);

    const settings = await request(server.baseUrl, "GET", "/admin/settings", {
      token,
    });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).settings.bannerAdsEnabled, true);
  });

  it("accepts false through PATCH and returns the persisted settings envelope", async () => {
    const { token } = await createTestUser({ email: ADMIN_EMAIL });

    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token,
      body: { bannerAdsEnabled: false },
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).settings.bannerAdsEnabled, false);

    const me = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.featureFlags.bannerAdsEnabled, false);

    const settings = await request(server.baseUrl, "GET", "/admin/settings", {
      token,
    });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).settings.bannerAdsEnabled, false);
  });

  it("keeps non-boolean banner values on the existing 400 validation path", async () => {
    const { token } = await createTestUser({ email: ADMIN_EMAIL });

    const response = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token,
      body: { bannerAdsEnabled: "false" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "bannerAdsEnabled must be a boolean",
    });
  });
});
