const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  processDueEntitlementBoundaries,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const {
  buildGlobalEventSummaryTick,
  nextSummaryDueAt,
} = require("../../src/modules/steps/jobs/globalEventSummary");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");
const {
  acquireRaceWriteFence,
} = require("../../src/modules/races/services/raceWriteFence");
const {
  lockEligibleSummaryCaptureDependencies,
  persistCapturedSummaryImpactsForRace,
} = require("../../src/modules/steps/services/globalEventSummaryCapture");
const {
  buildRecordStepSyncV2,
} = require("../../src/modules/steps/commands/recordStepSyncV2");

const CAPABILITIES = "impact_summaries,impact_summary_expiry_v1";
let server;

async function createEvent({ startsAt, endsAt } = {}) {
  const now = Date.now();
  return prisma.globalStepEvent.create({
    data: {
      startsAt: startsAt || new Date(now - 2 * 60 * 60 * 1000),
      endsAt: endsAt || new Date(now - 60 * 60 * 1000),
      multiplier: 2,
      summaryAttributionVersion: 2,
    },
  });
}

async function createRace(user, suffix = "expiry") {
  const race = await prisma.race.create({
    data: {
      creatorId: user.user.id,
      name: `Global summary ${suffix}`,
      targetSteps: 10_000,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    },
  });
  await prisma.raceParticipant.create({
    data: { raceId: race.id, userId: user.user.id, status: "ACCEPTED" },
  });
  return race;
}

async function seedDeliverable({ user, expiresAt, attributionVersion = 2 }) {
  const event = await createEvent();
  const race = await createRace(user);
  await prisma.globalEventRaceImpact.create({
    data: {
      eventId: event.id,
      raceId: race.id,
      userId: user.user.id,
      status: "FINAL",
      deltaSteps: 1500,
      attributionVersion,
      settledAt: new Date(),
    },
  });
  const summary = await prisma.globalEventUserSummary.create({
    data: {
      eventId: event.id,
      userId: user.user.id,
      extraRaceSteps: 1500,
      raceCount: 1,
      attributionVersion,
      expiresAt,
      settledAt: new Date(),
    },
  });
  return { event, race, summary };
}

async function home(user, features = CAPABILITIES) {
  return request(server.baseUrl, "GET", "/home/race-card", {
    token: user.token,
    headers: { "X-Client-Features": features },
  });
}

async function waitForDatabaseBlock(blockedPid, blockerPid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT wait_event_type AS "waitEventType",
              pg_blocking_pids($1::integer) AS "blockingPids"
         FROM pg_stat_activity
        WHERE pid=$1::integer`,
      blockedPid,
    );
    if (row?.waitEventType === "Lock" && row.blockingPids.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${blockedPid} was not blocked by backend ${blockerPid}`);
}

