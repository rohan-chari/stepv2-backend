const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecomputePlacements,
  scheduleRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");

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
    requestStepSyncForUsers: async (userIds, options = {}) => {
      pullCalls.push({ userIds, options });
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

test("normal five-minute ownership does not produce score-driven placement", async () => {
  const { deps, emitted, updates, pullCalls } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 9, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 10, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  deps.produceScoreDrivenPlacements = false;
  await buildRecomputePlacements(deps)();
  assert.equal(emitted.some((event) => event.event === "PLACEMENT_CHANGED"), false);
  assert.deepEqual(updates, []);
  assert.equal(pullCalls.length, 1, "clock-driven step-sync pulls remain active");
});

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
  // No race has an end time -> everyone is "normal" -> a single default-option pull.
  assert.equal(pullCalls.length, 1);
  assert.deepEqual([...pullCalls[0].userIds].sort(), ["u1", "u2", "u3"]);
  assert.deepEqual(pullCalls[0].options, {});
});

test("no participants -> no step-sync pull", async () => {
  const { deps, pullCalls } = makeDeps({ races: [] });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 0);
});

test("production path batches accepted-participant reads across active races", async () => {
  const batchCalls = [];
  const run = buildRecomputePlacements({
    now: () => FIXED_NOW,
    logger: { log() {}, warn() {}, error() {} },
    eventBus: { emit() {} },
    requestStepSyncForUsers: async () => {},
    Race: {
      async findActiveInProgress() {
        return [
          { id: "r1", name: "R1" },
          { id: "r2", name: "R2" },
        ];
      },
    },
    RaceResolutionJobV2: {
      async findRecoveryRaceIds() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findDueRaceIds() {
        return [];
      },
    },
    RaceParticipant: {
      async findAcceptedByRaces(raceIds) {
        batchCalls.push(raceIds);
        return [
          P({
            id: "p1",
            raceId: "r1",
            userId: "u1",
            totalSteps: 100,
            lastNotifiedPlacement: 1,
          }),
          P({
            id: "p2",
            raceId: "r2",
            userId: "u2",
            totalSteps: 100,
            lastNotifiedPlacement: 1,
          }),
        ];
      },
      async findAcceptedByRace() {
        throw new Error("per-race participant query must not run");
      },
      async update() {},
    },
  });

  await run();

  assert.deepEqual(batchCalls, [["r1", "r2"]]);
});

test("production path batches notification audit reads", async () => {
  const auditCalls = [];
  const emitted = [];
  const run = buildRecomputePlacements({
    now: () => FIXED_NOW,
    logger: { log() {}, warn() {}, error() {} },
    eventBus: { emit: (event, data) => emitted.push({ event, data }) },
    requestStepSyncForUsers: async () => {},
    Race: {
      async findActiveInProgress() {
        return [
          {
            id: "r1",
            name: "Ending Soon",
            startedAt: new Date(FIXED_NOW.getTime() - 5 * 60 * 60 * 1000),
            endsAt: new Date(FIXED_NOW.getTime() + 60 * 60 * 1000),
          },
        ];
      },
    },
    RaceResolutionJobV2: {
      async findRecoveryRaceIds() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findDueRaceIds() {
        return [];
      },
    },
    RaceParticipant: {
      async findAcceptedByRaces() {
        return [
          P({
            id: "p1",
            raceId: "r1",
            userId: "u1",
            totalSteps: 100,
            lastNotifiedPlacement: 1,
          }),
          P({
            id: "p2",
            raceId: "r1",
            userId: "u2",
            totalSteps: 90,
            lastNotifiedPlacement: 2,
          }),
        ];
      },
      async update() {},
    },
    Notification: {
      async findExistingByUserTypeRaceKeys(keys) {
        auditCalls.push(keys);
        return [{ userId: "u1", type: "RACE_ENDING_SOON", raceId: "r1" }];
      },
      async claimDelivery({ userId }) {
        return userId === "u2";
      },
    },
  });

  await run();

  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].length, 2);
  assert.deepEqual(
    emitted
      .filter((entry) => entry.event === "RACE_ENDING_SOON")
      .map((entry) => entry.data.userId),
    ["u2"]
  );
});

