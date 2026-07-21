const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecordSteps } = require("../../src/modules/steps/commands/recordSteps");

// The overtake nudge is fire-and-forget (not awaited in the response path), so
// tests flush the microtask/immediate queue after recordSteps resolves.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Minimal Steps/User/eventBus fakes shared by the cases below. resolveRaceState
// and RaceParticipant are injected per-test to drive the standings.
function baseDeps(overrides = {}) {
  return {
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
      async create(payload) {
        return { id: "step-1", ...payload };
      },
    },
    User: {
      async update() {},
    },
    eventBus: { emit() {} },
    ...overrides,
  };
}

test("nudges exactly the two rivals when a sync moves the user 3 -> 1", async () => {
  const nudged = [];

  const recordSteps = buildRecordSteps(
    baseDeps({
      resolveRaceState: async () => [{ raceId: "race-1", race: {} }],
      RaceParticipant: {
        async findAcceptedByRace(raceId) {
          assert.equal(raceId, "race-1");
          // AFTER-sync standings (freshly persisted totals). lastNotifiedPlacement
          // is the BEFORE rank. User u1 jumped from 3rd to 1st.
          return [
            { userId: "u1", totalSteps: 1000, lastNotifiedPlacement: 3, finishedAt: null },
            { userId: "u2", totalSteps: 900, lastNotifiedPlacement: 1, finishedAt: null },
            { userId: "u3", totalSteps: 800, lastNotifiedPlacement: 2, finishedAt: null },
          ];
        },
      },
      requestStepSyncForUsers: async (ids) => {
        nudged.push(ids);
      },
    })
  );

  await recordSteps({ userId: "u1", steps: 1000, date: "2026-03-19" });
  await flush();

  assert.equal(nudged.length, 1);
  assert.deepEqual([...nudged[0]].sort(), ["u2", "u3"]);
});

test("does not nudge when the user's rank is unchanged", async () => {
  const nudged = [];

  const recordSteps = buildRecordSteps(
    baseDeps({
      resolveRaceState: async () => [{ raceId: "race-1", race: {} }],
      RaceParticipant: {
        async findAcceptedByRace() {
          // User u1 is still 1st (before rank 1, after rank 1).
          return [
            { userId: "u1", totalSteps: 1000, lastNotifiedPlacement: 1, finishedAt: null },
            { userId: "u2", totalSteps: 900, lastNotifiedPlacement: 2, finishedAt: null },
            { userId: "u3", totalSteps: 800, lastNotifiedPlacement: 3, finishedAt: null },
          ];
        },
      },
      requestStepSyncForUsers: async (ids) => {
        nudged.push(ids);
      },
    })
  );

  await recordSteps({ userId: "u1", steps: 1000, date: "2026-03-19" });
  await flush();

  assert.equal(nudged.length, 0);
});

test("excludes a passed rival that has already finished", async () => {
  const nudged = [];

  const recordSteps = buildRecordSteps(
    baseDeps({
      resolveRaceState: async () => [{ raceId: "race-1", race: {} }],
      RaceParticipant: {
        async findAcceptedByRace() {
          // User u1 jumped 3 -> 1. u2 was ahead but has FINISHED (frozen), so it
          // must be excluded; only the unfinished passed rival u3 is nudged.
          return [
            { userId: "u1", totalSteps: 1000, lastNotifiedPlacement: 3, finishedAt: null },
            { userId: "u2", totalSteps: 900, lastNotifiedPlacement: 1, finishedAt: new Date() },
            { userId: "u3", totalSteps: 800, lastNotifiedPlacement: 2, finishedAt: null },
          ];
        },
      },
      requestStepSyncForUsers: async (ids) => {
        nudged.push(ids);
      },
    })
  );

  await recordSteps({ userId: "u1", steps: 1000, date: "2026-03-19" });
  await flush();

  assert.equal(nudged.length, 1);
  assert.deepEqual([...nudged[0]], ["u3"]);
});

test("does not nudge (or resolve race state) when skipRaceResolution is set", async () => {
  const nudged = [];
  let resolveCalled = false;
  let findCalled = false;

  const recordSteps = buildRecordSteps(
    baseDeps({
      resolveRaceState: async () => {
        resolveCalled = true;
        return [{ raceId: "race-1", race: {} }];
      },
      RaceParticipant: {
        async findAcceptedByRace() {
          findCalled = true;
          return [];
        },
      },
      requestStepSyncForUsers: async (ids) => {
        nudged.push(ids);
      },
    })
  );

  await recordSteps({
    userId: "u1",
    steps: 1000,
    date: "2026-03-19",
    skipRaceResolution: true,
  });
  await flush();

  assert.equal(resolveCalled, false);
  assert.equal(findCalled, false);
  assert.equal(nudged.length, 0);
});

test("still resolves normally when the push service throws", async () => {
  const recordSteps = buildRecordSteps(
    baseDeps({
      resolveRaceState: async () => [{ raceId: "race-1", race: {} }],
      RaceParticipant: {
        async findAcceptedByRace() {
          return [
            { userId: "u1", totalSteps: 1000, lastNotifiedPlacement: 3, finishedAt: null },
            { userId: "u2", totalSteps: 900, lastNotifiedPlacement: 1, finishedAt: null },
            { userId: "u3", totalSteps: 800, lastNotifiedPlacement: 2, finishedAt: null },
          ];
        },
      },
      requestStepSyncForUsers: async () => {
        throw new Error("push boom");
      },
    })
  );

  const record = await recordSteps({ userId: "u1", steps: 1000, date: "2026-03-19" });
  await flush();

  assert.equal(record.id, "step-1");
});
