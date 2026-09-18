// featureFlags.stepSampleBucketMinutes (spec §3.2 / §7 item 5).
//
// Permanently five minutes and no longer admin-settable. /auth/me retains the
// pre-1.7.1 compatibility gate for the buggy fine-grained reader.
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

  it("serves the permanent five-minute value by default", async () => {
    const u = await createUser();
    const user = await me(u.token);
    assert.ok(user.featureFlags, "featureFlags present");
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("rejects the retired admin setting and keeps the permanent value", async () => {
    const admin = await createAdmin();
    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { stepSampleBucketMinutes: 5 },
    });
    assert.equal(patch.status, 400);

    const user = await me(admin.token);
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("rejects a former out-of-set value and keeps the permanent value", async () => {
    const admin = await createAdmin();
    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { stepSampleBucketMinutes: 20 },
    });
    assert.equal(patch.status, 400);

    const user = await me(admin.token);
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("ignores an invalid stale row and serves the permanent value", async () => {
    const u = await createUser();
    // Simulate a corrupt / future-version stored value that bypassed validation.
    await prisma.appSetting.upsert({
      where: { key: "stepSampleBucketMinutes" },
      update: { value: 7 },
      create: { key: "stepSampleBucketMinutes", value: 7 },
    });
    appSettings.bustCache(); // force read-through of the just-written value
    const user = await me(u.token);
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("rejects every formerly allowed runtime value", async () => {
    const admin = await createAdmin();
    for (const v of [5, 10, 15, 30, 60]) {
      const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
        token: admin.token,
        body: { stepSampleBucketMinutes: v },
      });
      assert.equal(patch.status, 400, `PATCH ${v} rejected`);
      const user = await me(admin.token);
      assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
    }
  });
});

// 2026-07-23 incident #2: builds 1.6.9–1.7.0 carry the fine-grained reader but
// INFLATE fine buckets (boundary-straddling raw chunks counted per bucket).
// The flag is therefore version-gated: omitted for X-App-Version < 1.7.1 (the
// first build with the normalization fix). Fail-OPEN on absent/garbled version
// — builds that old predate the fine reader and ignore the flag anyway (and
// the no-header case is pinned by the existing "is served" test above).
describe("stepSampleBucketMinutes version gate", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany();
    appSettings.bustCache();
    nextAppleId = 0;
  });

  async function meWithVersion(token, version) {
    const res = await request(server.baseUrl, "GET", "/auth/me", {
      token,
      headers: version === undefined ? {} : { "X-App-Version": version },
    });
    return (await res.json()).user;
  }

  async function seedRetiredSetting() {
    const admin = await createAdmin();
    await prisma.appSetting.upsert({
      where: { key: "stepSampleBucketMinutes" },
      update: { value: 60 },
      create: { key: "stepSampleBucketMinutes", value: 60 },
    });
    appSettings.bustCache();
    return admin;
  }

  it("omits the flag for a pre-fix build (1.7.0, the buggy reader)", async () => {
    const admin = await seedRetiredSetting();
    const user = await meWithVersion(admin.token, "1.7.0");
    assert.equal(
      Object.prototype.hasOwnProperty.call(user.featureFlags, "stepSampleBucketMinutes"),
      false
    );
  });

  it("serves the flag at exactly the fixed version (1.7.1, inclusive floor)", async () => {
    const admin = await seedRetiredSetting();
    const user = await meWithVersion(admin.token, "1.7.1");
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("serves the flag above the fixed version (build metadata tolerated)", async () => {
    const admin = await seedRetiredSetting();
    const user = await meWithVersion(admin.token, "1.8.0+42");
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });

  it("fails open on a garbled version header", async () => {
    const admin = await seedRetiredSetting();
    const user = await meWithVersion(admin.token, "unknown");
    assert.equal(user.featureFlags.stepSampleBucketMinutes, 5);
  });
});