describe("global event summary expiry v2 HTTP contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["apiImpactSummariesEnabled", true],
      ["redisCacheHomeImpactSummaryEnabled", false],
    ]);
  });

  it("selects summary capture eligibility and event definitions in one real SQL query", async () => {
    const cutoff = new Date("2026-09-02T12:00:00.000Z");
    const later = new Date("2026-09-03T12:00:00.000Z");
    const activeStatuses = ["QUEUED", "PROCESSING", "WAITING_RACES"];

    for (const status of activeStatuses) {
      const user = await createTestUser();
      const event = await createEvent({
        startsAt: new Date("2026-09-01T10:00:00.000Z"),
        endsAt: new Date("2026-09-02T10:00:00.000Z"),
      });
      const active = await prisma.globalEventSummaryWork.create({
        data: { eventId: event.id, userId: user.user.id, status, expiresAt: later },
      });
      const dependencies = await prisma.$transaction((tx) =>
        lockEligibleSummaryCaptureDependencies(tx, { userId: user.user.id, at: cutoff }));
      assert.equal(dependencies.activeWork.id, active.id);
      assert.equal(dependencies.activeWork.status, status);
      assert.deepEqual(dependencies.works, []);
    }

    const user = await createTestUser();
    const earlyEvent = await createEvent({
      startsAt: new Date("2026-09-01T08:00:00.000Z"),
      endsAt: new Date("2026-09-02T09:00:00.000Z"),
    });
    const lateEvent = await createEvent({
      startsAt: new Date("2026-09-01T09:00:00.000Z"),
      endsAt: cutoff,
    });
    const v1Event = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date("2026-09-01T07:00:00.000Z"),
        endsAt: new Date("2026-09-02T08:00:00.000Z"),
        multiplier: 3,
        summaryAttributionVersion: 1,
      },
    });
    const early = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: earlyEvent.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date("2026-09-03T10:00:00.000Z"),
      },
    });
    const late = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: lateEvent.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt: later,
      },
    });
    await prisma.globalEventSummaryWork.createMany({
      data: [
        {
          eventId: v1Event.id,
          userId: user.user.id,
          status: "WAITING_SYNC",
          expiresAt: later,
        },
        {
          eventId: (await createEvent({ endsAt: cutoff })).id,
          userId: user.user.id,
          status: "WAITING_SYNC",
          expiresAt: cutoff,
        },
        {
          eventId: (await createEvent({ endsAt: new Date(cutoff.getTime() + 1) })).id,
          userId: user.user.id,
          status: "WAITING_SYNC",
          expiresAt: later,
        },
      ],
    });

    const dependencies = await prisma.$transaction((tx) =>
      lockEligibleSummaryCaptureDependencies(tx, { userId: user.user.id, at: cutoff }));
    assert.equal(dependencies.activeWork, null);
    assert.deepEqual(dependencies.works.map((work) => work.id), [early.id, late.id]);
    assert.deepEqual(dependencies.works.map((work) => work.event.id), [earlyEvent.id, lateEvent.id]);
    assert.deepEqual(dependencies.works.map((work) => work.event.startsAt), [
      earlyEvent.startsAt,
      lateEvent.startsAt,
    ]);
    assert.deepEqual(dependencies.works.map((work) => work.event.endsAt), [
      earlyEvent.endsAt,
      lateEvent.endsAt,
    ]);
    assert.deepEqual(dependencies.works.map((work) => work.event.multiplier), [2, 2]);
    assert.deepEqual(dependencies.works.map((work) => work.event.summaryAttributionVersion), [2, 2]);
  });

  it("gates v2 summaries on both capabilities and returns exact expiry metadata", async () => {
    const user = await createTestUser();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const { summary, event } = await seedDeliverable({ user, expiresAt });

    for (const features of ["", "impact_summaries", "impact_summary_expiry_v1"]) {
      const response = await home(user, features);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).globalEventSummary, undefined);
    }

    const response = await home(user);
    assert.equal(response.status, 200);
    const body = (await response.json()).globalEventSummary;
    assert.equal(body.id, summary.id);
    assert.equal(body.eventId, event.id);
    assert.equal(body.extraRaceSteps, 1500);
    assert.equal(body.raceCount, 1);
    assert.equal(body.expiresAt, expiresAt.toISOString());
    assert.ok(Number.isInteger(body.validForMs));
    assert.ok(body.validForMs > 0 && body.validForMs <= 30 * 60 * 1000);
  });

  it("omits expired, null-expiry, and attribution-v1 summaries", async () => {
    for (const fixture of [
      { expiresAt: new Date(Date.now() - 1), attributionVersion: 2 },
      { expiresAt: null, attributionVersion: 2 },
      { expiresAt: new Date(Date.now() + 60_000), attributionVersion: 1 },
    ]) {
      await cleanDatabase();
      const user = await createTestUser();
      await seedDeliverable({ user, ...fixture });
      assert.equal((await (await home(user)).json()).globalEventSummary, undefined);
    }
  });

  it("serves owner-only work state and hides absent, foreign, and incapable requests", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const event = await createEvent();
    const expiresAt = new Date(Date.now() + 60_000);
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        status: "WAITING_RACES",
        expiresAt,
      },
    });

    const owned = await request(
      server.baseUrl,
      "GET",
      `/home/global-event-summary-work/${work.id}`,
      { token: owner.token, headers: { "X-Client-Features": CAPABILITIES } },
    );
    assert.equal(owned.status, 200);
    assert.deepEqual(await owned.json(), {
      state: "WAITING_RACES",
      expiresAt: expiresAt.toISOString(),
    });

    for (const testCase of [
      { id: work.id, token: other.token, features: CAPABILITIES },
      { id: randomUUID(), token: owner.token, features: CAPABILITIES },
      { id: work.id, token: owner.token, features: "impact_summaries" },
    ]) {
      const response = await request(
        server.baseUrl,
        "GET",
        `/home/global-event-summary-work/${testCase.id}`,
        { token: testCase.token, headers: { "X-Client-Features": testCase.features } },
      );
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "NOT_FOUND");
    }

    const malformed = await request(
      server.baseUrl,
      "GET",
      "/home/global-event-summary-work/not-a-uuid",
      { token: owner.token, headers: { "X-Client-Features": CAPABILITIES } },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_ID");

    const unauthenticated = await request(
      server.baseUrl,
      "GET",
      `/home/global-event-summary-work/${work.id}`,
      { headers: { "X-Client-Features": CAPABILITIES } },
    );
    assert.equal(unauthenticated.status, 401);
  });

  it("reports active work as expired immediately after its authoritative deadline", async () => {
    const owner = await createTestUser();
    const event = await createEvent();
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        status: "WAITING_RACES",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await request(
      server.baseUrl,
      "GET",
      `/home/global-event-summary-work/${work.id}`,
      { token: owner.token, headers: { "X-Client-Features": CAPABILITIES } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      state: "EXPIRED_UNDELIVERED",
      expiresAt: work.expiresAt.toISOString(),
    });
  });

  it("claims ready summary work once with a token-fenced database lease", async () => {
    const owner = await createTestUser();
    const event = await createEvent();
    const race = await createRace(owner, "summary-lease");
    const expiresAt = new Date(Date.now() + 60_000);
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        status: "WAITING_RACES",
        expiresAt,
        requiredRaceCount: 1,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: owner.user.id,
        status: "FINAL",
        deltaSteps: 40,
        attributionVersion: 2,
        settledAt: new Date(),
      },
    });

    const tickA = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
    const tickB = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
    const results = await Promise.all([tickA(), tickB()]);
    assert.equal(results.reduce((sum, result) => sum + result.upserts, 0), 1);

    const finalWork = await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { id: work.id },
    });
    assert.equal(finalWork.status, "CREATED");
    assert.equal(finalWork.attemptCount, 1);
    assert.equal(finalWork.leaseToken, null);
    assert.equal(finalWork.leaseUntil, null);
    assert.equal(await prisma.jobRun.count({
      where: { jobName: `global_event_summary:${event.id}:${owner.user.id}:v2` },
    }), 1);
  });

  it("exact-due lookup respects a live WAITING_RACES lease after a budget skip", async () => {
    const owner = await createTestUser();
    const event = await createEvent();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 15_000);
    await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        status: "WAITING_RACES",
        availableAt: new Date(now.getTime() - 60_000),
        readyAt: new Date(now.getTime() - 60_000),
        expiresAt: new Date(now.getTime() + 60_000),
        leaseToken: randomUUID(),
        leaseUntil,
      },
    });
    const dueAt = await nextSummaryDueAt(prisma);
    assert.equal(dueAt.toISOString(), leaseUntil.toISOString());
    assert.ok(dueAt > now);
  });

  it("promotes pending old-worker rows but fails a final v1 row closed for a v2 event", async () => {
    for (const status of ["PENDING", "FINAL"]) {
      await cleanDatabase();
      const owner = await createTestUser();
      const now = new Date();
      const startsAt = new Date(now.getTime() - 30_000);
      const endsAt = new Date(now.getTime() - 20_000);
      const event = await createEvent({ startsAt, endsAt });
      const race = await createRace(owner, `mixed-worker-${status}`);
      await prisma.globalStepEventEntitlement.create({
        data: {
          eventId: event.id,
          userId: owner.user.id,
          timezone: "UTC",
          localDate: startsAt.toISOString().slice(0, 10),
          startsAt,
          endsAt,
          startOutcome: "ACTIVATED_ON_TIME",
          startProcessedAt: startsAt,
        },
      });
      await prisma.globalEventRaceImpact.create({
        data: {
          eventId: event.id,
          raceId: race.id,
          userId: owner.user.id,
          status,
          deltaSteps: status === "FINAL" ? 25 : 0,
          attributionVersion: 1,
          ...(status === "FINAL" ? { settledAt: endsAt } : {}),
        },
      });

      await buildGlobalEventSummaryTick({ prisma, now: () => now })();
      const impact = await prisma.globalEventRaceImpact.findUniqueOrThrow({
        where: {
          eventId_raceId_userId: {
            eventId: event.id,
            raceId: race.id,
            userId: owner.user.id,
          },
        },
      });
      const work = await prisma.globalEventSummaryWork.findUniqueOrThrow({
        where: { eventId_userId: { eventId: event.id, userId: owner.user.id } },
      });
      if (status === "PENDING") {
        assert.equal(impact.attributionVersion, 1,
          "scheduler discovery must not promote outside the fenced capture transaction");
        assert.equal(work.status, "WAITING_SYNC");
        const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
          token: owner.token,
          headers: {
            "Idempotency-Key": randomUUID(),
            "X-Timezone": "UTC",
            "X-Client-Features": CAPABILITIES,
          },
          body: {
            date: startsAt.toISOString().slice(0, 10),
            steps: 25,
            samples: [{
              periodStart: startsAt.toISOString(),
              periodEnd: endsAt.toISOString(),
              steps: 25,
              recordingMethod: "automatic",
            }],
          },
        });
        assert.equal(sync.status, 202);
        assert.equal((await prisma.globalEventRaceImpact.findUniqueOrThrow({
          where: {
            eventId_raceId_userId: {
              eventId: event.id,
              raceId: race.id,
              userId: owner.user.id,
            },
          },
        })).attributionVersion, 2);
      } else {
        assert.equal(impact.attributionVersion, 1);
        assert.equal(work.status, "UNSCORABLE");
        assert.equal(work.lastErrorCode, "DEPENDENCY_INPUT_UNREPLAYABLE");
        assert.equal(await prisma.globalEventUserSummary.count(), 0);
      }
    }
  });

  it("captures a late pending v1 race in the complete fenced vector", async () => {
    const owner = await createTestUser();
    const now = new Date();
    const startsAt = new Date(now.getTime() - 30_000);
    const endsAt = new Date(now.getTime() - 20_000);
    const event = await createEvent({ startsAt, endsAt });
    const firstRace = await createRace(owner, "late-pending-first");
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        timezone: "UTC",
        localDate: startsAt.toISOString().slice(0, 10),
        startsAt,
        endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: firstRace.id,
        userId: owner.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    await buildGlobalEventSummaryTick({ prisma, now: () => now })();

    const lateRace = await createRace(owner, "late-pending-v1");
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: lateRace.id,
        userId: owner.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });
    const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: owner.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: startsAt.toISOString().slice(0, 10),
        steps: 40,
        samples: [{
          periodStart: startsAt.toISOString(),
          periodEnd: endsAt.toISOString(),
          steps: 40,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(sync.status, 202);
    const vector = await prisma.globalEventRaceImpact.findMany({
      where: { eventId: event.id, userId: owner.user.id },
      orderBy: { raceId: "asc" },
    });
    assert.deepEqual(vector.map((row) => row.attributionVersion), [2, 2]);
    assert.equal(await prisma.globalEventCaptureArtifact.count({
      where: { eventId: event.id, userId: owner.user.id },
    }), 2);
    assert.equal((await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: owner.user.id } },
    })).requiredRaceCount, 2);
  });

  it("fails a ready work group closed if an old worker appends a late final v1 row", async () => {
    const owner = await createTestUser();
    const event = await createEvent();
    const [raceV2, lateRaceV1] = await Promise.all([
      createRace(owner, "complete-vector-v2"),
      createRace(owner, "complete-vector-v1"),
    ]);
    await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: owner.user.id,
        status: "WAITING_RACES",
        expiresAt: new Date(Date.now() + 60_000),
        requiredRaceCount: 1,
      },
    });
    await prisma.globalEventRaceImpact.createMany({ data: [
      {
        eventId: event.id,
        raceId: raceV2.id,
        userId: owner.user.id,
        status: "FINAL",
        deltaSteps: 100,
        attributionVersion: 2,
        settledAt: new Date(),
      },
      {
        eventId: event.id,
        raceId: lateRaceV1.id,
        userId: owner.user.id,
        status: "FINAL",
        deltaSteps: 500,
        attributionVersion: 1,
        settledAt: new Date(),
      },
    ] });

    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const work = await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: owner.user.id } },
    });
    assert.equal(work.status, "UNSCORABLE");
    assert.equal(work.lastErrorCode, "DEPENDENCY_INPUT_UNREPLAYABLE");
    assert.equal(await prisma.globalEventUserSummary.count(), 0);
  });

  it("keeps acknowledgement available with the legacy impact_summaries capability", async () => {
    const user = await createTestUser();
    const { summary } = await seedDeliverable({
      user,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const response = await request(
      server.baseUrl,
      "POST",
      `/home/global-event-summaries/${summary.id}/acknowledge`,
      { token: user.token, headers: { "X-Client-Features": "impact_summaries" } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { acknowledged: true });
  });

  it("finalizes active-race impact from the first post-boundary sync and creates one recap", async () => {
    const user = await createTestUser();
    const now = new Date();
    const startsAt = new Date(now.getTime() - 20_000);
    const endsAt = new Date(now.getTime() - 10_000);
    const localDate = startsAt.toISOString().slice(0, 10);
    const event = await createEvent({ startsAt, endsAt });
    const race = await createRace(user, "boundary");
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        timezone: "UTC",
        localDate,
        startsAt,
        endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });

    const boundary = await processDueEntitlementBoundaries({
      prisma,
      now,
      processStarts: false,
    });
    assert.equal(boundary.ends, 1);
    const waiting = await prisma.globalEventSummaryWork.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });
    assert.equal(waiting.status, "WAITING_SYNC");
    assert.equal((await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    })).attributionVersion, 1,
    "boundary discovery must not promote outside capture");

    const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: localDate,
        steps: 600,
        samples: [{
          periodStart: startsAt.toISOString(),
          periodEnd: endsAt.toISOString(),
          steps: 600,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(sync.status, 202);
    const receipt = (await sync.json()).globalEventSummaryWork;
    assert.deepEqual(receipt, {
      id: waiting.id,
      state: "QUEUED",
      expiresAt: waiting.expiresAt.toISOString(),
    });
    const firstArtifact = await prisma.globalEventCaptureArtifact.findFirstOrThrow({
      where: { workId: waiting.id },
    });

    const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
    assert.deepEqual(await tick(), { upserts: 0 });
    assert.equal((await prisma.globalEventRaceImpact.findUnique({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    })).status, "PENDING", "summary scheduler must not own the race C0 write");
    const later = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: localDate,
        steps: 900,
        samples: [{
          periodStart: startsAt.toISOString(),
          periodEnd: endsAt.toISOString(),
          steps: 900,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(later.status, 202);
    assert.deepEqual((await later.json()).globalEventSummaryWork, {
      id: waiting.id,
      state: "WAITING_RACES",
      expiresAt: waiting.expiresAt.toISOString(),
    });
    const retainedArtifact = await prisma.globalEventCaptureArtifact.findFirstOrThrow({
      where: { workId: waiting.id },
    });
    assert.equal(retainedArtifact.payloadDigest, firstArtifact.payloadDigest);
    assert.deepEqual(retainedArtifact.payload, firstArtifact.payload);

    const raceWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await raceWorker.processRace({ raceId: race.id }));
    assert.deepEqual(await tick(), { upserts: 1 });
    assert.deepEqual(await tick(), { upserts: 0 });
    const impact = await prisma.globalEventRaceImpact.findUnique({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(impact.status, "FINAL");
    assert.equal(impact.deltaSteps, 600);
    assert.equal(impact.captureKind, "POST_BOUNDARY_SYNC");
    assert.ok(impact.captureSyncRequestId);

    const response = await home(user);
    assert.equal(response.status, 200);
    const summary = (await response.json()).globalEventSummary;
    assert.equal(summary.extraRaceSteps, 600);
    assert.equal(summary.raceCount, 1);
  });

  it("captures cross-user Leech/Hitchhike inputs and attributes the whole-race counterfactual", async () => {
    const user = await createTestUser();
    const leecher = await createTestUser();
    const hitchTarget = await createTestUser();
    const now = new Date();
    const priorHour = Math.floor((now.getTime() - 62 * 60 * 1000) / 3_600_000) * 3_600_000;
    const startsAt = new Date(priorHour - 15 * 60 * 1000);
    const endsAt = new Date(priorHour + 15 * 60 * 1000);
    const event = await createEvent({ startsAt, endsAt });
    const race = await createRace(user, "leech-closure");
    await prisma.race.update({
      where: { id: race.id },
      data: { powerupsEnabled: true },
    });
    const sourceParticipant = await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: leecher.user.id, status: "ACCEPTED" },
    });
    const hitchTargetParticipant = await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: hitchTarget.user.id, status: "ACCEPTED" },
    });
    const targetParticipant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: user.user.id },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: sourceParticipant.id,
        userId: leecher.user.id,
        targetUserId: user.user.id,
        type: "LEECH",
        status: "USED",
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: targetParticipant.id,
        targetUserId: user.user.id,
        sourceUserId: leecher.user.id,
        powerupId: powerup.id,
        type: "LEECH",
        status: "ACTIVE",
        startsAt,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        metadata: { ratio: 2 },
      },
    });
    const hitchPowerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: targetParticipant.id,
        userId: user.user.id,
        targetUserId: hitchTarget.user.id,
        type: "HITCHHIKE",
        status: "USED",
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: hitchTargetParticipant.id,
        targetUserId: hitchTarget.user.id,
        sourceUserId: user.user.id,
        powerupId: hitchPowerup.id,
        type: "HITCHHIKE",
        status: "ACTIVE",
        startsAt,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        metadata: { copyRatio: 1, scoringVersion: 2 },
      },
    });
    const blockedPowerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: targetParticipant.id,
        userId: user.user.id,
        type: "RUNNERS_HIGH",
        status: "USED",
      },
    });
    const blockedEffect = await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: targetParticipant.id,
        targetUserId: user.user.id,
        sourceUserId: user.user.id,
        powerupId: blockedPowerup.id,
        type: "RUNNERS_HIGH",
        status: "BLOCKED",
        startsAt,
        expiresAt: endsAt,
        metadata: { multiplier: 2 },
      },
    });
    await prisma.stepSample.create({
      data: {
        userId: leecher.user.id,
        periodStart: startsAt,
        periodEnd: endsAt,
        steps: 500,
      },
    });
    await prisma.stepSample.create({
      data: {
        userId: hitchTarget.user.id,
        periodStart: startsAt,
        periodEnd: endsAt,
        steps: 200,
      },
    });
    await prisma.userScoringInputVersion.createMany({
      data: [leecher.user.id, hitchTarget.user.id].map((dependencyUserId) => ({
        userId: dependencyUserId,
        generation: 1n,
      })),
    });
    const localDate = startsAt.toISOString().slice(0, 10);
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        timezone: "UTC",
        localDate,
        startsAt,
        endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    await processDueEntitlementBoundaries({ prisma, now, processStarts: false });

    const [sync, dependencySync] = await Promise.all([
      request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: user.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps: 100,
          samples: [{
            periodStart: startsAt.toISOString(),
            periodEnd: endsAt.toISOString(),
            steps: 100,
            recordingMethod: "automatic",
          }],
        },
      }),
      request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: leecher.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps: 500,
          samples: [{
            periodStart: startsAt.toISOString(),
            periodEnd: endsAt.toISOString(),
            steps: 500,
            recordingMethod: "automatic",
          }],
        },
      }),
    ]);
    assert.equal(sync.status, 202);
    assert.equal(dependencySync.status, 202);
    const artifact = await prisma.globalEventCaptureArtifact.findFirstOrThrow({
      where: { eventId: event.id, raceId: race.id, userId: user.user.id },
    });
    assert.deepEqual(
      artifact.payload.participants.map((row) => row.userId).sort(),
      [user.user.id, leecher.user.id, hitchTarget.user.id].sort(),
    );
    assert.deepEqual(
      artifact.payload.dependencyInputGenerations.map((row) => row.userId).sort(),
      [user.user.id, leecher.user.id, hitchTarget.user.id].sort(),
      "the immutable artifact includes the uploader and every cross-user input generation",
    );
    assert.equal(artifact.payload.effects.some((row) => row.id === blockedEffect.id), false);
    assert.equal(artifact.payload.attributionDeltaSteps, 50,
      "Hitchhike credit is drainable before Leech, leaving only 50 event steps");

    const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
    assert.deepEqual(await tick(), { upserts: 0 });
    const raceWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await raceWorker.processRace({ raceId: race.id }));
    assert.deepEqual(await tick(), { upserts: 1 });
    const impact = await prisma.globalEventRaceImpact.findUnique({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(impact.status, "FINAL");
    assert.equal(impact.deltaSteps, 50);
    assert.equal((await prisma.globalEventSummaryWork.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    })).status, "CREATED");
  });

  it("uses the New York fallback deadline for version-2 legacy-global events", async () => {
    const user = await createTestUser();
    const now = new Date();
    const startsAt = new Date(now.getTime() - 20_000);
    const endsAt = new Date(now.getTime() - 10_000);
    const event = await createEvent({ startsAt, endsAt });
    const race = await createRace(user, "legacy-fallback");
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });

    const tick = buildGlobalEventSummaryTick({ prisma, now: () => now });
    assert.deepEqual(await tick(), { upserts: 0 });
    const waiting = await prisma.globalEventSummaryWork.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });
    assert.equal(waiting.status, "WAITING_SYNC");
    assert.equal((await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    })).attributionVersion, 1,
    "legacy-global discovery includes all attribution versions");
    const expiryParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(waiting.expiresAt);
    assert.equal(Number(expiryParts.find((part) => part.type === "hour").value), 0);

    const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "America/New_York",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: startsAt.toISOString().slice(0, 10),
        steps: 250,
        samples: [{
          periodStart: startsAt.toISOString(),
          periodEnd: endsAt.toISOString(),
          steps: 250,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(sync.status, 202);
    assert.equal((await sync.json()).globalEventSummaryWork.id, waiting.id);
    assert.equal((await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    })).attributionVersion, 2);
  });

  it("claims work on a qualifying scoring no-op sync with retained coverage", async () => {
    const user = await createTestUser();
    const sampleStart = new Date(Date.now() - 20 * 60 * 1000);
    const sampleEnd = new Date(Date.now() - 5 * 60 * 1000);
    const body = {
      date: sampleStart.toISOString().slice(0, 10),
      steps: 300,
      samples: [{
        periodStart: sampleStart.toISOString(),
        periodEnd: sampleEnd.toISOString(),
        steps: 300,
        recordingMethod: "automatic",
      }],
    };
    const first = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body,
    });
    assert.equal(first.status, 202);

    const event = await createEvent({
      startsAt: sampleStart,
      endsAt: new Date(sampleEnd.getTime() - 1_000),
    });
    const race = await createRace(user, "noop");
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });
    const expiresAt = new Date(Date.now() + 60_000);
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt,
        requiredRaceCount: 1,
      },
    });
    const generationBefore = await prisma.userScoringInputVersion.findUnique({
      where: { userId: user.user.id },
    });

    const second = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body,
    });
    assert.equal(second.status, 202);
    assert.deepEqual((await second.json()).globalEventSummaryWork, {
      id: work.id,
      state: "QUEUED",
      expiresAt: expiresAt.toISOString(),
    });
    const generationAfter = await prisma.userScoringInputVersion.findUnique({
      where: { userId: user.user.id },
    });
    assert.equal(generationAfter.generation, generationBefore.generation);
  });

  it("does not claim summary work that appears after the capture dependency closure is locked", async () => {
    const user = await createTestUser();
    const sampleStart = new Date(Date.now() - 20 * 60_000);
    const sampleEnd = new Date(Date.now() - 5 * 60_000);
    const body = {
      date: sampleStart.toISOString().slice(0, 10),
      steps: 300,
      samples: [{
        periodStart: sampleStart.toISOString(),
        periodEnd: sampleEnd.toISOString(),
        steps: 300,
        recordingMethod: "automatic",
      }],
    };
    const first = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body,
    });
    assert.equal(first.status, 202);

    const eventEndsAt = new Date(sampleEnd.getTime() - 1_000);
    const initialEvent = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const lateEvent = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const expiresAt = new Date(Date.now() + 60_000);
    const initialWork = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: initialEvent.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt,
      },
    });
    let signalClosureComplete;
    const closureComplete = new Promise((resolve) => { signalClosureComplete = resolve; });
    let releaseClosure;
    const released = new Promise((resolve) => { releaseClosure = resolve; });
    const recordStepSyncV2 = buildRecordStepSyncV2({
      prisma,
      lockEligibleSummaryCaptureDependencies: async (tx, args) => {
        const dependencies = await lockEligibleSummaryCaptureDependencies(tx, args);
        signalClosureComplete();
        await released;
        return dependencies;
      },
    });
    const isolatedServer = await startServer({ recordStepSyncV2 });

    let second;
    let secondPromise;
    try {
      secondPromise = request(isolatedServer.baseUrl, "POST", "/steps/sync-v2", {
        token: user.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body,
      });
      await closureComplete;
      const lateWork = await prisma.globalEventSummaryWork.create({
        data: {
          eventId: lateEvent.id,
          userId: user.user.id,
          status: "WAITING_SYNC",
          expiresAt,
        },
      });
      releaseClosure();
      second = await secondPromise;
      assert.equal((await prisma.globalEventSummaryWork.findUniqueOrThrow({
        where: { id: lateWork.id },
      })).status, "WAITING_SYNC");
    } finally {
      releaseClosure();
      await secondPromise?.catch(() => {});
      await isolatedServer.close();
    }
    assert.equal(second.status, 202);
    assert.equal((await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { id: initialWork.id },
    })).status, "QUEUED");
  });

  it("allows cross-race captures with a shared scoring dependency to proceed concurrently", async () => {
    const uploaderA = await createTestUser();
    const uploaderB = await createTestUser();
    const shared = await createTestUser();
    const now = new Date();
    const sampleStart = new Date(now.getTime() - 20 * 60_000);
    const eventEndsAt = new Date(now.getTime() - 5 * 60_000);
    const sampleEnd = new Date(now.getTime() - 60_000);
    const event = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const raceA = await createRace(uploaderA, "overlapping-lock-a");
    const raceB = await createRace(uploaderB, "overlapping-lock-b");
    await prisma.raceParticipant.createMany({
      data: [raceA.id, raceB.id].map((raceId) => ({
        raceId,
        userId: shared.user.id,
        status: "ACCEPTED",
      })),
    });

    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const localDate = sampleStart.toISOString().slice(0, 10);
    const workIdsByUserId = new Map();
    const raceByUserId = new Map([
      [uploaderA.user.id, raceA.id],
      [uploaderB.user.id, raceB.id],
    ]);
    for (const uploader of [uploaderA, uploaderB]) {
      await prisma.globalStepEventEntitlement.create({
        data: {
          eventId: event.id,
          userId: uploader.user.id,
          timezone: "UTC",
          localDate,
          startsAt: sampleStart,
          endsAt: eventEndsAt,
          startOutcome: "ACTIVATED_ON_TIME",
          startProcessedAt: sampleStart,
        },
      });
      await prisma.globalEventRaceImpact.create({
        data: {
          eventId: event.id,
          raceId: raceByUserId.get(uploader.user.id),
          userId: uploader.user.id,
          status: "PENDING",
          attributionVersion: 2,
        },
      });
      const work = await prisma.globalEventSummaryWork.create({
        data: {
          eventId: event.id,
          userId: uploader.user.id,
          status: "WAITING_SYNC",
          expiresAt,
          requiredRaceCount: 1,
        },
      });
      workIdsByUserId.set(uploader.user.id, work.id);
    }
    await prisma.userScoringInputVersion.createMany({
      data: [uploaderA.user.id, uploaderB.user.id, shared.user.id].map((userId) => ({
        userId,
        generation: 1n,
      })),
    });

    let signalFirstCaptureReady;
    const firstCaptureReady = new Promise((resolve) => { signalFirstCaptureReady = resolve; });
    let signalSecondCaptureReady;
    const secondCaptureReady = new Promise((resolve) => { signalSecondCaptureReady = resolve; });
    let releaseCapture;
    const released = new Promise((resolve) => { releaseCapture = resolve; });
    const recordStepSyncV2 = buildRecordStepSyncV2({
      prisma,
      lockEligibleSummaryCaptureDependencies: async (tx, args) => {
        const dependencies = await lockEligibleSummaryCaptureDependencies(tx, args);
        if (args.userId === uploaderA.user.id) {
          signalFirstCaptureReady();
          await released;
        } else if (args.userId === uploaderB.user.id) {
          signalSecondCaptureReady();
        }
        return dependencies;
      },
    });
    const isolatedServer = await startServer({ recordStepSyncV2 });
    const sync = (uploader, steps) => request(
      isolatedServer.baseUrl,
      "POST",
      "/steps/sync-v2",
      {
        token: uploader.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps,
          samples: [{
            periodStart: sampleStart.toISOString(),
            periodEnd: sampleEnd.toISOString(),
            steps,
            recordingMethod: "automatic",
          }],
        },
      },
    );

    let firstPromise;
    let secondPromise;
    try {
      firstPromise = sync(uploaderA, 300);
      let barrierTimeout;
      try {
        await Promise.race([
          firstCaptureReady,
          new Promise((_, reject) => {
            barrierTimeout = setTimeout(
              () => reject(new Error("first capture never reached the dependency-lock barrier")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(barrierTimeout);
      }
      secondPromise = sync(uploaderB, 500);

      let secondBarrierTimeout;
      try {
        await Promise.race([
          secondCaptureReady,
          new Promise((_, reject) => {
            secondBarrierTimeout = setTimeout(
              () => reject(new Error(
                "second capture remained serialized behind the first capture's shared dependency",
              )),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(secondBarrierTimeout);
      }

      releaseCapture();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      const artifacts = await prisma.globalEventCaptureArtifact.findMany({
        where: { eventId: event.id },
        select: { workId: true, userId: true, raceId: true },
        orderBy: { userId: "asc" },
      });
      assert.deepEqual(artifacts, [uploaderA, uploaderB]
        .map((uploader) => ({
          workId: workIdsByUserId.get(uploader.user.id),
          userId: uploader.user.id,
          raceId: raceByUserId.get(uploader.user.id),
        }))
        .sort((a, b) => a.userId.localeCompare(b.userId)));
      const samples = await prisma.stepSample.findMany({
        where: { userId: { in: [uploaderA.user.id, uploaderB.user.id] } },
        select: { userId: true, steps: true },
        orderBy: { userId: "asc" },
      });
      assert.deepEqual(samples, [
        { userId: uploaderA.user.id, steps: 300 },
        { userId: uploaderB.user.id, steps: 500 },
      ].sort((a, b) => a.userId.localeCompare(b.userId)));
      const works = await prisma.globalEventSummaryWork.findMany({
        where: { eventId: event.id },
        orderBy: { userId: "asc" },
      });
      assert.deepEqual(works.map((work) => work.status), ["QUEUED", "QUEUED"]);
    } finally {
      releaseCapture();
      await Promise.allSettled([firstPromise, secondPromise].filter(Boolean));
      await isolatedServer.close();
    }
  });

  it("keeps uploader-before-C0 ordering with a rolling old capture", async () => {
    const uploader = await createTestUser();
    const now = new Date();
    const sampleStart = new Date(now.getTime() - 20 * 60_000);
    const eventEndsAt = new Date(now.getTime() - 5 * 60_000);
    const sampleEnd = new Date(now.getTime() - 60_000);
    const localDate = sampleStart.toISOString().slice(0, 10);
    const event = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const race = await createRace(uploader, "mixed-worker-lock-order");
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        timezone: "UTC",
        localDate,
        startsAt: sampleStart,
        endsAt: eventEndsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: sampleStart,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: uploader.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        requiredRaceCount: 1,
      },
    });
    await prisma.userScoringInputVersion.create({
      data: { userId: uploader.user.id, generation: 1n },
    });

    let signalOldRowLocked;
    const oldRowLocked = new Promise((resolve) => { signalOldRowLocked = resolve; });
    let allowOldRaceFence;
    const oldRaceFenceAllowed = new Promise((resolve) => { allowOldRaceFence = resolve; });
    let oldPid;
    const oldCapture = prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRawUnsafe("SELECT pg_backend_pid() AS pid");
      oldPid = pid;
      await tx.$queryRawUnsafe(
        `SELECT user_id FROM user_scoring_input_versions
          WHERE user_id=$1 FOR UPDATE`,
        uploader.user.id,
      );
      signalOldRowLocked();
      await oldRaceFenceAllowed;
      await acquireRaceWriteFence(tx, race.id);
    }, { timeout: 15_000, maxWait: 15_000 });
    await oldRowLocked;

    let signalNewPid;
    const newPidReady = new Promise((resolve) => { signalNewPid = resolve; });
    const recordStepSyncV2 = buildRecordStepSyncV2({
      prisma,
      lockEligibleSummaryCaptureDependencies: async (tx, args) => {
        const [{ pid }] = await tx.$queryRawUnsafe("SELECT pg_backend_pid() AS pid");
        signalNewPid(pid);
        return lockEligibleSummaryCaptureDependencies(tx, args);
      },
    });
    const isolatedServer = await startServer({ recordStepSyncV2 });
    let syncPromise;
    try {
      syncPromise = request(isolatedServer.baseUrl, "POST", "/steps/sync-v2", {
        token: uploader.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps: 300,
          samples: [{
            periodStart: sampleStart.toISOString(),
            periodEnd: sampleEnd.toISOString(),
            steps: 300,
            recordingMethod: "automatic",
          }],
        },
      });
      const newPid = await newPidReady;
      await waitForDatabaseBlock(newPid, oldPid);

      // An old worker/current writer already owns the scoring row. It must be
      // able to take C0 and commit; the new capture cannot own C0 while it waits.
      allowOldRaceFence();
      await oldCapture;
      const sync = await syncPromise;
      assert.equal(sync.status, 202);
      assert.equal((await prisma.globalEventSummaryWork.findUniqueOrThrow({
        where: { id: work.id },
      })).status, "QUEUED");
    } finally {
      allowOldRaceFence();
      await oldCapture.catch(() => {});
      await syncPromise?.catch(() => {});
      await isolatedServer.close();
    }
  });

  it("materializes and captures a missing dependency generation witness", async () => {
    const uploader = await createTestUser();
    const dependency = await createTestUser();
    const now = new Date();
    const sampleStart = new Date(now.getTime() - 20 * 60_000);
    const eventEndsAt = new Date(now.getTime() - 5 * 60_000);
    const sampleEnd = new Date(now.getTime() - 60_000);
    const localDate = sampleStart.toISOString().slice(0, 10);
    const event = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const race = await createRace(uploader, "missing-generation-witness");
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: dependency.user.id, status: "ACCEPTED" },
    });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        timezone: "UTC",
        localDate,
        startsAt: sampleStart,
        endsAt: eventEndsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: sampleStart,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: uploader.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        requiredRaceCount: 1,
      },
    });
    assert.equal(await prisma.userScoringInputVersion.count({
      where: { userId: { in: [uploader.user.id, dependency.user.id] } },
    }), 0);

    const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: uploader.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: localDate,
        steps: 300,
        samples: [{
          periodStart: sampleStart.toISOString(),
          periodEnd: sampleEnd.toISOString(),
          steps: 300,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(sync.status, 202);
    const artifact = await prisma.globalEventCaptureArtifact.findFirstOrThrow({
      where: { workId: work.id, raceId: race.id, userId: uploader.user.id },
    });
    assert.deepEqual(artifact.payload.dependencyInputGenerations, [
      { userId: uploader.user.id, generation: "2" },
      { userId: dependency.user.id, generation: "1" },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
    const versions = await prisma.userScoringInputVersion.findMany({
      where: { userId: { in: [uploader.user.id, dependency.user.id] } },
      select: { userId: true, generation: true },
      orderBy: { userId: "asc" },
    });
    assert.deepEqual(versions, [
      { userId: uploader.user.id, generation: 2n },
      { userId: dependency.user.id, generation: 1n },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
  });

  it("terminalizes capture when the uploader is no longer an accepted participant", async () => {
    const uploader = await createTestUser();
    const survivor = await createTestUser();
    const now = new Date();
    const startsAt = new Date(now.getTime() - 20 * 60_000);
    const endsAt = new Date(now.getTime() - 5 * 60_000);
    const localDate = startsAt.toISOString().slice(0, 10);
    const event = await createEvent({ startsAt, endsAt });
    const race = await createRace(uploader, "departed-uploader");
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: survivor.user.id, status: "ACCEPTED" },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: uploader.user.id } },
      data: { status: "DECLINED" },
    });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        timezone: "UTC",
        localDate,
        startsAt,
        endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: uploader.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        requiredRaceCount: 1,
      },
    });

    const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: uploader.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: localDate,
        steps: 300,
        samples: [{
          periodStart: startsAt.toISOString(),
          periodEnd: endsAt.toISOString(),
          steps: 300,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(sync.status, 202);
    const terminal = await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { id: work.id },
    });
    assert.equal(terminal.status, "UNSCORABLE");
    assert.equal(terminal.lastErrorCode, "PARTICIPANT_STATE_UNREPLAYABLE");
    assert.equal(await prisma.globalEventCaptureArtifact.count({
      where: { workId: work.id },
    }), 0);
  });

  it("captures one committed dependency snapshot without waiting for an uncommitted newer input", async () => {
    const uploader = await createTestUser();
    const dependency = await createTestUser();
    const now = new Date();
    const sampleStart = new Date(now.getTime() - 20 * 60_000);
    const eventEndsAt = new Date(now.getTime() - 5 * 60_000);
    const sampleEnd = new Date(now.getTime() - 60_000);
    const localDate = sampleStart.toISOString().slice(0, 10);
    const event = await createEvent({ startsAt: sampleStart, endsAt: eventEndsAt });
    const race = await createRace(uploader, "dependency-snapshot");
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: dependency.user.id, status: "ACCEPTED" },
    });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        timezone: "UTC",
        localDate,
        startsAt: sampleStart,
        endsAt: eventEndsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: sampleStart,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: uploader.user.id,
        status: "PENDING",
        attributionVersion: 2,
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: uploader.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        requiredRaceCount: 1,
      },
    });
    const dependencySample = await prisma.stepSample.create({
      data: {
        userId: dependency.user.id,
        periodStart: sampleStart,
        periodEnd: sampleEnd,
        steps: 100,
      },
    });
    await prisma.userScoringInputVersion.createMany({
      data: [uploader.user.id, dependency.user.id].map((userId) => ({
        userId,
        generation: 1n,
      })),
    });

    let signalWriterReady;
    const writerReady = new Promise((resolve) => { signalWriterReady = resolve; });
    let releaseWriter;
    const writerReleased = new Promise((resolve) => { releaseWriter = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      await tx.stepSample.update({
        where: { id: dependencySample.id },
        data: { steps: 900 },
      });
      await tx.userScoringInputVersion.update({
        where: { userId: dependency.user.id },
        data: { generation: { increment: 1 } },
      });
      signalWriterReady();
      await writerReleased;
    }, { timeout: 15_000, maxWait: 15_000 });
    await writerReady;

    let syncPromise;
    try {
      syncPromise = request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: uploader.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps: 300,
          samples: [{
            periodStart: sampleStart.toISOString(),
            periodEnd: sampleEnd.toISOString(),
            steps: 300,
            recordingMethod: "automatic",
          }],
        },
      });
      let completionTimeout;
      let sync;
      try {
        sync = await Promise.race([
          syncPromise,
          new Promise((_, reject) => {
            completionTimeout = setTimeout(
              () => reject(new Error("capture waited for an uncommitted dependency update")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(completionTimeout);
      }
      assert.equal(sync.status, 202);
      const artifact = await prisma.globalEventCaptureArtifact.findFirstOrThrow({
        where: { workId: work.id, raceId: race.id, userId: uploader.user.id },
      });
      assert.equal(artifact.payload.samples.find(
        (sample) => sample.userId === dependency.user.id,
      ).steps, 100);
      assert.equal(artifact.payload.dependencyInputGenerations.find(
        (version) => version.userId === dependency.user.id,
      ).generation, "1");
    } finally {
      releaseWriter();
      await writer;
      await syncPromise?.catch(() => {});
    }
    assert.equal((await prisma.stepSample.findUniqueOrThrow({
      where: { id: dependencySample.id },
    })).steps, 900);
    assert.equal((await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: dependency.user.id },
    })).generation, 2n);
  });

  it("deletes capture artifacts and work before deleting the owning account", async () => {
    const user = await createTestUser();
    const event = await createEvent();
    const race = await createRace(user, "account-delete");
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        status: "WAITING_RACES",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.globalEventCaptureArtifact.create({
      data: {
        workId: work.id,
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        captureSyncRequestId: randomUUID(),
        captureCompletedAt: new Date(),
        captureCoverageThrough: new Date(),
        sourceScoringInputGeneration: 1n,
        payload: { schemaVersion: 1 },
        payloadDigest: "0".repeat(64),
      },
    });

    const response = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: user.token,
    });
    assert.equal(response.status, 204);
    assert.equal(await prisma.globalEventSummaryWork.count({ where: { id: work.id } }), 0);
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: work.id } }), 0);
  });

  it("permanently expires work when no qualifying sync arrives before the deadline", async () => {
    const user = await createTestUser();
    const event = await createEvent();
    const race = await createRace(user, "no-sync");
    const expiresAt = new Date(Date.now() - 1_000);
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });
    await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt,
        requiredRaceCount: 1,
      },
    });

    const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
    assert.deepEqual(await tick(), { upserts: 0 });
    const work = await prisma.globalEventSummaryWork.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });
    const impact = await prisma.globalEventRaceImpact.findUnique({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(work.status, "EXPIRED_UNDELIVERED");
    assert.equal(impact.status, "PENDING");
    const raceWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await raceWorker.processRace({ raceId: race.id }));
    const terminalImpact = await prisma.globalEventRaceImpact.findUnique({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(terminalImpact.status, "EXPIRED_UNDELIVERED");
    assert.equal(terminalImpact.attributionVersion, 2,
      "terminal C0 cleanup consumes every pending attribution version");
    assert.equal(
      await prisma.globalEventUserSummary.count({
        where: { eventId: event.id, userId: user.user.id },
      }),
      0,
    );
  });

  it("reconciles captured impacts through the same C0 path for completed and cancelled races", async () => {
    for (const raceStatus of ["COMPLETED", "CANCELLED"]) {
      await cleanDatabase();
      const user = await createTestUser();
      const now = new Date();
      const startsAt = new Date(now.getTime() - 20_000);
      const endsAt = new Date(now.getTime() - 10_000);
      const localDate = startsAt.toISOString().slice(0, 10);
      const event = await createEvent({ startsAt, endsAt });
      const race = await createRace(user, `terminal-${raceStatus}`);
      await prisma.race.update({
        where: { id: race.id },
        data: {
          status: raceStatus,
          ...(raceStatus === "COMPLETED" ? { completedAt: endsAt } : {}),
        },
      });
      await prisma.globalStepEventEntitlement.create({
        data: {
          eventId: event.id,
          userId: user.user.id,
          timezone: "UTC",
          localDate,
          startsAt,
          endsAt,
          startOutcome: "ACTIVATED_ON_TIME",
          startProcessedAt: startsAt,
        },
      });
      await prisma.globalEventRaceImpact.create({
        data: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
          status: "PENDING",
          attributionVersion: 2,
        },
      });
      await processDueEntitlementBoundaries({ prisma, now, processStarts: false });
      const sync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: user.token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: localDate,
          steps: 300,
          samples: [{
            periodStart: startsAt.toISOString(),
            periodEnd: endsAt.toISOString(),
            steps: 300,
            recordingMethod: "automatic",
          }],
        },
      });
      assert.equal(sync.status, 202);
      const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
      assert.deepEqual(await tick(), { upserts: 0 });
      const worker = buildRaceResolutionWorkerV2({
        bootAt: 0,
        logger: { log() {}, error() {} },
      });
      assert.ok(await worker.processRace({ raceId: race.id }));
      assert.deepEqual(await tick(), { upserts: 1 });
      const impact = await prisma.globalEventRaceImpact.findUniqueOrThrow({
        where: {
          eventId_raceId_userId: {
            eventId: event.id,
            raceId: race.id,
            userId: user.user.id,
          },
        },
      });
      assert.equal(impact.status, "FINAL");
      assert.equal(impact.deltaSteps, 300);
    }
  });

  it("suppresses an all-zero vector but delivers a mixed nonzero net-zero vector", async () => {
    for (const vector of [[0, 0], [100, -100]]) {
      await cleanDatabase();
      const user = await createTestUser();
      const event = await createEvent();
      const races = await Promise.all([
        createRace(user, `${vector[0]}-a`),
        createRace(user, `${vector[1]}-b`),
      ]);
      await prisma.globalEventRaceImpact.createMany({
        data: races.map((race, index) => ({
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
          status: "FINAL",
          deltaSteps: vector[index],
          attributionVersion: 2,
          settledAt: new Date(),
        })),
      });
      await prisma.globalEventSummaryWork.create({
        data: {
          eventId: event.id,
          userId: user.user.id,
          status: "WAITING_RACES",
          expiresAt: new Date(Date.now() + 60_000),
          requiredRaceCount: races.length,
          finalRaceCount: races.length,
        },
      });

      const tick = buildGlobalEventSummaryTick({ prisma, now: () => new Date() });
      assert.deepEqual(await tick(), { upserts: vector[0] === 0 ? 0 : 1 });
      const work = await prisma.globalEventSummaryWork.findUnique({
        where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
      });
      const summary = await prisma.globalEventUserSummary.findUnique({
        where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
      });
      if (vector[0] === 0) {
        assert.equal(work.status, "ALL_ZERO");
        assert.equal(summary, null);
      } else {
        assert.equal(work.status, "CREATED");
        assert.equal(summary.extraRaceSteps, 0);
        assert.equal(summary.raceCount, 2);
      }
    }
  });

  it("serializes the terminal summary against a rolling old-worker impact insert", async () => {
    const user = await createTestUser();
    const event = await createEvent();
    const capturedRace = await createRace(user, "atomic-vector-captured");
    const lateRace = await createRace(user, "atomic-vector-late");
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: capturedRace.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: 80,
        attributionVersion: 2,
        settledAt: new Date(),
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        status: "WAITING_RACES",
        expiresAt: new Date(Date.now() + 60_000),
        requiredRaceCount: 1,
        finalRaceCount: 1,
      },
    });

    let signalWorkLocked;
    const workLocked = new Promise((resolve) => { signalWorkLocked = resolve; });
    let releaseWorkLock;
    const holdWorkLock = new Promise((resolve) => { releaseWorkLock = resolve; });
    const tick = buildGlobalEventSummaryTick({
      prisma,
      now: () => new Date(),
      afterSummaryWorkLock: async (lockedWork) => {
        assert.equal(lockedWork.id, work.id);
        signalWorkLocked();
        await holdWorkLock;
      },
    });
    const tickPromise = tick();
    await Promise.race([
      workLocked,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("summary work row was not locked")),
        1_000,
      )),
    ]);

    const lateInsert = prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: lateRace.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: 900,
        attributionVersion: 1,
        settledAt: new Date(),
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseWorkLock();

    assert.deepEqual(await tickPromise, { upserts: 1 });
    await assert.rejects(lateInsert, (error) => {
      const codes = [
        error?.code,
        error?.meta?.code,
        error?.meta?.driverAdapterError?.cause?.originalCode,
        error?.meta?.driverAdapterError?.cause?.code,
        error?.cause?.originalCode,
        error?.cause?.code,
      ];
      return codes.includes("40001") ||
        String(error?.message || "").includes("GLOBAL_EVENT_SUMMARY_VECTOR_FENCED");
    });
    assert.equal(await prisma.globalEventRaceImpact.count({
      where: { eventId: event.id, userId: user.user.id },
    }), 1);
    const summary = await prisma.globalEventUserSummary.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.user.id } },
    });
    assert.equal(summary.extraRaceSteps, 80);
    assert.equal(summary.raceCount, 1);
  });

  it("expires summary work concurrently with its running C0 post-task without deadlock", async () => {
    const user = await createTestUser();
    const event = await createEvent();
    const race = await createRace(user, "expiry-c0-overlap");
    const impact = await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });
    const work = await prisma.globalEventSummaryWork.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(Date.now() - 1_000),
        requiredRaceCount: 1,
      },
    });

    let signalC0Held;
    const c0Held = new Promise((resolve) => { signalC0Held = resolve; });
    let signalTransitioned;
    const transitioned = new Promise((resolve) => { signalTransitioned = resolve; });
    const postTask = prisma.$transaction(async (tx) => {
      await acquireRaceWriteFence(tx, race.id);
      signalC0Held();
      await transitioned;
      return persistCapturedSummaryImpactsForRace(tx, {
        raceId: race.id,
        sourceResolutionGeneration: 1,
        now: new Date(),
      });
    }, { timeout: 5_000, maxWait: 5_000 });
    await c0Held;

    const tick = buildGlobalEventSummaryTick({
      prisma,
      now: () => new Date(),
      afterSummaryWorkTransition: async (transitionedWork) => {
        assert.equal(transitionedWork.id, work.id);
        signalTransitioned();
      },
    });
    const [tickResult, postTaskResult] = await Promise.race([
      Promise.all([tick(), postTask]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("summary expiry and C0 post-task deadlocked")),
        2_000,
      )),
    ]);
    assert.deepEqual(tickResult, { upserts: 0 });
    assert.equal(postTaskResult.terminalized, 1);
    assert.equal((await prisma.globalEventSummaryWork.findUniqueOrThrow({
      where: { id: work.id },
    })).status, "EXPIRED_UNDELIVERED");
    const terminalImpact = await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: { id: impact.id },
    });
    assert.equal(terminalImpact.status, "EXPIRED_UNDELIVERED");
    assert.equal(terminalImpact.attributionVersion, 2);
  });

  it("race expiry skips every v2-summary impact write but retains v1 settlement", async () => {
    for (const mode of ["MISSING", "PENDING_V1"]) {
      await cleanDatabase();
      const user = await createTestUser();
      const now = new Date();
      const race = await prisma.race.create({
        data: {
          creatorId: user.user.id,
          name: `v2 expiry ${mode}`,
          targetSteps: 10_000,
          status: "ACTIVE",
          startedAt: new Date(now.getTime() - 60_000),
          endsAt: new Date(now.getTime() - 1_000),
        },
      });
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: user.user.id,
          status: "ACCEPTED",
          joinedAt: race.startedAt,
        },
      });
      const event = await prisma.globalStepEvent.create({
        data: {
          startsAt: new Date(now.getTime() - 50_000),
          endsAt: new Date(now.getTime() - 10_000),
          multiplier: 2,
          summaryAttributionVersion: 2,
        },
      });
      if (mode === "PENDING_V1") {
        await prisma.globalEventRaceImpact.create({
          data: {
            eventId: event.id,
            raceId: race.id,
            userId: user.user.id,
            status: "PENDING",
            attributionVersion: 1,
          },
        });
      }
      await prisma.globalEventSummaryWork.create({
        data: {
          eventId: event.id,
          userId: user.user.id,
          status: "UNSCORABLE",
          expiresAt: new Date(now.getTime() + 60_000),
          lastErrorCode: "DEPENDENCY_INPUT_UNREPLAYABLE",
          requiredRaceCount: mode === "PENDING_V1" ? 1 : 0,
        },
      });
      const before = await prisma.globalEventRaceImpact.findMany({
        where: { eventId: event.id, raceId: race.id, userId: user.user.id },
      });

      await resolveExpiredRaces();

      const settledRace = await prisma.race.findUniqueOrThrow({ where: { id: race.id } });
      const settledParticipant = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId: race.id, userId: user.user.id },
      });
      assert.equal(settledRace.status, "COMPLETED");
      assert.equal(settledParticipant.placement, 1);
      assert.deepEqual(await prisma.globalEventRaceImpact.findMany({
        where: { eventId: event.id, raceId: race.id, userId: user.user.id },
      }), before);
    }

    await cleanDatabase();
    const user = await createTestUser();
    const now = new Date();
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "v1 expiry retained",
        targetSteps: 10_000,
        status: "ACTIVE",
        startedAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() - 1_000),
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.user.id,
        status: "ACCEPTED",
        joinedAt: race.startedAt,
      },
    });
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date(now.getTime() - 50_000),
        endsAt: new Date(now.getTime() - 10_000),
        multiplier: 2,
        scheduleMode: "LOCAL_ENTITLEMENTS",
        summaryAttributionVersion: 1,
      },
    });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        timezone: "UTC",
        localDate: event.startsAt.toISOString().slice(0, 10),
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: event.startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
        status: "PENDING",
        attributionVersion: 1,
      },
    });
    await resolveExpiredRaces();
    const legacyImpact = await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(legacyImpact.status, "FINAL");
    assert.equal(legacyImpact.attributionVersion, 1);
  });

  it("settles local-entitlement scoring without mutating captured or terminal v2 vectors", async () => {
    for (const workStatus of ["WAITING_RACES", "UNSCORABLE"]) {
      for (const impactMode of ["EXISTING", "MISSING"]) {
        await cleanDatabase();
        const user = await createTestUser();
        const now = new Date();
        const raceStartedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        const eventStartsAt = new Date(now.getTime() - 90 * 60 * 1000);
        const eventEndsAt = new Date(now.getTime() - 30 * 60 * 1000);
        const sampleStartsAt = new Date(eventStartsAt.getTime() + 10 * 60 * 1000);
        const sampleEndsAt = new Date(sampleStartsAt.getTime() + 10 * 60 * 1000);
        const race = await prisma.race.create({
          data: {
            creatorId: user.user.id,
            name: `local fenced ${workStatus} ${impactMode}`,
            targetSteps: 10_000,
            status: "ACTIVE",
            startedAt: raceStartedAt,
            endsAt: new Date(now.getTime() - 1_000),
            buyInAmount: 10,
            potCoins: 10,
          },
        });
        await prisma.raceParticipant.create({
          data: {
            raceId: race.id,
            userId: user.user.id,
            status: "ACCEPTED",
            joinedAt: raceStartedAt,
            buyInAmount: 10,
            buyInStatus: "COMMITTED",
          },
        });
        const event = await prisma.globalStepEvent.create({
          data: {
            startsAt: eventStartsAt,
            endsAt: eventEndsAt,
            multiplier: 2,
            scheduleMode: "LOCAL_ENTITLEMENTS",
            eventDay: `${now.toISOString().slice(0, 10)}-${workStatus}-${impactMode}`,
            summaryAttributionVersion: 2,
          },
        });
        await prisma.globalStepEventEntitlement.create({
          data: {
            eventId: event.id,
            userId: user.user.id,
            timezone: "UTC",
            localDate: eventStartsAt.toISOString().slice(0, 10),
            startsAt: eventStartsAt,
            endsAt: eventEndsAt,
            startOutcome: "ACTIVATED_ON_TIME",
            startProcessedAt: eventStartsAt,
          },
        });
        if (impactMode === "EXISTING") {
          await prisma.globalEventRaceImpact.create({
            data: {
              eventId: event.id,
              raceId: race.id,
              userId: user.user.id,
              status: "PENDING",
              attributionVersion: 2,
            },
          });
        }
        await prisma.globalEventSummaryWork.create({
          data: {
            eventId: event.id,
            userId: user.user.id,
            status: workStatus,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
            requiredRaceCount: impactMode === "EXISTING" ? 1 : 0,
            ...(workStatus === "UNSCORABLE"
              ? { lastErrorCode: "DEPENDENCY_INPUT_UNREPLAYABLE" }
              : {}),
          },
        });
        await prisma.stepSample.create({
          data: {
            userId: user.user.id,
            periodStart: sampleStartsAt,
            periodEnd: sampleEndsAt,
            steps: 100,
          },
        });
        const beforeVector = await prisma.globalEventRaceImpact.findMany({
          where: { eventId: event.id, userId: user.user.id },
          orderBy: { raceId: "asc" },
        });
        const beforeCoins = (await prisma.user.findUniqueOrThrow({
          where: { id: user.user.id },
          select: { coins: true },
        })).coins;

        await resolveExpiredRaces();

        const settledRace = await prisma.race.findUniqueOrThrow({ where: { id: race.id } });
        const settledParticipant = await prisma.raceParticipant.findFirstOrThrow({
          where: { raceId: race.id, userId: user.user.id },
        });
        const settledCoins = (await prisma.user.findUniqueOrThrow({
          where: { id: user.user.id },
          select: { coins: true },
        })).coins;
        assert.equal(settledRace.status, "COMPLETED");
        assert.equal(settledRace.winnerUserId, user.user.id);
        assert.equal(settledParticipant.placement, 1);
        assert.equal(settledParticipant.totalSteps, 200,
          "100 event-window steps settle at the entitled 2x multiplier");
        assert.equal(settledParticipant.payoutCoins, 10);
        assert.equal(settledCoins, beforeCoins + 10);
        assert.deepEqual(await prisma.globalEventRaceImpact.findMany({
          where: { eventId: event.id, userId: user.user.id },
          orderBy: { raceId: "asc" },
        }), beforeVector);
      }
    }
  });
});
