const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");

const DASHBOARD_SECTIONS = [
  "dashboard-summary",
  "dashboard-growth",
  "dashboard-funnels",
  "dashboard-activation",
  "dashboard-retention",
  "dashboard-engagement",
  "dashboard-virality",
  "dashboard-revenue",
  "dashboard-release-adoption",
];

const SOURCE_ENVELOPE = {
  productDb: { status: "available" },
  foregroundActivity: { status: "disabled", asOf: null },
  appStoreConnect: { status: "not_configured", asOf: null },
  admob: { status: "not_configured", asOf: null },
};

describe("admin metrics dashboard v2 — locked HTTP contract", () => {
  let server;
  let admin;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: [
            "adminMetricsV2DashboardEnabled",
            "adminMetricsV2TelemetryEnabled",
          ],
        },
      },
    });
    admin = await createTestUser({
      email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com",
    });
  });

  it("keeps the no-sections legacy payload and omits metricsDashboard", async () => {
    const response = await request(server.baseUrl, "GET", "/admin/stats", {
      token: admin.token,
    });
    assert.equal(response.status, 200);
    const { stats } = await response.json();
    assert.equal("metricsDashboard" in stats, false);
    assert.deepEqual(Object.keys(stats), [
      "generatedAt",
      "users",
      "activity",
      "friends",
      "retention",
      "teamRaces",
      "referralFunnel",
      "activationFunnel",
      "versions",
      "versionsSince",
      "versionsWindowDays",
      "races",
      "onboardingFunnel",
    ]);
  });

  it("keeps recognized legacy optional sections in legacy mode", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=economy,unknown&window=future",
      { token: admin.token }
    );
    assert.equal(response.status, 200);
    const { stats } = await response.json();
    assert.ok(stats.coinEconomy);
    assert.equal("metricsDashboard" in stats, false);
  });

  it("keeps an unknown-only request on the legacy soft-degradation path", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=future-section&window=future-window",
      { token: admin.token }
    );
    assert.equal(response.status, 200);
    const { stats } = await response.json();
    assert.equal("metricsDashboard" in stats, false);
    assert.ok(stats.users);
  });

  it("rejects mixed recognized legacy and dashboard sections exactly", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=economy,dashboard-summary",
      { token: admin.token }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Legacy and dashboard sections cannot be mixed",
      code: "MIXED_STATS_SECTIONS",
    });
  });

  it("rejects multiple recognized dashboard sections exactly", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-summary,dashboard-growth",
      { token: admin.token }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Request one dashboard section at a time",
      code: "MULTIPLE_DASHBOARD_SECTIONS",
    });
  });

  it("validates window only in dashboard mode", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-summary&window=14d",
      { token: admin.token }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Window must be 7d, 30d, or 90d",
      code: "INVALID_WINDOW",
    });
  });

  for (const section of DASHBOARD_SECTIONS) {
    it(`${section} returns the exact default-off dashboard envelope`, async () => {
      const response = await request(
        server.baseUrl,
        "GET",
        `/admin/stats?sections=${section}`,
        { token: admin.token }
      );
      assert.equal(response.status, 200);
      const { stats } = await response.json();
      assert.deepEqual(Object.keys(stats), ["generatedAt", "metricsDashboard"]);
      assert.equal(typeof stats.generatedAt, "string");
      assert.deepEqual(Object.keys(stats.metricsDashboard), [
        "schemaVersion",
        "status",
        "window",
        "sources",
      ]);
      assert.equal(stats.metricsDashboard.schemaVersion, 2);
      assert.equal(stats.metricsDashboard.status, "disabled");
      assert.equal(stats.metricsDashboard.window.days, 30);
      assert.equal(stats.metricsDashboard.window.timeZone, "America/New_York");
      assert.equal(typeof stats.metricsDashboard.window.start, "string");
      assert.equal(typeof stats.metricsDashboard.window.end, "string");
      assert.deepEqual(
        {
          ...stats.metricsDashboard.sources,
          productDb: {
            status: stats.metricsDashboard.sources.productDb.status,
          },
        },
        SOURCE_ENVELOPE
      );
      assert.equal(
        stats.metricsDashboard.sources.productDb.asOf,
        stats.generatedAt
      );
    });
  }

  it("accepts 7d and 90d and ignores unknown names beside one dashboard section", async () => {
    for (const [window, days] of [["7d", 7], ["90d", 90]]) {
      const response = await request(
        server.baseUrl,
        "GET",
        `/admin/stats?sections=unknown,dashboard-summary&window=${window}`,
        { token: admin.token }
      );
      assert.equal(response.status, 200);
      const { stats } = await response.json();
      assert.equal(stats.metricsDashboard.window.days, days);
    }
  });

  it("preserves admin authorization status codes", async () => {
    const missing = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-summary"
    );
    assert.equal(missing.status, 401);

    const nonAdmin = await createTestUser({ email: "not-admin@test.com" });
    const forbidden = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-summary",
      { token: nonAdmin.token }
    );
    assert.equal(forbidden.status, 403);
  });
});
