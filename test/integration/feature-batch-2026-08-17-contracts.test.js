const assert = require("node:assert/strict");
const { afterEach, before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");
const { buildDomainEventProjectionJob } = require("../../src/modules/domainEvents");

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
const CAPABILITIES = {
  "X-Client-Features": "impact_notices,impact_summaries,review_prompt,inbox_v1",
};

let server;

async function createCompletedRace(ownerId, name = "Settlement contract race") {
  return prisma.race.create({
    data: {
      creatorId: ownerId,
      name,
      targetSteps: 1000,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
}

describe("2026-08-17 additive contracts", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    for (const flag of [
      "apiImpactNoticesEnabled",
      "apiCompletedImpactPopupEnabled",
      "apiImpactSummariesEnabled",
      "apiReviewPromptEnabled",
      "apiInboxV1Enabled",
      "apiProfileStatsV1Enabled",
    ]) await appSettings.setFlag(flag, true);
  });
  afterEach(async () => {
    for (const flag of [
      "apiImpactNoticesEnabled",
      "apiCompletedImpactPopupEnabled",
      "apiImpactSummariesEnabled",
      "apiReviewPromptEnabled",
      "apiInboxV1Enabled",
      "apiProfileStatsV1Enabled",
    ]) await appSettings.setFlag(flag, false);
    await appSettings.setFlagsAtomically([
      ["homeServiceBannerEnabled", false],
      ["homeServiceBannerMessage", ""],
      ["homeServiceBannerContestSlug", ""],
    ]);
  });

  it("keeps private effect notices private and acknowledgement idempotent", async () => {
    const owner = await createTestUser({ displayName: "Affected" });
    const teammate = await createTestUser({ displayName: "Other racer" });
    const outsider = await createTestUser();
    const race = await createCompletedRace(owner.user.id);
    await prisma.raceParticipant.createMany({ data: [
      { raceId: race.id, userId: owner.user.id, status: "ACCEPTED", placement: 1 },
      { raceId: race.id, userId: teammate.user.id, status: "ACCEPTED", placement: 2 },
    ] });
    const impact = await prisma.raceEffectImpact.create({ data: {
      raceId: race.id, userId: owner.user.id, effectId: "effect-1",
      powerupType: "RUNNERS_HIGH", deltaSteps: 426,
    } });

    const mine = await request(server.baseUrl, "GET", `/races/${race.id}/impact-notices`, {
      token: owner.token, headers: CAPABILITIES,
    });
    assert.equal(mine.status, 200);
    assert.deepEqual((await mine.json()).notices.map((notice) => ({
      id: notice.id, powerupType: notice.powerupType, deltaSteps: notice.deltaSteps,
    })), [{ id: impact.id, powerupType: "RUNNERS_HIGH", deltaSteps: 426 }]);

    const privateFeed = await request(server.baseUrl, "GET", `/races/${race.id}/private-impact-feed`, {
      token: owner.token, headers: CAPABILITIES,
    });
    assert.equal(privateFeed.status, 200);
    assert.equal((await privateFeed.json()).events[0].description, "You gained 426 steps from Runner’s High.");

    const other = await request(server.baseUrl, "GET", `/races/${race.id}/impact-notices`, {
      token: teammate.token, headers: CAPABILITIES,
    });
    assert.equal(other.status, 200);
    assert.deepEqual((await other.json()).notices, []);

    const forbidden = await request(server.baseUrl, "GET", `/races/${race.id}/impact-notices`, {
      token: outsider.token, headers: CAPABILITIES,
    });
    assert.equal(forbidden.status, 403);

    const ack = await request(server.baseUrl, "POST", `/races/${race.id}/impact-notices/${impact.id}/acknowledge`, {
      token: owner.token, headers: CAPABILITIES,
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { acknowledged: true });
    const foreignAck = await request(server.baseUrl, "POST", `/races/${race.id}/impact-notices/${impact.id}/acknowledge`, {
      token: teammate.token, headers: CAPABILITIES,
    });
    assert.equal(foreignAck.status, 404);
  });

  it("serves recipient-private inbox alerts and staff-only feedback replies", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const alert = await prisma.inboxAlert.create({ data: {
      userId: user.user.id, type: "DAILY_REWARD", title: "Daily reward",
      body: "Your box is ready.", sourceKey: "test:daily-reward",
      destination: { route: "dailyReward" }, expiresAt: new Date(Date.now() + 86_400_000),
    } });

    const list = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: user.token, headers: CAPABILITIES,
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.unreadCount, 1);
    assert.equal(listed.alerts[0].id, alert.id);
    assert.equal(listed.alerts[0].destination.route, "dailyReward");

    const foreignRead = await request(server.baseUrl, "POST", `/inbox/alerts/${alert.id}/read`, {
      token: other.token, headers: CAPABILITIES,
    });
    assert.equal(foreignRead.status, 404);
    const read = await request(server.baseUrl, "POST", `/inbox/alerts/${alert.id}/read`, {
      token: user.token, headers: CAPABILITIES,
    });
    assert.equal(read.status, 200);

    const submit = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token: user.token, body: { text: "Please improve sync." }, headers: CAPABILITIES,
    });
    assert.equal(submit.status, 201);
    const threads = await request(server.baseUrl, "GET", "/feedback/threads", {
      token: user.token, headers: CAPABILITIES,
    });
    assert.equal(threads.status, 200);
    const thread = (await threads.json()).threads[0];
    assert.ok(thread.id);

    const noAdmin = await request(server.baseUrl, "GET", "/admin/feedback/threads", {
      token: user.token, headers: CAPABILITIES,
    });
    assert.equal(noAdmin.status, 403);
    const reply = await request(server.baseUrl, "POST", `/admin/feedback/threads/${thread.id}/messages`, {
      token: admin.token, headers: CAPABILITIES,
      body: { text: "Thanks — we are looking into it.", idempotencyKey: "4f4e3840-f74d-4d44-aec9-5fabb0cc4344" },
    });
    assert.equal(reply.status, 201);
    await buildDomainEventProjectionJob({
      logger: { log() {}, warn() {}, error() {} },
    })();
    const replyAlert = await prisma.inboxAlert.findFirst({
      where: { userId: user.user.id, type: "SUPPORT_REPLY" },
      include: { outbox: true },
    });
    assert.deepEqual(replyAlert.destination, { route: "supportThread", threadId: thread.id });
    assert.equal(replyAlert.outbox.length, 1);
    assert.deepEqual(replyAlert.outbox[0].payload.destination, { route: "supportThread", threadId: thread.id });
    const replyAgain = await request(server.baseUrl, "POST", `/admin/feedback/threads/${thread.id}/messages`, {
      token: admin.token, headers: CAPABILITIES,
      body: { text: "Thanks — we are looking into it.", idempotencyKey: "4f4e3840-f74d-4d44-aec9-5fabb0cc4344" },
    });
    assert.equal(replyAgain.status, 200);
  });

  it("includes the feedback thread user's displayName in the admin list", async () => {
    const namedUser = await createTestUser({ displayName: "Named Feedback User" });
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const submit = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token: namedUser.token, body: { text: "A named feedback thread." }, headers: CAPABILITIES,
    });
    assert.equal(submit.status, 201);

    const thread = await prisma.feedbackThread.findFirstOrThrow({
      where: { userId: namedUser.user.id },
    });
    const list = await request(server.baseUrl, "GET", "/admin/feedback/threads", {
      token: admin.token, headers: CAPABILITIES,
    });
    assert.equal(list.status, 200);
    const listed = (await list.json()).threads.find((row) => row.id === thread.id);
    assert.equal(listed.displayName, "Named Feedback User");
  });

  it("returns null for an admin feedback thread whose user has no displayName", async () => {
    const unnamedUser = await createTestUser({ displayName: null });
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const submit = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token: unnamedUser.token, body: { text: "An unnamed feedback thread." }, headers: CAPABILITIES,
    });
    assert.equal(submit.status, 201);

    const thread = await prisma.feedbackThread.findFirstOrThrow({
      where: { userId: unnamedUser.user.id },
    });
    const list = await request(server.baseUrl, "GET", "/admin/feedback/threads", {
      token: admin.token, headers: CAPABILITIES,
    });
    assert.equal(list.status, 200);
    const listed = (await list.json()).threads.find((row) => row.id === thread.id);
    assert.equal(listed.displayName, null);
  });

  it("returns the user's current displayName without leaking email or profile fields", async () => {
    const user = await createTestUser({ displayName: "OriginalName" });
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const submit = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token: user.token, body: { text: "A renamed feedback thread." }, headers: CAPABILITIES,
    });
    assert.equal(submit.status, 201);

    const thread = await prisma.feedbackThread.findFirstOrThrow({
      where: { userId: user.user.id },
    });
    const rename = await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      token: user.token, body: { displayName: "RenamedName" },
    });
    assert.equal(rename.status, 200);

    const list = await request(server.baseUrl, "GET", "/admin/feedback/threads", {
      token: admin.token, headers: CAPABILITIES,
    });
    assert.equal(list.status, 200);
    const listed = (await list.json()).threads.find((row) => row.id === thread.id);
    assert.equal(listed.displayName, "RenamedName");
    assert.deepEqual(Object.keys(listed).sort(), [
      "displayName", "id", "lastMessageAt", "preview", "suggestionId", "userUnread",
    ]);
    assert.equal("email" in listed, false);
    assert.equal("profilePhotoUrl" in listed, false);
    assert.equal("profilePhotoKey" in listed, false);
  });

  it("adds podium records and an operator-controlled Home service banner without changing legacy shapes", async () => {
    const user = await createTestUser({ email: ADMIN_EMAIL });
    const competitor = await createTestUser();
    const race = await createCompletedRace(user.user.id, "Podium race");
    await prisma.raceParticipant.createMany({ data: [
      { raceId: race.id, userId: user.user.id, status: "ACCEPTED", placement: 1 },
      { raceId: race.id, userId: competitor.user.id, status: "ACCEPTED", placement: 2 },
    ] });

    const stats = await request(server.baseUrl, "GET", "/steps/stats?view=profile-v1", {
      token: user.token, headers: { "X-Client-Features": "profile_podiums" },
    });
    assert.equal(stats.status, 200);
    assert.deepEqual((await stats.json()).racePodiums, { first: 1, second: 0, third: 0 });

    const invalid = await request(server.baseUrl, "PATCH", "/admin/settings/home-service-banner", {
      token: user.token, body: { enabled: true, message: "  " },
    });
    assert.equal(invalid.status, 400);
    const patched = await request(server.baseUrl, "PATCH", "/admin/settings/home-service-banner", {
      token: user.token, body: { enabled: true, message: "Step syncs may be delayed." },
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).settings.homeServiceBannerEnabled, true);
    const home = await request(server.baseUrl, "GET", "/home/race-card", { token: user.token });
    assert.equal(home.status, 200);
    assert.deepEqual((await home.json()).homeServiceBanner, {
      enabled: true, message: "Step syncs may be delayed.",
    });
  });

  it("delivers only a caller's global summary and atomically claims a review opportunity", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(Date.now() - 120_000), endsAt: new Date(Date.now() - 60_000), multiplier: 2,
      summaryAttributionVersion: 2,
    } });
    const mineSummaryRace = await createCompletedRace(user.user.id, "Mine summary race");
    const foreignSummaryRace = await createCompletedRace(other.user.id, "Foreign summary race");
    await prisma.globalEventRaceImpact.createMany({ data: [
      {
        eventId: event.id, raceId: mineSummaryRace.id, userId: user.user.id,
        status: "FINAL", deltaSteps: 840, settledAt: new Date(), attributionVersion: 2,
      },
      {
        eventId: event.id, raceId: foreignSummaryRace.id, userId: other.user.id,
        status: "FINAL", deltaSteps: 40, settledAt: new Date(), attributionVersion: 2,
      },
    ] });
    const mine = await prisma.globalEventUserSummary.create({ data: {
      eventId: event.id, userId: user.user.id, extraRaceSteps: 840, raceCount: 2,
      attributionVersion: 2, expiresAt: new Date(Date.now() + 60_000),
    } });
    const foreign = await prisma.globalEventUserSummary.create({ data: {
      eventId: event.id, userId: other.user.id, extraRaceSteps: 40, raceCount: 1,
      attributionVersion: 2, expiresAt: new Date(Date.now() + 60_000),
    } });
    const mineHome = await request(server.baseUrl, "GET", "/home/race-card", {
      token: user.token, headers: { "X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
    });
    assert.equal(mineHome.status, 200);
    assert.equal((await mineHome.json()).globalEventSummary.id, mine.id);
    const foreignAck = await request(server.baseUrl, "POST", `/home/global-event-summaries/${foreign.id}/acknowledge`, {
      token: user.token, headers: { "X-Client-Features": "impact_summaries" },
    });
    assert.equal(foreignAck.status, 404);
    const acknowledged = await request(server.baseUrl, "POST", `/home/global-event-summaries/${mine.id}/acknowledge`, {
      token: user.token, headers: { "X-Client-Features": "impact_summaries" },
    });
    assert.equal(acknowledged.status, 200);
    const repeated = await request(server.baseUrl, "POST", `/home/global-event-summaries/${mine.id}/acknowledge`, {
      token: user.token, headers: { "X-Client-Features": "impact_summaries" },
    });
    assert.equal(repeated.status, 409);

    const race = await createCompletedRace(user.user.id, "Review result");
    const opportunity = await prisma.appReviewPromptAttempt.create({ data: {
      userId: user.user.id, raceId: race.id, opportunityId: "86c93131-615b-45ff-b6d8-9733f6dc5211",
      expiresAt: new Date(Date.now() + 86_400_000),
    } });
    const claim = await request(server.baseUrl, "POST", `/races/${race.id}/review-opportunities/${opportunity.opportunityId}/claim`, {
      token: user.token, headers: { "X-Client-Features": "review_prompt" },
    });
    assert.equal(claim.status, 200);
    const secondClaim = await request(server.baseUrl, "POST", `/races/${race.id}/review-opportunities/${opportunity.opportunityId}/claim`, {
      token: user.token, headers: { "X-Client-Features": "review_prompt" },
    });
    assert.equal(secondClaim.status, 409);
  });

  it("uses a transactional JobRun fence when global impact groups become final", async () => {
    const user = await createTestUser();
    const event = await prisma.globalStepEvent.create({ data: {
      // The recap is deliberately immutable only after the enrollment window
      // closes; keep this fixture before the tick's injected clock.
      startsAt: new Date("2026-08-17T11:50:00.000Z"),
      endsAt: new Date("2026-08-17T11:55:00.000Z"),
      multiplier: 2,
    } });
    const firstRace = await createCompletedRace(user.user.id, "First global-impact race");
    const secondRace = await createCompletedRace(user.user.id, "Second global-impact race");
    await prisma.globalEventRaceImpact.createMany({ data: [
      { eventId: event.id, raceId: firstRace.id, userId: user.user.id, status: "FINAL", deltaSteps: 10, settledAt: new Date() },
      { eventId: event.id, raceId: secondRace.id, userId: user.user.id, status: "PENDING" },
    ] });
    const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date("2026-08-17T12:00:00.000Z") });
    assert.deepEqual(await tick(), { upserts: 0 }, "a pending race prevents an incomplete summary");

    await prisma.globalEventRaceImpact.updateMany({
      where: { eventId: event.id, raceId: secondRace.id, userId: user.user.id },
      data: { status: "FINAL", deltaSteps: 5, settledAt: new Date() },
    });
    await Promise.all([tick(), tick()]);
    const summary = await prisma.globalEventUserSummary.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });
    assert.equal(summary.extraRaceSteps, 15);
    assert.equal(summary.raceCount, 2);
    assert.equal(await prisma.jobRun.count({
      where: { jobName: `global_event_summary:${event.id}:${user.user.id}:v1` },
    }), 1);
  });
});
