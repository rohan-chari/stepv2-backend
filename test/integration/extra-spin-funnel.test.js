const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

let server;
let nextId = 0;

function event(overrides = {}) {
  return {
    id: `extra-spin-${++nextId}-${Date.now()}`,
    name: "extra_spin_offer_shown",
    context: { surface: "home" },
    appVersion: "2.3.3",
    platform: "ios",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function postEvents(token, events) {
  return request(server.baseUrl, "POST", "/analytics/activation-events", {
    token,
    body: { events },
  });
}

async function createAdmin() {
  return createTestUser({
    appleId: `admin-extra-spin-${Date.now()}-${Math.random()}`,
    email: ADMIN_EMAIL,
  });
}

describe("extra-spin activation telemetry", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextId = 0;
  });

  it("accepts and persists every bounded extra-spin stage with platform and app version", async () => {
    const { user, token } = await createTestUser();
    const events = [
      event({ name: "extra_spin_offer_shown" }),
      event({ name: "extra_spin_cta_tapped" }),
      event({ name: "extra_spin_ad_ready" }),
      event({
        name: "extra_spin_ad_not_ready",
        context: { result: "load_failed" },
      }),
      event({
        name: "extra_spin_ad_not_ready",
        context: { result: "unsupported" },
      }),
      event({
        name: "extra_spin_ad_not_ready",
        context: { result: "dismissed" },
      }),
      event({ name: "extra_spin_ad_completed", context: {} }),
      event({ name: "extra_spin_claim_succeeded", context: {} }),
    ];

    const res = await postEvents(token, events);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 8, inserted: 8 });

    const stored = await prisma.activationEvent.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    });
    assert.equal(stored.length, 8);
    assert.deepEqual(
      stored.map((row) => row.name).sort(),
      [
        "extra_spin_ad_completed",
        "extra_spin_ad_not_ready",
        "extra_spin_ad_not_ready",
        "extra_spin_ad_not_ready",
        "extra_spin_ad_ready",
        "extra_spin_claim_succeeded",
        "extra_spin_cta_tapped",
        "extra_spin_offer_shown",
      ]
    );
    for (const row of stored) {
      assert.equal(row.platform, "ios");
      assert.equal(row.appVersion, "2.3.3");
    }
    assert.deepEqual(
      stored
        .filter((row) => row.name === "extra_spin_ad_not_ready")
        .map((row) => row.context.result)
        .sort(),
      ["dismissed", "load_failed", "unsupported"]
    );
  });

  it("rejects unapproved or malformed extra-spin context without persisting a batch", async () => {
    const { user, token } = await createTestUser();
    const res = await postEvents(token, [
      event({
        name: "extra_spin_ad_not_ready",
        context: { result: "network_timeout", adUnit: "private-ad-id" },
      }),
    ]);

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /context\.result is not allowed/);
    assert.equal(await prisma.activationEvent.count({ where: { userId: user.id } }), 0);
  });
});

