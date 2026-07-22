// featureFlags.stepSampleBucketMinutes (spec §3.2 / §7 item 5).
//
// Absent by default; settable via the admin settings surface; served on
// /auth/me; an invalid stored value is omitted so clients default to 60 (hourly).
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser() {
  const appleId = `apple-bucketflag-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function createAdmin() {
  const u = await createUser();
  await prisma.user.update({ where: { id: u.userId }, data: { email: ADMIN_EMAIL } });
  return u;
}

async function me(token) {
  const res = await request(server.baseUrl, "GET", "/auth/me", { token });
  return (await res.json()).user;
}

describe("featureFlags.stepSampleBucketMinutes", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany();
    // The shared appSettings singleton caches for 30s; bust it so out-of-band
    // deletes/upserts in these tests are read through immediately.
    appSettings.bustCache();
    nextAppleId = 0;
  });

  it("is absent from /auth/me featureFlags by default", async () => {
    const u = await createUser();
    const user = await me(u.token);
    assert.ok(user.featureFlags, "featureFlags present");
    assert.equal(
      Object.prototype.hasOwnProperty.call(user.featureFlags, "stepSampleBucketMinutes"),
      false,
      "flag omitted when unset so clients default to 60"
    );
  });

  it("is served on /auth/me after an admin sets it to an allowed value", async () => {
    const admin = await createAdmin();
    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { stepSampleBucketMinutes: 5 },
    });
    assert.equal(patch.status, 200);

    const user = await me(admin.token);
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("rejects a value outside the allowed set with a 400", async () => {
    const admin = await createAdmin();
    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { stepSampleBucketMinutes: 20 },
    });
    assert.equal(patch.status, 400);

    const user = await me(admin.token);
    assert.equal(
      Object.prototype.hasOwnProperty.call(user.featureFlags, "stepSampleBucketMinutes"),
      false
    );
  });

  it("omits the flag when the stored value is invalid (defensive read)", async () => {
    const u = await createUser();
    // Simulate a corrupt / future-version stored value that bypassed validation.
    await prisma.appSetting.upsert({
      where: { key: "stepSampleBucketMinutes" },
      update: { value: 7 },
      create: { key: "stepSampleBucketMinutes", value: 7 },
    });
    appSettings.bustCache(); // force read-through of the just-written value
    const user = await me(u.token);
    assert.equal(
      Object.prototype.hasOwnProperty.call(user.featureFlags, "stepSampleBucketMinutes"),
      false,
      "invalid stored value omitted -> client defaults to 60"
    );
  });

  it("all allowed values round-trip", async () => {
    const admin = await createAdmin();
    for (const v of [5, 10, 15, 30, 60]) {
      const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
        token: admin.token,
        body: { stepSampleBucketMinutes: v },
      });
      assert.equal(patch.status, 200, `PATCH ${v} accepted`);
      const user = await me(admin.token);
      assert.equal(user.featureFlags.stepSampleBucketMinutes, v);
    }
  });
});
