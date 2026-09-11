const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  buildGlobalEventSummaryTick,
  runV1,
} = require("../../src/modules/steps/jobs/globalEventSummary");
const {
  auditPendingV1Impacts,
} = require("../../src/modules/steps/services/v1PendingImpactAudit");

async function createRace(userId, name = "v1 summary race", status = "ACTIVE") {
  return prisma.race.create({
    data: { creatorId: userId, name, targetSteps: 10_000, status },
  });
}

async function createEvent(current, overrides = {}) {
  return prisma.globalStepEvent.create({
    data: {
      startsAt: new Date(current.getTime() - 120_000),
      endsAt: new Date(current.getTime() - 60_000),
      multiplier: 2,
      scheduleMode: "LEGACY_GLOBAL",
      summaryAttributionVersion: 1,
      ...overrides,
    },
  });
}

async function createImpact({ eventId, raceId, userId, status = "FINAL", deltaSteps = 1 }) {
  return prisma.globalEventRaceImpact.create({
    data: {
      eventId,
      raceId,
      userId,
      status,
      deltaSteps: status === "FINAL" ? deltaSteps : null,
      attributionVersion: 1,
    },
  });
}

describe("global event v1 summary candidate discovery", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.jobRun.deleteMany({
      where: { jobName: { startsWith: "global_event_summary:" } },
    });
  });

  it("finds one eligible group among thousands of fenced historical groups", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const historicalCount = 2_000;
    const historicalEvents = Array.from({ length: historicalCount }, () => ({
      id: randomUUID(),
      startsAt: new Date(current.getTime() - 120_000),
      endsAt: new Date(current.getTime() - 60_000),
      multiplier: 2,
      scheduleMode: "LEGACY_GLOBAL",
      summaryAttributionVersion: 1,
    }));
    await prisma.globalStepEvent.createMany({ data: historicalEvents });
    await prisma.globalEventRaceImpact.createMany({
      data: historicalEvents.map((event) => ({
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: 1,
        attributionVersion: 1,
      })),
    });
    await prisma.jobRun.createMany({
      data: historicalEvents.map((event) => ({
        jobName: `global_event_summary:${event.id}:${user.user.id}:v1`,
        lastRanFor: "FINAL",
      })),
    });
    const eligible = await createEvent(current);
    await createImpact({
      eventId: eligible.id,
      raceId: race.id,
      userId: user.user.id,
      deltaSteps: 250,
    });

    const result = await runV1(prisma, current);

    assert.equal(result.candidatesSelected, 1);
    assert.equal(result.summariesCommitted, 1);
    assert.ok(await prisma.jobRun.findUnique({
      where: { jobName: `global_event_summary:${eligible.id}:${user.user.id}:v1` },
    }));
    assert.equal((await prisma.globalEventUserSummary.findUniqueOrThrow({
      where: { eventId_userId: { eventId: eligible.id, userId: user.user.id } },
    })).extraRaceSteps, 250);
  });

  it("leaves groups with pending impacts untouched", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id, "pending active race");
    const event = await createEvent(current);
    await createImpact({ eventId: event.id, raceId: race.id, userId: user.user.id, status: "PENDING" });

    assert.equal((await runV1(prisma, current)).candidatesSelected, 0);
    assert.equal(await prisma.jobRun.findUnique({
      where: { jobName: `global_event_summary:${event.id}:${user.user.id}:v1` },
    }), null);
    assert.equal(await prisma.globalEventUserSummary.count(), 0);
  });

  it("uses the entitlement end time for local events", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const entitlementEnd = new Date(current.getTime() + 60_000);
    const event = await createEvent(current, { scheduleMode: "LOCAL_ENTITLEMENTS" });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        timezone: "UTC",
        localDate: current.toISOString().slice(0, 10),
        startsAt: event.startsAt,
        endsAt: entitlementEnd,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: event.startsAt,
      },
    });
    await createImpact({ eventId: event.id, raceId: race.id, userId: user.user.id });

    assert.equal((await runV1(prisma, current)).candidatesSelected, 0);
    assert.equal((await runV1(prisma, new Date(entitlementEnd.getTime() + 1))).summariesCommitted, 1);
  });

  it("durably fences all-zero groups without creating visible summaries", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const event = await createEvent(current);
    await createImpact({ eventId: event.id, raceId: race.id, userId: user.user.id, deltaSteps: 0 });

    const result = await runV1(prisma, current);

    assert.equal(result.allZeroFenced, 1);
    assert.equal(result.summariesCommitted, 0);
    assert.equal(await prisma.globalEventUserSummary.count(), 0);
    assert.equal((await prisma.jobRun.findUniqueOrThrow({
      where: { jobName: `global_event_summary:${event.id}:${user.user.id}:v1` },
    })).lastRanFor, "ALL_ZERO");
  });

  it("creates a summary when mixed nonzero contributions sum to zero", async () => {
    const current = new Date();
    const user = await createTestUser();
    const races = await Promise.all([
      createRace(user.user.id, "positive contribution"),
      createRace(user.user.id, "negative contribution"),
    ]);
    const event = await createEvent(current);
    await createImpact({ eventId: event.id, raceId: races[0].id, userId: user.user.id, deltaSteps: 50 });
    await createImpact({ eventId: event.id, raceId: races[1].id, userId: user.user.id, deltaSteps: -50 });

    const result = await runV1(prisma, current);
    const summary = await prisma.globalEventUserSummary.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });

    assert.equal(result.summariesCommitted, 1);
    assert.equal(summary.extraRaceSteps, 0);
    assert.equal(summary.raceCount, 2);
  });

  it("enforces the 100-candidate batch limit", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const events = Array.from({ length: 101 }, () => ({
      id: randomUUID(),
      startsAt: new Date(current.getTime() - 120_000),
      endsAt: new Date(current.getTime() - 60_000),
      multiplier: 2,
      scheduleMode: "LEGACY_GLOBAL",
      summaryAttributionVersion: 1,
    }));
    await prisma.globalStepEvent.createMany({ data: events });
    await prisma.globalEventRaceImpact.createMany({
      data: events.map((event) => ({
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: 1,
        attributionVersion: 1,
      })),
    });

    const first = await runV1(prisma, current, 1_000);
    assert.equal(first.candidatesSelected, 100);
    assert.equal(first.batchLimitSaturated, true);
    assert.equal(await prisma.globalEventUserSummary.count(), 100);
    assert.equal((await runV1(prisma, current)).candidatesSelected, 1);
  });

  it("keeps simultaneous runners idempotent through the unique fence", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const event = await createEvent(current);
    await createImpact({ eventId: event.id, raceId: race.id, userId: user.user.id, deltaSteps: 75 });

    const results = await Promise.all([runV1(prisma, current), runV1(prisma, current)]);

    assert.equal(results.reduce((sum, result) => sum + result.summariesCommitted, 0), 1);
    assert.ok(await prisma.jobRun.findUnique({
      where: { jobName: `global_event_summary:${event.id}:${user.user.id}:v1` },
    }));
    assert.equal(await prisma.globalEventUserSummary.count(), 1);
  });

  it("keeps the combined compatibility tick result stable", async () => {
    const current = new Date();
    const user = await createTestUser();
    const race = await createRace(user.user.id);
    const event = await createEvent(current);
    await createImpact({ eventId: event.id, raceId: race.id, userId: user.user.id, deltaSteps: 10 });

    assert.deepEqual(await buildGlobalEventSummaryTick({ prisma, now: () => current })(), {
      upserts: 1,
    });
  });

  it("classifies pending impacts and terminal-only groups without writing", async () => {
    const current = new Date();
    const user = await createTestUser();
    const [activeEvent, terminalEvent, missingEvidenceEvent] = await Promise.all([
      createEvent(current),
      createEvent(current),
      createEvent(current),
    ]);
    const [activeRace, completedRace, cancelledRace, missingEvidenceRace] = await Promise.all([
      createRace(user.user.id, "audit active", "ACTIVE"),
      createRace(user.user.id, "audit completed", "COMPLETED"),
      createRace(user.user.id, "audit cancelled", "CANCELLED"),
      createRace(user.user.id, "audit missing evidence", "COMPLETED"),
    ]);
    await prisma.race.updateMany({
      where: { id: { in: [completedRace.id, missingEvidenceRace.id] } },
      data: { completedAt: current },
    });
    await prisma.raceParticipant.createMany({ data: [
      {
        raceId: activeRace.id,
        userId: user.user.id,
        status: "ACCEPTED",
        totalSteps: 10,
      },
      {
        raceId: completedRace.id,
        userId: user.user.id,
        status: "ACCEPTED",
        totalSteps: 20,
        placement: 1,
      },
      {
        raceId: cancelledRace.id,
        userId: user.user.id,
        status: "ACCEPTED",
        totalSteps: 0,
      },
    ] });
    await Promise.all([
      createImpact({
        eventId: activeEvent.id,
        raceId: activeRace.id,
        userId: user.user.id,
        status: "PENDING",
      }),
      createImpact({
        eventId: terminalEvent.id,
        raceId: completedRace.id,
        userId: user.user.id,
        status: "PENDING",
      }),
      createImpact({
        eventId: terminalEvent.id,
        raceId: cancelledRace.id,
        userId: user.user.id,
        status: "PENDING",
      }),
      createImpact({
        eventId: missingEvidenceEvent.id,
        raceId: missingEvidenceRace.id,
        userId: user.user.id,
        status: "PENDING",
      }),
    ]);

    const before = await prisma.globalEventRaceImpact.findMany({ orderBy: { id: "asc" } });
    const report = await auditPendingV1Impacts(prisma);
    const repeated = await auditPendingV1Impacts(prisma);
    const after = await prisma.globalEventRaceImpact.findMany({ orderBy: { id: "asc" } });

    assert.deepEqual(report.counts, {
      total: 4,
      activeRace: 1,
      completedRace: 2,
      cancelledRace: 1,
      otherRaceStatus: 0,
      missingSettlementEvidence: 1,
      terminalOnlyGroups: 2,
    });
    assert.match(report.digest, /^[a-f0-9]{64}$/);
    assert.equal(report.databaseReadOnly, true);
    assert.equal(repeated.digest, report.digest);
    assert.deepEqual(after, before);
  });
});