describe("extra-spin admin funnel statistics", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextId = 0;
  });

  it("is opt-in and reports ET-windowed client stages beside authoritative SSV grants by platform and version", async () => {
    const admin = await createAdmin();
    const ios = await createTestUser({
      appleId: `ios-extra-spin-${Date.now()}-${Math.random()}`,
      lastAppVersion: "2.3.3",
    });
    const android = await prisma.user.create({
      data: {
        googleSub: `android-extra-spin-${Date.now()}-${Math.random()}`,
        email: `android-extra-spin-${Date.now()}@example.com`,
        lastAppVersion: "2.3.4",
      },
    });

    const iosEvents = [
      event({ name: "extra_spin_offer_shown" }),
      event({ name: "extra_spin_cta_tapped" }),
      event({ name: "extra_spin_cta_tapped" }), // raw events retry; stage is distinct users.
      event({ name: "extra_spin_ad_ready" }),
      event({ name: "extra_spin_ad_not_ready", context: { result: "dismissed" } }),
      event({ name: "extra_spin_ad_completed", context: {} }),
      event({ name: "extra_spin_claim_succeeded", context: {} }),
    ];
    assert.equal((await postEvents(ios.token, iosEvents)).status, 202);

    const androidEvents = [
      event({
        name: "extra_spin_offer_shown",
        appVersion: "2.3.4",
        platform: "android",
      }),
      event({
        name: "extra_spin_cta_tapped",
        appVersion: "2.3.4",
        platform: "android",
      }),
    ];
    await prisma.activationEvent.createMany({
      data: androidEvents.map((item) => ({
        id: item.id,
        userId: android.id,
        name: item.name,
        context: item.context,
        appVersion: item.appVersion,
        platform: item.platform,
        occurredAt: new Date(item.timestamp),
      })),
    });
    const expired = event({
      name: "extra_spin_claim_succeeded",
      appVersion: "2.3.4",
      platform: "android",
      context: {},
    });
    await prisma.activationEvent.create({
      data: {
        id: expired.id,
        userId: android.id,
        name: expired.name,
        context: expired.context,
        appVersion: expired.appVersion,
        platform: expired.platform,
        occurredAt: new Date(expired.timestamp),
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.adRewardGrant.createMany({
      data: [
        {
          userId: ios.user.id,
          transactionId: `extra-spin-watch-${Date.now()}-1`,
          rewardKind: "extra_daily_spin",
          grantedDate: "2026-08-13",
          consumedAt: new Date(),
        },
        {
          userId: ios.user.id,
          transactionId: `extra-spin-watch-${Date.now()}-2`,
          rewardKind: "extra_daily_spin",
          grantedDate: "2026-08-13",
        },
        {
          userId: ios.user.id,
          transactionId: `extra-spin-expired-${Date.now()}`,
          rewardKind: "extra_daily_spin",
          grantedDate: "2026-07-13",
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        },
      ],
    });

    const withoutSection = await request(server.baseUrl, "GET", "/admin/stats", {
      token: admin.token,
    });
    assert.equal(withoutSection.status, 200);
    assert.equal("extraSpinFunnel" in (await withoutSection.json()).stats, false);

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=extra-spin-funnel",
      { token: admin.token }
    );
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    assert.deepEqual(stats.extraSpinFunnel.sources, {
      clientTelemetry: {
        label: "Client telemetry",
        reliability: "best_effort_may_be_lost_offline",
      },
      serverVerified: {
        label: "Server-verified AdMob SSV",
        reliability: "authoritative",
      },
    });
    assert.equal(stats.extraSpinFunnel.windowDays, 30);
    assert.equal(stats.extraSpinFunnel.timeZone, "America/New_York");

    const byGroup = Object.fromEntries(
      stats.extraSpinFunnel.byPlatformAndAppVersion.map((row) => [
        `${row.platform}|${row.appVersion}`,
        row,
      ])
    );
    assert.deepEqual(byGroup["ios|2.3.3"], {
      platform: "ios",
      appVersion: "2.3.3",
      clientTelemetry: {
        offerShownUsers: 1,
        ctaTappedUsers: 1,
        adReadyUsers: 1,
        adNotReadyUsers: 1,
        adCompletedUsers: 1,
        claimSucceededUsers: 1,
      },
      serverVerified: {
        watchGrants: 2,
        uniqueWatchers: 1,
        redeemedSpinGrants: 1,
        uniqueRedeemers: 1,
      },
    });
    assert.deepEqual(byGroup["android|2.3.4"], {
      platform: "android",
      appVersion: "2.3.4",
      clientTelemetry: {
        offerShownUsers: 1,
        ctaTappedUsers: 1,
        adReadyUsers: 0,
        adNotReadyUsers: 0,
        adCompletedUsers: 0,
        claimSucceededUsers: 0,
      },
      serverVerified: {
        watchGrants: 0,
        uniqueWatchers: 0,
        redeemedSpinGrants: 0,
        uniqueRedeemers: 0,
      },
    });
  });
});
