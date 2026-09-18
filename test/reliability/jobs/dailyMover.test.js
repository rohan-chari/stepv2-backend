const assert = require("node:assert/strict");
const test = require("node:test");

const { buildDailyMover } = require("../../src/modules/notifications/dailyMover");

const FOUR_PM_ET = new Date("2026-06-25T20:05:00Z"); // 4:05pm EDT
const THREE_PM_ET = new Date("2026-06-25T19:00:00Z"); // 3pm EDT

// Participant fixture: totalSteps already reflect what resolveRaceState persisted.
const P = (o) => ({ finishedAt: null, placementAlertsMuted: false, dayStartPlacement: null, ...o });

function makeDeps({
  now = FOUR_PM_ET,
  lastRanFor = null,
  races = [],
  participantsByRace = {},
  random = () => 0,
  resolveThrowsFor = [],
  useBatch = false,
} = {}) {
  const emitted = [];
  const updates = [];
  const marks = [];
  const resolvedRaceIds = [];
  const enqueuedRaceIds = [];
  const deps = {
    now: () => now,
    random,
    logger: { log() {}, warn() {}, error() {} },
    eventBus: {
      emit(event, data) {
        emitted.push({ event, data });
      },
    },
    resolveRaceState: async ({ raceId }) => {
      resolvedRaceIds.push(raceId);
      if (resolveThrowsFor.includes(raceId)) throw new Error(`resolve failed ${raceId}`);
    },
    enqueueRaceResolution: async ({ raceId }) => {
      enqueuedRaceIds.push(raceId);
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
    JobRun: {
      async lastRanFor() {
        return lastRanFor;
      },
      async markRan(jobName, dayKey) {
        marks.push({ jobName, dayKey });
      },
    },
  };
  if (useBatch) {
    deps.RaceParticipant.findAcceptedByRaces = async (raceIds) =>
      raceIds.flatMap((raceId) => participantsByRace[raceId] || []);
  }
  return { deps, emitted, updates, marks, resolvedRaceIds, enqueuedRaceIds };
}

test("uses one batch participant read when available", async () => {
  const { deps } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }, { id: "r2", name: "Race 2" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 2, dayStartPlacement: 2 })],
      r2: [P({ id: "p2", userId: "u2", totalSteps: 1, dayStartPlacement: 2 })],
    },
    useBatch: true,
  });
  let batchCalls = 0;
  let singleCalls = 0;
  const batch = deps.RaceParticipant.findAcceptedByRaces;
  deps.RaceParticipant.findAcceptedByRaces = async (ids) => { batchCalls += 1; return batch(ids); };
  deps.RaceParticipant.findAcceptedByRace = async () => { singleCalls += 1; return []; };
  await buildDailyMover(deps)();
  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
});

test("a climb of more than 3 places emits one DAILY_MOVER and resets the baseline", async () => {
  const { deps, emitted, updates, marks } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 8 })],
    },
  });
  const result = await buildDailyMover(deps)();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "DAILY_MOVER");
  assert.equal(emitted[0].data.userId, "u1");
  assert.equal(emitted[0].data.movement, 7); // 8th -> 1st = climbed 7
  assert.equal(emitted[0].data.placement, 1);
  assert.deepEqual(updates, [{ id: "p1", fields: { dayStartPlacement: 1 } }]);
  assert.deepEqual(marks, [{ jobName: "daily_mover", dayKey: "2026-06-25" }]);
  assert.equal(result.length, 1);
});

test("persists all daily-mover baselines through one bounded batch", async () => {
  const { deps, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 9_000, dayStartPlacement: 4 }),
        P({ id: "p2", userId: "u2", totalSteps: 8_000, dayStartPlacement: 1 }),
      ],
    },
  });
  const batches = [];
  deps.persistBaselineUpdates = async (baselineUpdates) => {
    batches.push(baselineUpdates);
  };

  await buildDailyMover(deps)();

  assert.deepEqual(updates, [], "the batch path must replace per-row updates");
  assert.deepEqual(batches, [[
    { participantId: "p1", liveRank: 1 },
    { participantId: "p2", liveRank: 2 },
  ]]);
});

test("durable large fan-out uses one baseline write and one bulk event append", async () => {
  const participantCount = 1_000;
  const participants = Array.from({ length: participantCount }, (_, index) => P({
    id: `p${index}`,
    userId: `u${index}`,
    totalSteps: participantCount - index,
    dayStartPlacement: participantCount - index,
  }));
  const { deps } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: { r1: participants },
  });
  const baselineBatches = [];
  const eventBatches = [];
  const markers = [];
  const transactionOptions = [];
  const tx = {
    jobRun: {
      async upsert(input) {
        markers.push(input);
      },
    },
  };
  deps.durable = true;
  deps.persistBaselineUpdates = async (updates, receivedTx) => {
    assert.equal(receivedTx, tx);
    baselineBatches.push(updates);
  };
  deps.bulkAppendDomainEvents = async (receivedTx, events) => {
    assert.equal(receivedTx, tx);
    eventBatches.push(events);
  };
  deps.runInPrismaTransaction = async (work, options) => {
    transactionOptions.push(options);
    return work(tx);
  };

  const emitted = await buildDailyMover(deps)();

  assert.equal(baselineBatches.length, 1);
  assert.equal(baselineBatches[0].length, participantCount);
  assert.equal(eventBatches.length, 1);
  assert.equal(eventBatches[0].length, emitted.length);
  assert.ok(eventBatches[0].length > 900, "the regression must exercise a large fan-out");
  assert.equal(markers.length, 1);
  assert.deepEqual(transactionOptions, [{ timeout: 30_000, maxWait: 10_000 }]);
});

