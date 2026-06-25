const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecomputePlacements } = require("../../src/jobs/placementRecompute");

const FIXED_NOW = new Date("2026-06-24T12:00:00Z");

function makeDeps({ races = [], participantsByRace = {}, resolveThrowsFor = [] } = {}) {
  const emitted = [];
  const updates = [];
  const resolvedRaceIds = [];
  const pullCalls = [];
  const deps = {
    now: () => FIXED_NOW,
    logger: { log() {}, warn() {}, error() {} },
    eventBus: {
      emit(event, data) {
        emitted.push({ event, data });
      },
    },
    requestStepSyncForUsers: async (userIds) => {
      pullCalls.push(userIds);
    },
    resolveRaceState: async ({ raceId }) => {
      resolvedRaceIds.push(raceId);
      if (resolveThrowsFor.includes(raceId)) {
        throw new Error(`resolve failed for ${raceId}`);
      }
    },
    Race: {
      async findActiveInProgress() {
        return races;
      },
    },
    RaceParticipant: {
      async findAcceptedByRace(raceId) {
        return participantsByRace[raceId] || [];
      },
      async update(id, fields) {
        updates.push({ id, fields });
        return { id, ...fields };
      },
    },
  };
  return { deps, emitted, updates, resolvedRaceIds, pullCalls };
}

// Participant fixture: totalSteps already reflect what resolveRaceState persisted.
const P = (o) => ({ finishedAt: null, lastNotifiedPlacement: null, ...o });

test("emits PLACEMENT_CHANGED only for participants whose live rank changed", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 9000, lastNotifiedPlacement: 1 }), // now 2nd
        P({ id: "p2", userId: "u2", totalSteps: 10000, lastNotifiedPlacement: 2 }), // now 1st
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 2);
  const u1 = emitted.find((e) => e.data.userId === "u1").data;
  assert.equal(u1.previousPlacement, 1);
  assert.equal(u1.placement, 2);
  assert.equal(u1.raceName, "Race 1");
  const u2 = emitted.find((e) => e.data.userId === "u2").data;
  assert.equal(u2.placement, 1);
});

test("idempotent: unchanged rank does not re-notify or write", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 10000, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 9000, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 0);
  assert.equal(updates.length, 0);
});

test("first observation (null lastNotifiedPlacement) seeds baseline silently", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 10000, lastNotifiedPlacement: null })],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 0);
  assert.deepEqual(updates, [{ id: "p1", fields: { lastNotifiedPlacement: 1 } }]);
});

test("muted participant: rank change updates baseline but emits nothing", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 9000, lastNotifiedPlacement: 1, placementAlertsMuted: true }), // now 2nd
        P({ id: "p2", userId: "u2", totalSteps: 10000, lastNotifiedPlacement: 2 }), // now 1st
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  // u1 is muted -> no event for them; u2 (unmuted) still notified.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data.userId, "u2");
  // u1's baseline is still advanced so unmuting later won't replay this move.
  assert.ok(updates.some((u) => u.id === "p1" && u.fields.lastNotifiedPlacement === 2));
});

test("emitted change carries paidPlaces derived from the race payout", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "r1", name: "Race 1", payoutPreset: "TOP3_70_20_10", potCoins: 300 }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 9000, lastNotifiedPlacement: 1 }), // now 2nd
        P({ id: "p2", userId: "u2", totalSteps: 10000, lastNotifiedPlacement: 2 }), // now 1st
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.ok(emitted.length >= 1);
  assert.equal(emitted[0].data.paidPlaces, 3); // top-3 preset pays 3 places
});

test("finished participants are never notified but still occupy a rank", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 12000, finishedAt: FIXED_NOW, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 9000, lastNotifiedPlacement: 1 }), // now 2nd
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data.userId, "u2");
  assert.equal(emitted[0].data.placement, 2);
});

test("a race whose resolveRaceState throws does not abort the others", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "bad", name: "Bad" }, { id: "r2", name: "Race 2" }],
    resolveThrowsFor: ["bad"],
    participantsByRace: {
      r2: [
        P({ id: "p1", userId: "u1", totalSteps: 9000, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 10000, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  const result = await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 2); // r2 still processed
  assert.equal(result.length, 2);
});

test("calls resolveRaceState({ raceId }) once per active race", async () => {
  const { deps, resolvedRaceIds } = makeDeps({
    races: [{ id: "r1", name: "R1" }, { id: "r2", name: "R2" }],
    participantsByRace: { r1: [], r2: [] },
  });
  await buildRecomputePlacements(deps)();
  assert.deepEqual(resolvedRaceIds, ["r1", "r2"]);
});

test("no active races -> no work", async () => {
  const { deps, emitted, resolvedRaceIds } = makeDeps({ races: [] });
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 0);
  assert.equal(resolvedRaceIds.length, 0);
});

test("nudges all active-race participants to sync once (deduped step-sync pull)", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }, { id: "r2", name: "Race 2" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 90, lastNotifiedPlacement: 2 }),
      ],
      r2: [P({ id: "p3", userId: "u3", totalSteps: 50, lastNotifiedPlacement: 1 })],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 1);
  assert.deepEqual([...pullCalls[0]].sort(), ["u1", "u2", "u3"]);
});

test("no participants -> no step-sync pull", async () => {
  const { deps, pullCalls } = makeDeps({ races: [] });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 0);
});

test("step-sync pull failure does not break the job", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 90, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 100, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  deps.requestStepSyncForUsers = async () => {
    throw new Error("push fan-out failed");
  };
  const result = await buildRecomputePlacements(deps)();
  assert.equal(emitted.length, 2); // recompute/emit still happened
  assert.equal(result.length, 2);
});
