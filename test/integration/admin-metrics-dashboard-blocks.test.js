process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
delete process.env.REDIS_URL;

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const etFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function etDate(instant = new Date()) {
  return etFormatter.format(instant);
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const BLOCK_BY_SECTION = {
  "dashboard-summary": "summary",
  "dashboard-growth": "userGrowth",
  "dashboard-funnels": ["inviteFunnel", "onboardingFunnel"],
  "dashboard-activation": "activation",
  "dashboard-retention": "retention",
  "dashboard-engagement": "raceEngagement",
  "dashboard-virality": "virality",
  "dashboard-revenue": "revenue",
  "dashboard-release-adoption": "releaseAdoption",
};

describe("admin metrics dashboard v2 — Phase A blocks", () => {
  let server;
  let admin;
  let captureQueries = false;
  let capturedQueryCount = 0;

  before(async () => {
    server = await getSharedServer();
    prisma.$on("query", () => {
      if (captureQueries) capturedQueryCount += 1;
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.metricCoverageStart.deleteMany();
    await prisma.adminMetricsCollectionEpoch.deleteMany();
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", false);
    await appSettings.setFlag("adminMetricsV2DashboardEnabled", true);
    admin = await createTestUser({
      email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com",
    });
  });

  async function get(section, window = "7d") {
    const response = await request(
      server.baseUrl,
      "GET",
      `/admin/stats?sections=${section}&window=${window}`,
      { token: admin.token }
    );
    assert.equal(response.status, 200);
    return (await response.json()).stats.metricsDashboard;
  }

  it("each section returns only its allowlisted block(s), coverage, and sources", async () => {
    for (const [section, expected] of Object.entries(BLOCK_BY_SECTION)) {
      const dashboard = await get(section);
      assert.equal(dashboard.status, "available");
      assert.ok(dashboard.coverage);
      assert.ok(dashboard.coverage.metricCoverage);
      const expectedBlocks = Array.isArray(expected) ? expected : [expected];
      for (const key of expectedBlocks) assert.ok(key in dashboard, `${section}: ${key}`);
      const allBlocks = Object.values(BLOCK_BY_SECTION).flat();
      for (const key of allBlocks) {
        assert.equal(
          key in dashboard,
          expectedBlocks.includes(key),
          `${section} block omission for ${key}`
        );
      }
      assert.equal(dashboard.sources.appStoreConnect.status, "not_configured");
      assert.equal(dashboard.sources.admob.status, "not_configured");
    }
  });

  it("serves dashboard blocks from Postgres with Redis unavailable", async () => {
    assert.equal(process.env.REDIS_URL, undefined);
    const dashboard = await get("dashboard-summary", "7d");
    assert.equal(dashboard.status, "available");
    assert.ok(dashboard.summary);
  });

  it("summary counts only retained non-review Apple users and excludes review-created races", async () => {
    const ios = await createTestUser({ appleId: `ios-${Date.now()}` });
    const review = await createTestUser({
      appleId: `review-${Date.now()}`,
      isReviewAccount: true,
    });
    await prisma.user.create({
      data: { googleSub: `google-${Date.now()}`, email: "android@test.com" },
    });
    await prisma.race.createMany({
      data: [
        {
          creatorId: ios.user.id,
          name: "Eligible active",
          targetSteps: 1000,
          status: "ACTIVE",
          startedAt: new Date(),
        },
        {
          creatorId: review.user.id,
          name: "Review active",
          targetSteps: 1000,
          status: "ACTIVE",
          startedAt: new Date(),
        },
      ],
    });
    const dashboard = await get("dashboard-summary");
    assert.equal(dashboard.summary.growth.totalSignups, 2); // admin + ios
    assert.equal(dashboard.summary.races.activeNonFeaturedRaces, 1);
    assert.equal("money" in dashboard.summary, false);
  });

  it("growth zero-fills every ET day and provider leaves stay null", async () => {
    const dashboard = await get("dashboard-growth", "7d");
    assert.equal(dashboard.userGrowth.daily.length, 7);
    for (const row of dashboard.userGrowth.daily) {
      assert.equal(typeof row.date, "string");
      assert.equal(typeof row.signups, "number");
      assert.equal(row.observedForegroundUsers, null);
      assert.equal(row.appleFirstTimeDownloads, null);
      assert.equal(row.appleDeletions, null);
    }
  });

  it("empty ratios use null percent and revenue never fabricates provider values", async () => {
    await prisma.metricCoverageStart.create({
      data: {
        metric: "referralHmacV1",
        operationalAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
    const funnels = await get("dashboard-funnels");
    assert.deepEqual(funnels.inviteFunnel.openToSignup, {
      numerator: 0,
      denominator: 0,
      percent: null,
    });

    const revenue = await get("dashboard-revenue");
    assert.equal(revenue.revenue.daily.length, 7);
    assert.equal(revenue.revenue.daily[0].impressions, null);
    assert.equal(revenue.revenue.daily[0].estimatedEarnings, null);
    assert.equal(revenue.revenue.adRevenuePerDau, null);
    assert.deepEqual(revenue.revenue.realMoneyPurchases, {
      available: false,
      reason: "NO_IAP_PRODUCT",
    });
  });

  it("release adoption is iOS-only, non-review, and grouped by version", async () => {
    await prisma.user.createMany({
      data: [
        { appleId: "ios-version", lastAppVersion: "2.4.0", lastSeenAt: new Date() },
        { googleSub: "android-version", lastAppVersion: "2.4.0", lastSeenAt: new Date() },
        { appleId: "review-version", isReviewAccount: true, lastAppVersion: "2.4.0", lastSeenAt: new Date() },
      ],
    });
    const dashboard = await get("dashboard-release-adoption");
    const version = dashboard.releaseAdoption.versions.find((row) => row.version === "2.4.0");
    assert.deepEqual(version, { version: "2.4.0", accountsSeen: 1 });
  });

  it("returns mature empty retention cohorts as observed zero counts", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    await prisma.adminMetricsCollectionEpoch.updateMany({
      where: { endedAt: null },
      data: { startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const dashboard = await get("dashboard-retention", "7d");
    const matureEmpty = dashboard.retention.cohorts.at(-3);
    assert.deepEqual(matureEmpty.d1, {
      numerator: 0,
      denominator: 0,
      percent: null,
    });
  });

  it("scopes engagement aggregate denominators to the selected ET window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await prisma.race.createMany({
      data: [
        {
          creatorId: admin.user.id,
          name: "Old private race",
          targetSteps: 1000,
          status: "COMPLETED",
          isPublic: false,
          startedAt: old,
          completedAt: old,
          createdAt: old,
        },
        {
          creatorId: admin.user.id,
          name: "Current public race",
          targetSteps: 1000,
          status: "ACTIVE",
          isPublic: true,
          startedAt: new Date(),
          createdAt: new Date(),
        },
      ],
    });

    const dashboard = await get("dashboard-engagement", "7d");
    assert.deepEqual(dashboard.raceEngagement.visibility.public, {
      numerator: 1,
      denominator: 1,
      percent: 100,
    });
    assert.equal(dashboard.raceEngagement.averageRunnersPerStartedRace, 0);
  });

  it("computes capable iOS signup activation ratios from durable facts", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    const epochStart = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    epochStart.setUTCHours(12, 0, 0, 0);
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt: epochStart },
    });
    const signupAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const capable = await createTestUser({
      appleId: `capable-${Date.now()}`,
      createdAt: signupAt,
      metricsV2EligibleAt: signupAt,
      metricsV2EligibleEpochId: epoch.id,
      metricsV2SignupEligible: true,
      metricsV2SignupEpochId: epoch.id,
    });
    await prisma.activationEvent.create({
      data: {
        id: `health-${Date.now()}`,
        userId: capable.user.id,
        name: "health_connected",
        context: { source: "healthkit" },
        appVersion: "2.5.0",
        platform: "ios",
        occurredAt: new Date(signupAt.getTime() + 60 * 60 * 1000),
      },
    });
    await prisma.race.create({
      data: {
        creatorId: capable.user.id,
        name: "First race in 24h",
        targetSteps: 1000,
        status: "PENDING",
        createdAt: new Date(signupAt.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    const dashboard = await get("dashboard-activation", "7d");
    assert.deepEqual(dashboard.activation.healthWithin24h, {
      numerator: 1,
      denominator: 1,
      percent: 100,
    });
    assert.deepEqual(dashboard.activation.raceWithin24h, {
      numerator: 1,
      denominator: 1,
      percent: 100,
    });
    assert.deepEqual(
      dashboard.coverage.metricCoverage.observedForegroundDau,
      {
        status: "mature",
        collectingSince: epochStart.toISOString().slice(0, 10),
        eligible: 1,
        totalPopulation: 2,
        eligibilityPercent: 50,
      }
    );
    assert.equal(
      dashboard.coverage.metricCoverage.observedForegroundMau.eligible,
      0
    );
    assert.deepEqual(dashboard.coverage.metricCoverage.retentionD1, {
      status: "mature",
      collectingSince: epochStart.toISOString().slice(0, 10),
      eligible: 1,
      totalPopulation: 1,
      eligibilityPercent: 100,
    });
  });

  it("reports trailing capable provider-accepted push opens by type", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    await prisma.adminMetricsCollectionEpoch.updateMany({
      where: { endedAt: null },
      data: { startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    await prisma.pushDelivery.createMany({
      data: [
        {
          publicId: "10000000-0000-4000-8000-000000000001",
          deliveryKey: `race-started-open-${Date.now()}`,
          userId: admin.user.id,
          notificationType: "race_started",
          openCapable: true,
          providerAcceptedAt: new Date(),
          openedAt: new Date(),
        },
        {
          publicId: "10000000-0000-4000-8000-000000000002",
          deliveryKey: `race-started-closed-${Date.now()}`,
          userId: admin.user.id,
          notificationType: "race_started",
          openCapable: true,
          providerAcceptedAt: new Date(),
        },
        {
          publicId: "10000000-0000-4000-8000-000000000003",
          deliveryKey: `incapable-${Date.now()}`,
          userId: admin.user.id,
          notificationType: "race_started",
          openCapable: false,
          providerAcceptedAt: new Date(),
          openedAt: new Date(),
        },
      ],
    });

    const dashboard = await get("dashboard-engagement", "7d");
    assert.deepEqual(dashboard.raceEngagement.notificationOpenRate, {
      windowDays: 7,
      numerator: 1,
      denominator: 2,
      percent: 50,
      breakdown: [
        {
          notificationType: "race_started",
          ratio: { numerator: 1, denominator: 2, percent: 50 },
        },
      ],
    });
  });

  it("uses the first eligible post-coverage race for power-use activation", async () => {
    const runner = await createTestUser({ appleId: `runner-${Date.now()}` });
    const operationalAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.metricCoverageStart.create({
      data: { metric: "firstRacePowerUse", operationalAt },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: admin.user.id,
        name: "First power race",
        targetSteps: 1000,
        status: "ACTIVE",
        powerupsEnabled: true,
        startedAt: new Date(),
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: race.id, userId: admin.user.id, status: "ACCEPTED" },
        { raceId: race.id, userId: runner.user.id, status: "ACCEPTED" },
      ],
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: race.id,
        actorUserId: runner.user.id,
        eventType: "POWERUP_USED",
        powerupType: "PROTEIN_SHAKE",
        description: "used a powerup",
      },
    });

    const dashboard = await get("dashboard-activation", "7d");
    assert.deepEqual(dashboard.activation.firstRacePowerUse, {
      numerator: 1,
      denominator: 2,
      percent: 50,
    });
  });

  it("keeps event-backed coverage collecting until the full selected window is covered", async () => {
    await prisma.metricCoverageStart.create({
      data: { metric: "firstRacePowerUse", operationalAt: new Date() },
    });
    const dashboard = await get("dashboard-activation", "7d");
    assert.equal(
      dashboard.coverage.metricCoverage.firstRacePowerUse.status,
      "collecting"
    );
    assert.deepEqual(dashboard.activation.firstRacePowerUse, {
      numerator: null,
      denominator: null,
      percent: null,
    });
  });

  it("keeps today's incomplete exact-day retention target null", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    const today = etDate();
    const signupDate = addDays(today, -1);
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt: new Date(`${addDays(today, -10)}T12:00:00Z`) },
    });
    const user = await createTestUser({
      appleId: `today-target-${Date.now()}`,
      createdAt: new Date(`${signupDate}T12:00:00Z`),
      metricsV2SignupEligible: true,
      metricsV2SignupEpochId: epoch.id,
      metricsV2EligibleAt: new Date(`${signupDate}T12:00:00Z`),
      metricsV2EligibleEpochId: epoch.id,
    });
    await prisma.userActivityDay.create({
      data: {
        userId: user.user.id,
        activityDate: new Date(`${today}T00:00:00Z`),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        appVersion: "2.5.0",
        metadataOccurredAt: new Date(),
      },
    });

    const dashboard = await get("dashboard-retention", "7d");
    const cohort = dashboard.retention.cohorts.find(
      (row) => row.signupDate === signupDate
    );
    assert.ok(cohort);
    assert.deepEqual(cohort.d1, {
      numerator: null,
      denominator: null,
      percent: null,
    });
  });

  it("reports retention coverage for the same latest-30 mature cohorts as summary ratios", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt: new Date(Date.now() - 80 * 24 * 60 * 60 * 1000) },
    });
    const end = etDate();
    const users = [];
    const activities = [];
    // All 32 dates are mature for D30. Only the newest 30 belong to the pooled
    // population. The two excluded oldest dates deliberately carry extra
    // ineligible signups, so removing LIMIT 30 changes both coverage counts.
    for (let index = 0; index < 32; index += 1) {
      const signupDate = addDays(end, -(40 + index));
      const eligibleId = randomUUID();
      users.push({
        id: eligibleId,
        appleId: `retention-eligible-${index}-${Date.now()}`,
        createdAt: new Date(`${signupDate}T16:00:00Z`),
        metricsV2SignupEligible: true,
        metricsV2SignupEpochId: epoch.id,
      });
      const ineligibleCount = index >= 30 ? 5 : 1;
      for (let population = 0; population < ineligibleCount; population += 1) {
        users.push({
          id: randomUUID(),
          appleId: `retention-ineligible-${index}-${population}-${Date.now()}`,
          createdAt: new Date(`${signupDate}T17:00:00Z`),
        });
      }
      for (const horizon of [1, 7, 30]) {
        const activityDate = addDays(signupDate, horizon);
        activities.push({
          userId: eligibleId,
          activityDate: new Date(`${activityDate}T00:00:00Z`),
          firstSeenAt: new Date(`${activityDate}T16:00:00Z`),
          lastSeenAt: new Date(`${activityDate}T16:00:00Z`),
          metadataOccurredAt: new Date(`${activityDate}T16:00:00Z`),
          appVersion: "2.5.0",
        });
      }
    }
    await prisma.user.createMany({ data: users });
    await prisma.userActivityDay.createMany({ data: activities });

    for (const window of ["7d", "30d"]) {
      const dashboard = await get("dashboard-summary", window);
      for (const horizon of ["d1", "d7", "d30"]) {
        const coverageKey = `retention${horizon.toUpperCase()}`;
        assert.equal(dashboard.summary.retention[horizon].numerator, 30);
        assert.equal(dashboard.summary.retention[horizon].denominator, 30);
        assert.equal(dashboard.summary.retention[horizon].percent, 100);
        assert.equal(dashboard.coverage.metricCoverage[coverageKey].eligible, 30);
        assert.equal(
          dashboard.coverage.metricCoverage[coverageKey].totalPopulation,
          60,
          `${window} ${horizon} excludes the two oldest cohort populations`
        );
      }
    }
  });

  it("reports coverage collection dates in the dashboard ET calendar", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const nearMidnightUtc = new Date();
    nearMidnightUtc.setUTCDate(nearMidnightUtc.getUTCDate() - 10);
    nearMidnightUtc.setUTCHours(0, 30, 0, 0);
    const expectedEtDate = new Date(
      nearMidnightUtc.getTime() - 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);
    await prisma.adminMetricsCollectionEpoch.updateMany({
      where: { endedAt: null },
      data: { startedAt: nearMidnightUtc },
    });
    await prisma.metricCoverageStart.createMany({
      data: [
        { metric: "boxOpen", operationalAt: nearMidnightUtc },
        { metric: "firstRacePowerUse", operationalAt: nearMidnightUtc },
      ],
    });

    const dashboard = await get("dashboard-activation", "7d");
    assert.equal(dashboard.coverage.foregroundActivitySince, expectedEtDate);
    assert.equal(
      dashboard.coverage.metricCoverage.firstRacePowerUse.collectingSince,
      expectedEtDate
    );
  });

  it("computes observed, featured, ranked, and leaderboard engagement leaves", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({ where: { endedAt: null } });
    const epochStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.adminMetricsCollectionEpoch.update({ where: { id: epoch.id }, data: { startedAt: epochStart } });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { metricsV2EligibleAt: epochStart, metricsV2EligibleEpochId: epoch.id },
    });
    const today = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await prisma.userActivityDay.create({
      data: {
        userId: admin.user.id,
        activityDate: new Date(`${today}T00:00:00Z`),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        appVersion: "2.5.0",
        metadataOccurredAt: new Date(),
      },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: admin.user.id,
        name: "Observed active race",
        targetSteps: 1000,
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: admin.user.id, status: "ACCEPTED" },
    });
    await prisma.activationEvent.create({
      data: {
        id: `leaderboard-${Date.now()}`,
        userId: admin.user.id,
        name: "race_leaderboard_viewed",
        context: { race_id: race.id },
        appVersion: "2.5.0",
        platform: "ios",
        occurredAt: new Date(),
      },
    });
    const seed = await prisma.raceSeed.create({
      data: {
        id: `metrics-daily-${Date.now()}`,
        kind: `METRICS_DAILY_${Date.now()}`,
        name: "Metrics daily",
        targetSteps: 1000,
        cadence: "DAILY",
      },
    });
    const featured = await prisma.race.create({
      data: {
        creatorId: admin.user.id,
        seedId: seed.id,
        name: "Featured daily",
        targetSteps: 1000,
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: featured.id, userId: admin.user.id, status: "ACCEPTED" },
    });
    const week = await prisma.rankedWeek.create({
      data: {
        index: 900000 + Math.floor(Math.random() * 90000),
        startsOn: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endsOn: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const cohort = await prisma.rankedCohort.create({ data: { weekId: week.id, tier: "BRONZE" } });
    await prisma.rankedCohortMember.create({
      data: { weekId: week.id, cohortId: cohort.id, userId: admin.user.id, tier: "BRONZE" },
    });

    const engagement = (await get("dashboard-engagement", "7d")).raceEngagement;
    assert.deepEqual(engagement.racesPerObservedActiveUser, {
      numerator: 1,
      denominator: 1,
      average: 1,
    });
    assert.deepEqual(engagement.leaderboardViewsPerCapableRacer, {
      numerator: 1,
      denominator: 1,
      average: 1,
    });
    assert.deepEqual(engagement.featuredParticipation.daily, {
      activeOverlapUsers: 1,
      activeOverlapMemberships: 1,
      joinedWindowUsers: 1,
      joinedWindowMemberships: 1,
    });
    assert.equal(engagement.rankedParticipationUsers, 1);
  });

  it("uses only current-epoch iOS non-review foreground facts and nulls pre-epoch dates", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    const today = etDate();
    const epochDate = addDays(today, -3);
    const observedDate = addDays(today, -2);
    const preEpochDate = addDays(today, -4);
    const startedAt = new Date(`${epochDate}T12:00:00Z`);
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt },
    });
    const capable = await createTestUser({
      appleId: `growth-capable-${Date.now()}`,
      metricsV2EligibleAt: startedAt,
      metricsV2EligibleEpochId: epoch.id,
    });
    const review = await createTestUser({
      appleId: `growth-review-${Date.now()}`,
      isReviewAccount: true,
      metricsV2EligibleAt: startedAt,
      metricsV2EligibleEpochId: epoch.id,
    });
    const android = await prisma.user.create({
      data: { googleSub: `growth-google-${Date.now()}` },
    });
    for (const [userId, date] of [
      [capable.user.id, preEpochDate],
      [capable.user.id, observedDate],
      [review.user.id, observedDate],
      [android.id, observedDate],
    ]) {
      await prisma.userActivityDay.create({
        data: {
          userId,
          activityDate: new Date(`${date}T00:00:00Z`),
          firstSeenAt: new Date(`${date}T12:00:00Z`),
          lastSeenAt: new Date(`${date}T12:00:00Z`),
          appVersion: "2.5.0",
          metadataOccurredAt: new Date(`${date}T12:00:00Z`),
        },
      });
    }

    const daily = (await get("dashboard-growth", "7d")).userGrowth.daily;
    assert.equal(
      daily.find((row) => row.date === preEpochDate).observedForegroundUsers,
      null
    );
    assert.equal(
      daily.find((row) => row.date === observedDate).observedForegroundUsers,
      1
    );
  });

  it("filters onboarding sessions to Apple non-review accounts", async () => {
    const occurredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const apple = await createTestUser({ appleId: `onboarding-ios-${Date.now()}` });
    const review = await createTestUser({
      appleId: `onboarding-review-${Date.now()}`,
      isReviewAccount: true,
    });
    const android = await prisma.user.create({
      data: { googleSub: `onboarding-android-${Date.now()}` },
    });
    await prisma.activationEvent.createMany({
      data: [apple.user, review.user, android].flatMap((user, index) => [
        {
          id: `onboarding-start-${index}-${Date.now()}`,
          userId: user.id,
          onboardingSessionId: `onboarding-session-${index}`,
          name: "onboarding_started",
          context: {},
          appVersion: "2.5.0",
          platform: "ios",
          occurredAt,
        },
        {
          id: `onboarding-home-${index}-${Date.now()}`,
          userId: user.id,
          onboardingSessionId: `onboarding-session-${index}`,
          name: "home_reached",
          context: {},
          appVersion: "2.5.0",
          platform: "ios",
          occurredAt: new Date(occurredAt.getTime() + 60 * 60 * 1000),
        },
      ]),
    });

    const funnel = (await get("dashboard-funnels", "7d")).onboardingFunnel;
    assert.equal(
      funnel.stages.find((stage) => stage.key === "onboarding_started").count,
      1
    );
    assert.equal(
      funnel.stages.find((stage) => stage.key === "home_reached").count,
      1
    );
  });

  it("uses matching eligible runner and race populations for engagement", async () => {
    const runner = await createTestUser({ appleId: `mixed-runner-${Date.now()}` });
    const peer = await createTestUser({ appleId: `mixed-peer-${Date.now()}` });
    const androidCreator = await prisma.user.create({
      data: { googleSub: `mixed-creator-${Date.now()}` },
    });
    const startedAt = new Date();
    const eligibleRace = await prisma.race.create({
      data: {
        creatorId: runner.user.id,
        name: "Eligible power race",
        targetSteps: 1000,
        status: "ACTIVE",
        powerupsEnabled: true,
        startedAt,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: eligibleRace.id, userId: runner.user.id, status: "ACCEPTED" },
        { raceId: eligibleRace.id, userId: peer.user.id, status: "ACCEPTED" },
      ],
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: eligibleRace.id,
        actorUserId: runner.user.id,
        eventType: "POWERUP_USED",
        powerupType: "PROTEIN_SHAKE",
        description: "eligible use",
      },
    });

    const seed = await prisma.raceSeed.create({
      data: {
        id: `mixed-seed-${Date.now()}`,
        kind: `MIXED_SEED_${Date.now()}`,
        name: "System featured race",
        targetSteps: 1000,
        cadence: "DAILY",
      },
    });
    const featured = await prisma.race.create({
      data: {
        creatorId: androidCreator.id,
        seedId: seed.id,
        name: "System featured",
        targetSteps: 1000,
        status: "ACTIVE",
        powerupsEnabled: true,
        startedAt,
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: featured.id, userId: runner.user.id, status: "ACCEPTED" },
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: featured.id,
        actorUserId: runner.user.id,
        eventType: "POWERUP_USED",
        powerupType: "PROTEIN_SHAKE",
        description: "featured use",
      },
    });

    const engagement = (await get("dashboard-engagement", "7d")).raceEngagement;
    assert.deepEqual(engagement.powerupsPerRace, {
      numerator: 1,
      denominator: 1,
      average: 1,
    });
    assert.deepEqual(engagement.featuredParticipation.daily, {
      activeOverlapUsers: 1,
      activeOverlapMemberships: 1,
      joinedWindowUsers: 1,
      joinedWindowMemberships: 1,
    });
  });

  it("ranks the actual first accepted race before finish qualification", async () => {
    const runner = await createTestUser({ appleId: `forfeit-first-${Date.now()}` });
    const creator = await createTestUser({ appleId: `forfeit-creator-${Date.now()}` });
    const today = etDate();
    const times = [-40, -35, -30].map(
      (offset) => new Date(`${addDays(today, offset)}T12:00:00Z`)
    );
    const races = [];
    for (let index = 0; index < 3; index += 1) {
      races.push(await prisma.race.create({
        data: {
          creatorId: creator.user.id,
          name: `Repeat race ${index}`,
          targetSteps: 1000,
          status: index < 2 ? "COMPLETED" : "ACTIVE",
          startedAt: new Date(times[index].getTime() - 60 * 60 * 1000),
          completedAt: index < 2 ? times[index] : null,
        },
      }));
    }
    await prisma.raceParticipant.createMany({
      data: [
        {
          raceId: races[0].id,
          userId: runner.user.id,
          status: "ACCEPTED",
          joinedAt: new Date(times[0].getTime() - 2 * 60 * 60 * 1000),
          finishedAt: times[0],
          forfeitedAt: new Date(times[0].getTime() - 30 * 60 * 1000),
        },
        {
          raceId: races[1].id,
          userId: runner.user.id,
          status: "ACCEPTED",
          joinedAt: new Date(times[1].getTime() - 2 * 60 * 60 * 1000),
          finishedAt: times[1],
        },
        {
          raceId: races[2].id,
          userId: runner.user.id,
          status: "ACCEPTED",
          joinedAt: times[2],
        },
      ],
    });

    const retention = (await get("dashboard-retention", "90d")).retention;
    assert.deepEqual(retention.secondRaceWithin7d, {
      numerator: 0,
      denominator: 0,
      percent: null,
    });
    assert.deepEqual(retention.secondRaceWithin30d, {
      numerator: 0,
      denominator: 0,
      percent: null,
    });
  });

  it("requires active-version HMAC coverage and populates attributed signups per mature WAU", async () => {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    const today = etDate();
    const epochStart = new Date(`${addDays(today, -10)}T12:00:00Z`);
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt: epochStart },
    });
    const owner = await createTestUser({
      appleId: `hmac-owner-${Date.now()}`,
      referralCode: `BARA-HMAC-${Date.now()}`,
      metricsV2EligibleAt: epochStart,
      metricsV2EligibleEpochId: epoch.id,
    });
    const referee = await createTestUser({
      appleId: `hmac-referee-${Date.now()}`,
      createdAt: new Date(`${addDays(today, -2)}T12:00:00Z`),
    });
    await prisma.referral.create({
      data: {
        referrerId: owner.user.id,
        refereeId: referee.user.id,
        refereeSubHash: `hmac-referee-hash-${Date.now()}`,
        code: owner.user.referralCode,
      },
    });
    await prisma.linkOpen.create({
      data: {
        kind: "referral",
        code: owner.user.referralCode,
        ipHash: "a".repeat(64),
        ipHashVersion: 1,
        createdAt: new Date(`${addDays(today, -2)}T11:00:00Z`),
      },
    });
    await prisma.userActivityDay.create({
      data: {
        userId: owner.user.id,
        activityDate: new Date(`${addDays(today, -1)}T00:00:00Z`),
        firstSeenAt: new Date(`${addDays(today, -1)}T12:00:00Z`),
        lastSeenAt: new Date(`${addDays(today, -1)}T12:00:00Z`),
        appVersion: "2.5.0",
        metadataOccurredAt: new Date(`${addDays(today, -1)}T12:00:00Z`),
      },
    });

    let virality = (await get("dashboard-virality", "7d")).virality;
    assert.equal(virality.attributedSignups, 1);
    assert.deepEqual(virality.linkOpenToSignup, {
      numerator: null,
      denominator: null,
      percent: null,
    });
    assert.equal(virality.attributedSignupsPerWau, 1);

    await prisma.metricCoverageStart.create({
      data: {
        metric: "referralHmacV1",
        operationalAt: new Date(`${addDays(today, -10)}T12:00:00Z`),
      },
    });
    virality = (await get("dashboard-virality", "7d")).virality;
    assert.deepEqual(virality.linkOpenToSignup, {
      numerator: 1,
      denominator: 1,
      percent: 100,
    });
  });

  it("keeps every lazy dashboard request within its SQL statement ceiling", async () => {
    const ceilings = {
      "dashboard-summary": 12,
      "dashboard-growth": 6,
      "dashboard-funnels": 10,
      "dashboard-activation": 10,
      "dashboard-retention": 8,
      "dashboard-engagement": 16,
      "dashboard-virality": 6,
      "dashboard-revenue": 8,
      "dashboard-release-adoption": 3,
    };
    for (const [section, ceiling] of Object.entries(ceilings)) {
      capturedQueryCount = 0;
      captureQueries = true;
      const response = await request(
        server.baseUrl,
        "GET",
        `/admin/stats?sections=${section}&window=7d`,
        { token: admin.token }
      );
      assert.equal(response.status, 200);
      await response.json();
      captureQueries = false;
      assert.ok(
        capturedQueryCount <= ceiling,
        `${section}: ${capturedQueryCount} > ${ceiling}`
      );
    }
  });
});