test("a move of 3 or fewer places resets the baseline but emits nothing", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 3 })], // 3rd -> 1st = 2
    },
  });
  await buildDailyMover(deps)();
  assert.equal(emitted.length, 0);
  assert.deepEqual(updates, [{ id: "p1", fields: { dayStartPlacement: 1 } }]);
});

test("a never-seeded participant (null baseline) is seeded silently, no digest", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: null })],
    },
  });
  await buildDailyMover(deps)();
  assert.equal(emitted.length, 0);
  assert.deepEqual(updates, [{ id: "p1", fields: { dayStartPlacement: 1 } }]);
});

test("a muted participant keeps its baseline synced but is never notified", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 9, placementAlertsMuted: true })],
    },
  });
  await buildDailyMover(deps)();
  assert.equal(emitted.length, 0);
  assert.deepEqual(updates, [{ id: "p1", fields: { dayStartPlacement: 1 } }]);
});

test("finished participants are skipped entirely (no digest, no baseline write)", async () => {
  const { deps, emitted, updates } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: {
      r1: [
        P({ id: "p1", userId: "u1", totalSteps: 12000, finishedAt: FOUR_PM_ET, dayStartPlacement: 9 }),
        P({ id: "p2", userId: "u2", totalSteps: 6000, dayStartPlacement: 9 }), // 9th -> 2nd = 7
      ],
    },
  });
  await buildDailyMover(deps)();
  // only u2 notified; p1 (finished) neither notified nor written
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data.userId, "u2");
  assert.ok(!updates.some((u) => u.id === "p1"));
});

test("picks the single biggest move across a user's races (either direction)", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "r1", name: "Race 1" }, { id: "r2", name: "Race 2" }],
    participantsByRace: {
      // r1: u1 climbs 5 (6th -> 1st). r2: u1 drops 7 (1st -> 8th).
      r1: [P({ id: "a", userId: "u1", totalSteps: 9000, dayStartPlacement: 6 })],
      r2: [
        P({ id: "b", userId: "u1", totalSteps: 100, dayStartPlacement: 1 }),
        ...Array.from({ length: 7 }, (_, k) =>
          P({ id: `o${k}`, userId: `x${k}`, totalSteps: 1000 + k, dayStartPlacement: 1 })
        ),
      ],
    },
  });
  await buildDailyMover(deps)();
  const u1 = emitted.find((e) => e.data.userId === "u1").data;
  assert.equal(u1.raceId, "r2"); // |−7| > |+5|
  assert.equal(u1.movement, -7);
});

test("deterministic lowest-race-id tiebreak when two races have equal-magnitude moves", async () => {
  const fixtures = () => ({
    races: [{ id: "r1", name: "Race 1" }, { id: "r2", name: "Race 2" }],
    participantsByRace: {
      // both moves are magnitude 5: r1 climb +5 (6th->1st), r2 drop -5 (1st->6th)
      r1: [P({ id: "a", userId: "u1", totalSteps: 9000, dayStartPlacement: 6 })],
      r2: [
        P({ id: "b", userId: "u1", totalSteps: 100, dayStartPlacement: 1 }),
        ...Array.from({ length: 5 }, (_, k) =>
          P({ id: `o${k}`, userId: `x${k}`, totalSteps: 1000 + k, dayStartPlacement: 1 })
        ),
      ],
    },
  });
  const low = makeDeps({ ...fixtures(), random: () => 0 });
  await buildDailyMover(low.deps)();
  assert.equal(low.emitted.find((e) => e.data.userId === "u1").data.raceId, "r1");

  const high = makeDeps({ ...fixtures(), random: () => 0.99 });
  await buildDailyMover(high.deps)();
  assert.equal(high.emitted.find((e) => e.data.userId === "u1").data.raceId, "r1");
});

test("before 4pm ET: does no work and does not mark the run", async () => {
  const { deps, emitted, marks, resolvedRaceIds } = makeDeps({
    now: THREE_PM_ET,
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: { r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 8 })] },
  });
  const result = await buildDailyMover(deps)();
  assert.equal(result, null);
  assert.equal(emitted.length, 0);
  assert.equal(marks.length, 0);
  assert.equal(resolvedRaceIds.length, 0);
});

test("already ran for this ET day: no-op", async () => {
  const { deps, emitted } = makeDeps({
    lastRanFor: "2026-06-25",
    races: [{ id: "r1", name: "Race 1" }],
    participantsByRace: { r1: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 8 })] },
  });
  const result = await buildDailyMover(deps)();
  assert.equal(result, null);
  assert.equal(emitted.length, 0);
});

test("a race whose resolveRaceState throws does not abort the others", async () => {
  const { deps, emitted } = makeDeps({
    races: [{ id: "bad", name: "Bad" }, { id: "r2", name: "Race 2" }],
    resolveThrowsFor: ["bad"],
    participantsByRace: {
      r2: [P({ id: "p1", userId: "u1", totalSteps: 9000, dayStartPlacement: 8 })],
    },
  });
  const result = await buildDailyMover(deps)();
  assert.equal(emitted.length, 1); // r2 still processed
  assert.equal(result.length, 1);
});
