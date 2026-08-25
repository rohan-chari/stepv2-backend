const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const TIME_ZONE = "America/New_York";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function etDate(instant = new Date()) {
  return dateFormatter.format(instant);
}

function todayAtUtc(hour, minute = 0) {
  const now = new Date();
  const date = etDate(now);
  // Start from midday UTC so converting to the requested ET hour never crosses
  // into the previous UTC date before the offset correction is applied.
  const candidate = new Date(`${date}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).formatToParts(candidate);
  const localHour = Number(parts.find((part) => part.type === "hour").value);
  const localMinute = Number(parts.find((part) => part.type === "minute").value);
  return new Date(candidate.getTime() + ((hour - localHour) * 60 + minute - localMinute) * 60 * 1000);
}

async function enableDashboard() {
  await appSettings.setFlag("adminMetricsV2DashboardEnabled", true);
  await appSettings.setFlag("adminMetricsV2TelemetryEnabled", false);
}

async function getDauDashboard(server, token, window = "7d") {
  const response = await request(
    server.baseUrl,
    "GET",
    `/admin/stats?sections=dashboard-dau-engagement&window=${window}`,
    { token }
  );
  assert.equal(response.status, 200);
  return (await response.json()).stats.metricsDashboard;
}

describe("admin DAU and engagement dashboard", () => {
  let server;
  let admin;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.metricCoverageStart.deleteMany();
    await prisma.adminMetricsCollectionEpoch.deleteMany();
    await enableDashboard();
    admin = await createTestUser({
      email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com",
    });
  });

  it("returns the locked additive section contract and preserves the legacy payload", async () => {
    const dashboard = await getDauDashboard(server, admin.token);

    assert.equal(dashboard.schemaVersion, 2);
    assert.equal(dashboard.status, "available");
    assert.deepEqual(Object.keys(dashboard.dauEngagement), [
      "asOf",
      "timeZone",
      "actionBasedDau",
      "today",
      "comparisons",
      "daily",
    ]);
    assert.equal(dashboard.dauEngagement.timeZone, TIME_ZONE);
    assert.equal(dashboard.dauEngagement.actionBasedDau.status, "available");
    assert.deepEqual(Object.keys(dashboard.dauEngagement.today.actions), [
      "raceParticipation",
      "boxOpen",
      "powerupUse",
      "dailyRewardClaim",
      "notificationOpen",
      "rewardedAd",
      "leaderboardView",
      "raceCreated",
      "raceCompleted",
    ]);
    for (const action of Object.values(dashboard.dauEngagement.today.actions)) {
      assert.deepEqual(Object.keys(action), ["users", "events"]);
      assert.equal(action.users, 0);
      assert.equal(action.events, 0);
    }
    assert.equal(dashboard.dauEngagement.today.averageActionReach, 0);
    assert.equal(dashboard.dauEngagement.today.usersWithAnyAction, 0);
    assert.equal(dashboard.dauEngagement.daily.length, 7);

    const legacy = await request(server.baseUrl, "GET", "/admin/stats", {
      token: admin.token,
    });
    assert.equal(legacy.status, 200);
    const legacyStats = (await legacy.json()).stats;
    assert.equal("metricsDashboard" in legacyStats, false);
  });

  it("counts each distinct user once, excludes review accounts, and preserves raw event counts", async () => {
    const user = await createTestUser({ email: "engaged@test.com" });
    const review = await createTestUser({
      email: "review@test.com",
      isReviewAccount: true,
    });
    const today = etDate();
    const eventAt = todayAtUtc(12, 0);
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "Eligible race",
        targetSteps: 1000,
        status: "COMPLETED",
        createdAt: eventAt,
        startedAt: eventAt,
        completedAt: eventAt,
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.user.id,
        status: "ACCEPTED",
        joinedAt: eventAt,
        finishedAt: eventAt,
      },
    });
    await prisma.racePowerupEvent.createMany({
      data: [
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "box 1",
          createdAt: eventAt,
        },
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "box 2",
          createdAt: eventAt,
        },
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "POWERUP_USED",
          description: "powerup 1",
          createdAt: eventAt,
        },
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "POWERUP_USED",
          description: "powerup 2",
          createdAt: eventAt,
        },
        {
          raceId: race.id,
          actorUserId: review.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "review box",
          createdAt: eventAt,
        },
      ],
    });
    await prisma.dailyRewardClaim.create({
      data: {
        userId: user.user.id,
        claimedDate: today,
        cycleDay: 1,
        rewardType: "COINS",
        createdAt: eventAt,
      },
    });
    await prisma.pushDelivery.create({
      data: {
        publicId: randomUUID(),
        deliveryKey: randomUUID(),
        userId: user.user.id,
        notificationType: "test",
        openCapable: true,
        providerAcceptedAt: eventAt,
        openedAt: eventAt,
        createdAt: eventAt,
      },
    });
    await prisma.adRewardGrant.create({
      data: {
        userId: user.user.id,
        transactionId: randomUUID(),
        grantedDate: today,
        rewardKind: "extra_daily_spin",
        createdAt: eventAt,
      },
    });
    await prisma.activationEvent.create({
      data: {
        id: randomUUID(),
        userId: user.user.id,
        name: "race_leaderboard_viewed",
        context: { race_id: race.id },
        appVersion: "2.5.0",
        platform: "ios",
        occurredAt: eventAt,
        createdAt: eventAt,
      },
    });
    await prisma.activationEvent.create({
      data: {
        id: randomUUID(),
        userId: review.user.id,
        name: "race_leaderboard_viewed",
        context: { race_id: race.id },
        appVersion: "2.5.0",
        platform: "ios",
        occurredAt: eventAt,
        createdAt: eventAt,
      },
    });

    const dashboard = await getDauDashboard(server, admin.token);
    const { today: todayBlock } = dashboard.dauEngagement;
    assert.equal(dashboard.dauEngagement.actionBasedDau.users, 1);
    assert.deepEqual(todayBlock.actions, {
      raceParticipation: { users: 1, events: 1 },
      boxOpen: { users: 1, events: 2 },
      powerupUse: { users: 1, events: 2 },
      dailyRewardClaim: { users: 1, events: 1 },
      notificationOpen: { users: 1, events: 1 },
      rewardedAd: { users: 1, events: 1 },
      leaderboardView: { users: 1, events: 1 },
      raceCreated: { users: 1, events: 1 },
      raceCompleted: { users: 1, events: 1 },
    });
    assert.equal(todayBlock.averageActionReach, 1);
    assert.equal(todayBlock.usersWithAnyAction, 1);
  });

  it("uses the full bounded history for week comparisons while keeping the public daily series short", async () => {
    const user = await createTestUser({ email: "comparison@test.com" });
    const today = todayAtUtc(12, 0);
    const priorWeek = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000);
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "Comparison race",
        targetSteps: 1000,
        status: "COMPLETED",
        createdAt: priorWeek,
        startedAt: priorWeek,
        completedAt: priorWeek,
      },
    });
    await prisma.racePowerupEvent.createMany({
      data: [
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "prior week box",
          createdAt: priorWeek,
        },
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "today box",
          createdAt: today,
        },
      ],
    });

    const dashboard = await getDauDashboard(server, admin.token, "7d");
    const comparison = dashboard.dauEngagement.comparisons.weekOverWeek;
    assert.equal(comparison.status, "available");
    assert.notEqual(comparison.current, null);
    assert.notEqual(comparison.prior, null);
    assert.equal(comparison.actions.boxOpen.status, "available");
    assert.equal(dashboard.dauEngagement.daily.length, 7);
  });

  it("uses ET-day half-open boundaries and does not gate today's box opener on historical coverage", async () => {
    const user = await createTestUser({ email: "midnight@test.com" });
    const today = etDate();
    const justAfterMidnight = todayAtUtc(0, 30);
    const justBeforeMidnight = new Date(justAfterMidnight.getTime() - 60 * 60 * 1000);
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "Boundary race",
        targetSteps: 1000,
        status: "ACTIVE",
      },
    });
    await prisma.racePowerupEvent.createMany({
      data: [
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "previous ET day",
          createdAt: justBeforeMidnight,
        },
        {
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "MYSTERY_BOX_OPENED",
          description: "current ET day",
          createdAt: justAfterMidnight,
        },
      ],
    });
    await prisma.metricCoverageStart.create({
      data: {
        metric: "boxOpen",
        operationalAt: new Date(),
      },
    });

    const dashboard = await getDauDashboard(server, admin.token);
    assert.equal(dashboard.dauEngagement.today.date, today);
    assert.deepEqual(dashboard.dauEngagement.today.actions.boxOpen, {
      users: 1,
      events: 1,
    });

    const summaryResponse = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-summary",
      { token: admin.token }
    );
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()).stats.metricsDashboard;
    assert.equal(summary.summary.growth.engagedBoxOpenersToday, 1);
  });

  it("returns gathering_data with explicit null comparison values when rollup history is incomplete", async () => {
    const dashboard = await getDauDashboard(server, admin.token, "30d");
    for (const [period, comparison] of Object.entries(dashboard.dauEngagement.comparisons)) {
      assert.equal(comparison.status, "gathering_data");
      assert.equal(comparison.current, null);
      assert.equal(comparison.prior, null);
      assert.equal(comparison.absoluteChange, null);
      assert.equal(comparison.percentChange, null);
      if (period === "sixMonthsOverSixMonths" || period === "yearOverYear") {
        assert.equal(comparison.currentStart, null);
        assert.equal(comparison.currentEnd, null);
        assert.equal(comparison.priorStart, null);
        assert.equal(comparison.priorEnd, null);
      } else {
        assert.ok(comparison.currentStart);
        assert.ok(comparison.currentEnd);
        assert.ok(comparison.priorStart);
        assert.ok(comparison.priorEnd);
      }
    }
  });

  it("preserves existing authorization status codes", async () => {
    const missing = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-dau-engagement"
    );
    assert.equal(missing.status, 401);

    const nonAdmin = await createTestUser({ email: "not-admin@test.com" });
    const forbidden = await request(
      server.baseUrl,
      "GET",
      "/admin/stats?sections=dashboard-dau-engagement",
      { token: nonAdmin.token }
    );
    assert.equal(forbidden.status, 403);
  });
});
