const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetRaceProgress,
} = require("../../src/modules/races/queries/getRaceProgress");
const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");

test("worker snapshot uses committed participant totals without replaying steps", async () => {
  let raceReads = 0;
  let effectReads = 0;
  const race = {
    id: "race-1",
    status: "ACTIVE",
    startedAt: new Date("2026-08-10T00:00:00Z"),
    endsAt: new Date("2026-08-17T00:00:00Z"),
    timezone: "UTC",
    maxDurationDays: 7,
    targetSteps: 50000,
    isTeamRace: false,
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    participants: [
      {
        id: "participant-1",
        userId: "user-1",
        status: "ACCEPTED",
        totalSteps: 4321,
        rawSteps: 4000,
        joinedAt: new Date("2026-08-10T00:00:00Z"),
        finishedAt: null,
        forfeitedAt: null,
        placement: null,
        team: null,
        user: {
          id: "user-1",
          displayName: "Runner",
          profilePhotoUrl: null,
          equippedAccessories: [],
        },
      },
    ],
  };
  const query = buildGetRaceProgress({
    Race: {
      async findById() {
        raceReads += 1;
        return race;
      },
    },
    RaceActiveEffect: {
      async findActiveForRace() {
        effectReads += 1;
        return [];
      },
    },
    GlobalStepEvent: {
      async findActiveInRange() {
        return [];
      },
    },
    Steps: new Proxy(
      {},
      { get() { return async () => assert.fail("step replay must not run"); } }
    ),
    StepSample: new Proxy(
      {},
      { get() { return async () => assert.fail("sample replay must not run"); } }
    ),
    raceProgressSnapshot: snapshotStore,
    now: () => new Date("2026-08-13T12:00:00Z"),
  });

  const snapshot = await query.computePersistedSnapshot({
    raceId: race.id,
    timeZone: "UTC",
    baseAdjustedByParticipantId: { "participant-1": 4000 },
  });

  assert.equal(raceReads, 1);
  assert.equal(effectReads, 1);
  assert.equal(snapshot.source, "worker-persisted");
  assert.equal(snapshot.participants[0].totalSteps, 4321);
  assert.equal(snapshot.participants[0].baseAdjusted, 4000);
});

test("persisted fallback computes currentMultiplier from participant-specific event maps", async () => {
  const race = {
    id: "race-1", status: "ACTIVE",
    startedAt: new Date("2026-08-20T13:00:00Z"),
    endsAt: new Date("2026-08-21T13:00:00Z"),
    timezone: "UTC", targetSteps: 0, isTeamRace: false,
    powerupsEnabled: true, powerupStepInterval: 2000,
    participants: [
      { id: "p-ny", userId: "ny", status: "ACCEPTED", totalSteps: 100,
        joinedAt: new Date("2026-08-20T13:00:00Z"), user: { displayName: "NY", equippedAccessories: [] } },
      { id: "p-mad", userId: "mad", status: "ACCEPTED", totalSteps: 100,
        joinedAt: new Date("2026-08-20T13:00:00Z"), user: { displayName: "MAD", equippedAccessories: [] } },
    ],
  };
  let eligibleReads = 0;
  const query = buildGetRaceProgress({
    Race: { async findById() { return race; } },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    GlobalStepEvent: {
      async findEligibleByRace() {
        eligibleReads += 1;
        return new Map([
          ["ny", [{ startsAt: new Date("2026-08-20T14:00:00Z"), endsAt: new Date("2026-08-20T14:30:00Z"), multiplier: 2 }]],
          ["mad", []],
        ]);
      },
      async findActiveAt() { return null; },
    },
    raceProgressSnapshot: snapshotStore,
    now: () => new Date("2026-08-20T14:10:00Z"),
  });
  const snapshot = await query.computePersistedSnapshot({ raceId: race.id, timeZone: "UTC" });
  assert.equal(eligibleReads, 1);
  assert.equal(snapshot.participants.find((row) => row.userId === "ny").currentMultiplier, 2);
  assert.equal(snapshot.participants.find((row) => row.userId === "mad").currentMultiplier, 1);
});