test("scheduler skips a tick while the previous tick is still running", async () => {
  let releaseFirst;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let raceReads = 0;
  const warnings = [];
  let intervalTick;
  const scheduled = scheduleRecomputePlacements({
    logger: {
      log() {},
      error() {},
      warn(message) {
        warnings.push(message);
      },
    },
    setInterval(callback) {
      intervalTick = callback;
      return "timer";
    },
    Race: {
      async findActiveInProgress() {
        raceReads += 1;
        if (raceReads === 1) await firstRun;
        return [];
      },
    },
    RaceResolutionJobV2: {
      async findRecoveryRaceIds() {
        return [];
      },
    },
  });

  assert.equal(scheduled.interval, "timer");
  await intervalTick();
  assert.equal(raceReads, 1);
  assert.equal(warnings.length, 1);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await intervalTick();
  assert.equal(raceReads, 2);
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

// --- Final-stretch tighter-throttle set (races ending within the next hour) ---

const THIRTY_MIN_MS = 30 * 60 * 1000;

// endsAt helpers relative to FIXED_NOW.
const inMinutes = (m) => new Date(FIXED_NOW.getTime() + m * 60 * 1000);

test("a race ending in <60min -> its participants get the tighter 30-min option", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [{ id: "r1", name: "Ending Soon", endsAt: inMinutes(45) }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 90, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  // Only the final-stretch pull should fire (no normal users).
  assert.equal(pullCalls.length, 1);
  assert.deepEqual([...pullCalls[0].userIds].sort(), ["u1", "u2"]);
  assert.deepEqual(pullCalls[0].options, { minIntervalMs: THIRTY_MIN_MS });
});

test("a race ending in >60min -> default options (not final-stretch)", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [{ id: "r1", name: "Later", endsAt: inMinutes(90) }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 })],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 1);
  assert.deepEqual([...pullCalls[0].userIds].sort(), ["u1"]);
  assert.deepEqual(pullCalls[0].options, {});
});

test("a race with no end time (endsAt null) -> default options (not final-stretch)", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [{ id: "r1", name: "Open Ended", endsAt: null }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 })],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 1);
  assert.deepEqual(pullCalls[0].options, {});
});

test("a user in both a final-stretch and a normal race is nudged once, tighter-only", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [
      { id: "soon", name: "Ending Soon", endsAt: inMinutes(30) },
      { id: "later", name: "Later", endsAt: inMinutes(120) },
    ],
    participantsByRace: {
      // u1 is in both races; u2 only in the ending-soon race; u3 only in the later race.
      soon: [
        P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 }),
        P({ id: "p2", userId: "u2", totalSteps: 90, lastNotifiedPlacement: 2 }),
      ],
      later: [
        P({ id: "p3", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 }),
        P({ id: "p4", userId: "u3", totalSteps: 90, lastNotifiedPlacement: 2 }),
      ],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 2);

  const finalCall = pullCalls.find((c) => c.options.minIntervalMs === THIRTY_MIN_MS);
  const normalCall = pullCalls.find((c) => Object.keys(c.options).length === 0);
  assert.ok(finalCall, "expected a final-stretch pull");
  assert.ok(normalCall, "expected a normal pull");

  // u1 goes to the final-stretch set only (tighter wins), NOT the normal set.
  assert.deepEqual([...finalCall.userIds].sort(), ["u1", "u2"]);
  assert.deepEqual([...normalCall.userIds].sort(), ["u3"]);
});

test("final-stretch only (no normal users) -> a single tighter pull, no empty normal call", async () => {
  const { deps, pullCalls } = makeDeps({
    races: [{ id: "soon", name: "Ending Soon", endsAt: inMinutes(10) }],
    participantsByRace: {
      soon: [P({ id: "p1", userId: "u1", totalSteps: 100, lastNotifiedPlacement: 1 })],
    },
  });
  await buildRecomputePlacements(deps)();
  assert.equal(pullCalls.length, 1);
  assert.deepEqual(pullCalls[0].options, { minIntervalMs: THIRTY_MIN_MS });
});
