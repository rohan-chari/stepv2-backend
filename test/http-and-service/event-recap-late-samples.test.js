const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, prisma, request, startServer } = require("./setup");

const RECAP_FEATURES = {
  "X-Client-Features": "impact_summaries,impact_summary_expiry_v1,simple_event_recap_v1",
};
const FIXED_NOW = new Date("2026-09-11T22:40:00.000Z");
const eventStart = new Date("2026-09-11T22:00:00.000Z");
const eventEnd = new Date("2026-09-11T22:30:00.000Z");

let server;

async function createRecapCandidate(userId) {
  const event = await prisma.globalStepEvent.create({
    data: {
      eventDay: randomUUID(),
      scheduleMode: "LOCAL_ENTITLEMENTS",
      startsAt: eventStart,
      endsAt: eventEnd,
      multiplier: 2,
      label: "Late recap test event",
    },
  });
  const entitlement = await prisma.globalStepEventEntitlement.create({
    data: {
      eventId: event.id,
      userId,
      timezone: "UTC",
      localDate: "2026-09-11",
      startsAt: eventStart,
      endsAt: eventEnd,
      startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: eventStart,
      recapRaceCount: 1,
      recapCountPolicyVersion: 1,
      recapWindowRevision: 0,
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE global_step_event_entitlements
        SET recap_window_revision=schedule_revision
      WHERE id=$1`,
    entitlement.id,
  );
  return { event, entitlement };
}

async function recap(token, method = "GET", body) {
  const response = await request(server.baseUrl, method, "/home/event-recap", {
    token,
    body,
    headers: RECAP_FEATURES,
  });
  return { status: response.status, body: await response.json() };
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    token,
    body: { samples },
    headers: RECAP_FEATURES,
  });
}

async function recordSyncV2(token, samples) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    token,
    body: { date: "2026-09-11", steps: 2000, samples },
    headers: { ...RECAP_FEATURES, "Idempotency-Key": randomUUID() },
  });
}

describe("global event recap late event-time samples", () => {
  before(async () => {
    server = await startServer({ now: () => FIXED_NOW });
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  after(async () => {
    await server.close();
  });

  it("documents first-write-wins recap staleness after a late sync", async () => {
    const { user, token } = await createTestUser({ globalEventTimezone: "UTC" });
    const { event } = await createRecapCandidate(user.id);

    const early = {
      periodStart: "2026-09-11T22:00:00.000Z",
      periodEnd: "2026-09-11T22:10:00.000Z",
      steps: 500,
    };
    const earlyResponse = await recordSamples(token, [early]);
    assert.equal(earlyResponse.status, 200, await earlyResponse.text());

    const first = await recap(token, "POST", {
      eventId: event.id,
      revision: 0,
      rawSteps: 500,
    });
    assert.equal(first.status, 200);
    const savedBefore = await prisma.eventRecap.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    assert.equal(savedBefore.rawSteps, 500);
    assert.equal(savedBefore.raceCount, 1);
    assert.equal(savedBefore.extraRaceSteps, 500);
    assert.ok(savedBefore.settledAt);

    const generationBefore = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const late = [
      { periodStart: "2026-09-11T22:10:00.000Z", periodEnd: "2026-09-11T22:15:00.000Z", steps: 500 },
      { periodStart: "2026-09-11T22:15:00.000Z", periodEnd: "2026-09-11T22:20:00.000Z", steps: 500 },
      { periodStart: "2026-09-11T22:20:00.000Z", periodEnd: "2026-09-11T22:25:00.000Z", steps: 500 },
    ];
    const upload = await recordSyncV2(token, late);
    assert.equal(upload.status, 202, await upload.text());

    const generationAfter = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.ok(BigInt(generationAfter.generation) > BigInt(generationBefore.generation));
    const source = await prisma.stepSample.aggregate({
      where: {
        userId: user.id,
        periodStart: { gte: eventStart },
        periodEnd: { lte: eventEnd },
      },
      _sum: { steps: true },
    });
    assert.equal(source._sum.steps, 2000);

    const savedAfterLate = await prisma.eventRecap.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    assert.equal(savedAfterLate.rawSteps, savedBefore.rawSteps);
    assert.equal(savedAfterLate.extraRaceSteps, savedBefore.extraRaceSteps);
    assert.equal(savedAfterLate.raceCount, savedBefore.raceCount);
    assert.equal(savedAfterLate.settledAt.getTime(), savedBefore.settledAt.getTime());

    const retry = await recap(token, "POST", {
      eventId: event.id,
      revision: 0,
      rawSteps: 2000,
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.globalEventSummary.extraRaceSteps, 500);
    assert.equal(await prisma.eventRecap.count({ where: { eventId: event.id, userId: user.id } }), 1);

    const duplicateUpload = await recordSyncV2(token, late);
    assert.equal(duplicateUpload.status, 202, await duplicateUpload.text());
    const generationAfterDuplicate = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(BigInt(generationAfterDuplicate.generation), BigInt(generationAfter.generation));
    const savedAfterDuplicate = await prisma.eventRecap.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    assert.equal(savedAfterDuplicate.rawSteps, 500);
    assert.equal(savedAfterDuplicate.extraRaceSteps, 500);
  });
});