test("legacy persisted snapshot hydrates participants through the presentation cache", async () => {
  let presentationIds = null;
  const race = {
    id: "race-1", status: "ACTIVE",
    startedAt: new Date("2026-08-20T13:00:00Z"),
    endsAt: new Date("2026-08-21T13:00:00Z"),
    timezone: "UTC", targetSteps: 0, isTeamRace: false,
    powerupsEnabled: false, powerupStepInterval: null,
    participants: [
      {
        id: "p-1", userId: "user-1", status: "ACCEPTED", totalSteps: 321,
        joinedAt: new Date("2026-08-20T13:00:00Z"), user: undefined,
      },
    ],
  };
  const query = buildGetRaceProgress({
    Race: { async findById() { return race; } },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    GlobalStepEvent: { async findEligibleByRace() { return new Map(); } },
    userPresentationCache: {
      async getMany(ids) {
        presentationIds = ids;
        return new Map([["user-1", {
          id: "user-1",
          displayName: "Cached Runner",
          profilePhotoUrl: null,
          equippedAccessories: [{ shopItem: {
            id: "item-1", sku: "hat", name: "Hat", slot: "HEAD",
            assetKey: "hat", renderMetadata: {}, bobble: false,
            testOnly: false, remoteOnly: false, assetVersion: "1",
          } }],
          clientFeatures: [],
          isReviewAccount: false,
          hiddenFromLeaderboard: false,
        }]]);
      },
    },
    raceProgressSnapshot: snapshotStore,
    now: () => new Date("2026-08-20T14:10:00Z"),
  });

  const snapshot = await query.computePersistedSnapshot({
    raceId: race.id,
    timeZone: "UTC",
  });

  assert.deepEqual(presentationIds, ["user-1"]);
  assert.equal(
    snapshot.participants[0].presentation["prod:1:0"].accessories[0].assetKey,
    "hat",
  );
  assert.equal(snapshot.v, snapshotStore.SCHEMA_VERSION);
});

test("worker persisted snapshots use the lean schema consumed by paged progress", async () => {
  let legacyReads = 0;
  let leanReads = 0;
  const race = {
    id: "race-lean-worker",
    status: "ACTIVE",
    startedAt: new Date("2026-08-20T13:00:00Z"),
    endsAt: new Date("2026-08-21T13:00:00Z"),
    timezone: "UTC",
    targetSteps: 0,
    isTeamRace: false,
    powerupsEnabled: false,
    powerupStepInterval: null,
    participants: [
      {
        id: "p-lean-worker",
        userId: "user-lean-worker",
        status: "ACCEPTED",
        totalSteps: 321,
        joinedAt: new Date("2026-08-20T13:00:00Z"),
      },
    ],
  };
  const query = buildGetRaceProgress({
    Race: {
      async findById() {
        legacyReads += 1;
        return assert.fail("worker must not load the legacy race graph");
      },
      async findProgressScoringContext() {
        leanReads += 1;
        return race;
      },
    },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    GlobalStepEvent: { async findEligibleByRace() { return new Map(); } },
    userPresentationCache: {
      async getMany() {
        return assert.fail("lean worker snapshots must not hydrate presentations");
      },
    },
    raceProgressSnapshot: snapshotStore,
    now: () => new Date("2026-08-20T14:10:00Z"),
  });

  const snapshot = await query.computePersistedSnapshot({
    raceId: race.id,
    timeZone: "UTC",
  });

  assert.equal(legacyReads, 0);
  assert.equal(leanReads, 1);
  assert.equal(snapshot.v, snapshotStore.LEAN_SCHEMA_VERSION);
  assert.equal(snapshot.participants[0].presentation, undefined);
});
