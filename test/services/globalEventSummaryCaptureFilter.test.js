const assert = require("node:assert/strict");
const test = require("node:test");
const {
  claimEligibleSummaryWork,
  lockEligibleSummaryCaptureDependencies,
  persistCapturedSummaryImpactsForRace,
} = require("../../src/modules/steps/services/globalEventSummaryCapture");

test("insufficient post-event coverage skips mutable scoring facts", async () => {
  const eventEnd = new Date("2026-09-02T12:00:00.000Z");
  const tx = {
    globalEventSummaryWork: {
      async findFirst() { return null; },
    },
    race: {
      async findMany() { throw new Error("mutable scoring facts must not be loaded"); },
    },
  };

  const result = await claimEligibleSummaryWork(tx, {
    userId: "user-1",
    captureDependencies: {
      activeWork: null,
      works: [{
        id: "work-1",
        eventId: "event-1",
        userId: "user-1",
        expiresAt: new Date("2026-09-03T12:00:00.000Z"),
        event: { id: "event-1", endsAt: eventEnd, summaryAttributionVersion: 2 },
      }],
      impacts: [{
        eventId: "event-1",
        raceId: "race-1",
        userId: "user-1",
        status: "PENDING",
        attributionVersion: 2,
      }],
      entitlements: [{ eventId: "event-1", userId: "user-1", endsAt: eventEnd }],
    },
    captureSyncRequestId: "sync-1",
    captureCompletedAt: new Date("2026-09-02T12:01:00.000Z"),
    captureCoverageThrough: new Date("2026-09-02T11:59:59.000Z"),
    sourceScoringInputGeneration: 1n,
  });

  assert.equal(result, null);
});

test("summary capture loads active and waiting work with event definitions in one query", async () => {
  const calls = [];
  const tx = {
    globalEventSummaryWork: {
      async findFirst() { throw new Error("unexpected split active-work query"); },
      async findMany() { throw new Error("unexpected split waiting-work query"); },
    },
    userScoringInputVersion: {},
    globalEventRaceImpact: {
      async findMany() { return []; },
      async updateMany() { return { count: 0 }; },
    },
    raceParticipant: { async findMany() { return []; } },
    raceActiveEffect: { async findMany() { return []; } },
    globalStepEventEntitlement: { async findMany() { return []; } },
    async $executeRawUnsafe() { return 0; },
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      if (!sql.includes("UNION ALL")) {
        if (sql.includes("FROM user_scoring_input_versions")) {
          return [{ userId: "user-1", generation: 1 }];
        }
        if (sql.includes("FROM global_event_summary_work")) {
          return [{ id: "waiting-1" }];
        }
        return [];
      }
      return [
        {
          kind: "active",
          id: "active-1",
          eventId: "event-active",
          userId: "user-1",
          status: "PROCESSING",
          expiresAt: new Date("2026-09-03T00:00:00.000Z"),
          eventStartsAt: null,
          eventEndsAt: null,
          eventMultiplier: null,
          eventScheduleMode: null,
          eventSummaryAttributionVersion: null,
        },
        {
          kind: "waiting",
          id: "waiting-1",
          eventId: "event-1",
          userId: "user-1",
          status: "WAITING_SYNC",
          expiresAt: new Date("2026-09-04T00:00:00.000Z"),
          eventStartsAt: new Date("2026-09-01T00:00:00.000Z"),
          eventEndsAt: new Date("2026-09-02T00:00:00.000Z"),
          eventMultiplier: 2,
          eventScheduleMode: "SCHEDULED",
          eventSummaryAttributionVersion: 2,
        },
      ];
    },
  };

  const result = await lockEligibleSummaryCaptureDependencies(tx, {
    userId: "user-1",
    at: new Date("2026-09-02T12:00:00.000Z"),
  });

  const eligibilityCalls = calls.filter(({ sql }) => sql.includes("UNION ALL"));
  assert.equal(eligibilityCalls.length, 1);
  assert.deepEqual(eligibilityCalls[0].params, [
    "user-1",
    new Date("2026-09-02T12:00:00.000Z"),
  ]);
  assert.deepEqual(result.activeWork, {
    id: "active-1",
    status: "PROCESSING",
    expiresAt: new Date("2026-09-03T00:00:00.000Z"),
  });
  assert.equal(result.works.length, 1);
  assert.deepEqual(result.works[0], {
    id: "waiting-1",
    eventId: "event-1",
    userId: "user-1",
    expiresAt: new Date("2026-09-04T00:00:00.000Z"),
    event: {
      id: "event-1",
      startsAt: new Date("2026-09-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-02T00:00:00.000Z"),
      multiplier: 2,
      scheduleMode: "SCHEDULED",
      summaryAttributionVersion: 2,
    },
  });
  assert.deepEqual(result.impacts, []);
  assert.deepEqual(result.entitlements, []);
});

test("race post-processing hydrates artifacts only for actionable summary work", async () => {
  let artifactWhere;
  const tx = {
    globalEventCaptureArtifact: {
      async findMany(input) {
        artifactWhere = input.where;
        return [];
      },
    },
    globalEventRaceImpact: { async updateMany() { return { count: 0 }; } },
    async $queryRawUnsafe() { return []; },
    async $executeRawUnsafe() { return 0; },
  };

  await persistCapturedSummaryImpactsForRace(tx, {
    raceId: "race-1",
    sourceResolutionGeneration: 1,
  });

  assert.deepEqual(artifactWhere, {
    raceId: "race-1",
    work: {
      status: { in: ["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"] },
    },
  });
});
