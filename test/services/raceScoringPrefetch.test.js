const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PREFETCH_EFFECT_TYPES,
  createScoringInputCache,
  prefetchRaceScoringModels,
} = require("../../src/modules/races/services/raceScoringPrefetch");

test("version-identical scoring inputs reuse samples and daily rows exactly", async () => {
  const cache = createScoringInputCache({ maxUsers: 10, maxSampleRows: 100 });
  const calls = { versions: 0, samples: 0, daily: 0 };
  let generation = 7n;
  const start = new Date("2026-08-10T00:00:00Z");
  const models = {
    scoringInputCache: cache,
    scoringInputVersionModel: {
      async findMany() {
        calls.versions += 1;
        return [{ userId: "user-1", generation }];
      },
    },
    stepSampleModel: {
      async findRowsForUsersInRange(userIds) {
        calls.samples += 1;
        assert.deepEqual(userIds, ["user-1"]);
        return [{ userId: "user-1", start, end: new Date(start.getTime() + 3_600_000), steps: 321 }];
      },
    },
    stepsModel: {
      async findByUserIdsAndDateRange(userIds) {
        calls.daily += 1;
        assert.deepEqual(userIds, ["user-1"]);
        return [{ userId: "user-1", date: start, steps: 654 }];
      },
    },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  };
  const options = {
    ...models,
    races: [{
      id: "race-1", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date("2026-08-10T12:00:00Z"),
  };

  const first = await prefetchRaceScoringModels(options);
  const before = {
    sample: await first.stepSampleModel.sumStepsInWindow(
      "user-1", start, new Date(start.getTime() + 3_600_000),
    ),
    daily: (await first.stepsModel.findByUserIdAndDate("user-1", start)).steps,
  };
  first.stepSampleModel.releaseUsers(["user-1"]);
  await first.stepSampleModel.prepareUsers(["user-1"]);
  assert.equal(
    await first.stepSampleModel.sumStepsInWindow(
      "user-1", start, new Date(start.getTime() + 3_600_000),
    ),
    321,
  );
  assert.equal(calls.samples, 1, "later scoring phases must reuse the cached timeline");
  first.stepSampleModel.releaseAll();
  const second = await prefetchRaceScoringModels(options);
  const after = {
    sample: await second.stepSampleModel.sumStepsInWindow(
      "user-1", start, new Date(start.getTime() + 3_600_000),
    ),
    daily: (await second.stepsModel.findByUserIdAndDate("user-1", start)).steps,
  };
  second.stepSampleModel.releaseAll();

  assert.deepEqual(after, before);
  assert.deepEqual(before, { sample: 321, daily: 654 });
  assert.deepEqual(calls, { versions: 2, samples: 1, daily: 1 });
  assert.deepEqual(cache.snapshot(), { users: 1, sampleRows: 1 });

  generation = 8n;
  const changed = await prefetchRaceScoringModels(options);
  await changed.stepSampleModel.sumStepsInWindow(
    "user-1", start, new Date(start.getTime() + 3_600_000),
  );
  changed.stepSampleModel.releaseAll();
  assert.deepEqual(
    calls,
    { versions: 3, samples: 2, daily: 2 },
    "an authoritative version change must force fresh PostgreSQL inputs",
  );
});

test("race scoring prefetch collapses participant reads into three bulk reads", async () => {
  const calls = { samples: 0, daily: 0, effects: 0 };
  const start = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-10T12:00:00Z");
  const effect = {
    id: "effect-1",
    raceId: "race-1",
    targetParticipantId: "participant-1",
    targetUserId: "user-1",
    type: "HITCHHIKE",
    status: "ACTIVE",
    createdAt: start,
  };
  const scoped = await prefetchRaceScoringModels({
    races: [
      {
        id: "race-1",
        startedAt: start,
        powerupsEnabled: true,
        participants: [
          { id: "participant-1", userId: "user-1" },
          { id: "participant-2", userId: "user-2" },
        ],
      },
    ],
    now,
    stepSampleModel: {
      async findRowsForUsersInRange(userIds) {
        calls.samples += 1;
        assert.deepEqual(userIds.sort(), ["user-1", "user-2"]);
        return [
          {
            userId: "user-1",
            start: new Date("2026-08-10T01:00:00Z"),
            end: new Date("2026-08-10T02:00:00Z"),
            steps: 600,
          },
        ];
      },
      async sumStepsInWindows() {
        assert.fail("covered sample windows must not fall through");
      },
      async sumClosedStepsInWindows() {
        assert.fail("covered closed windows must not fall through");
      },
      async hasAnyInWindow() {
        assert.fail("covered existence checks must not fall through");
      },
    },
    stepsModel: {
      async findByUserIdsAndDateRange() {
        calls.daily += 1;
        return [
          { userId: "user-1", date: start, steps: 900 },
        ];
      },
      async findByUserIdAndDate() {
        assert.fail("covered daily reads must not fall through");
      },
      async findByUserIdAndDateRange() {
        assert.fail("covered daily ranges must not fall through");
      },
    },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes(
        raceIds,
        participantIds,
        types
      ) {
        calls.effects += 1;
        assert.deepEqual(raceIds, ["race-1"]);
        assert.deepEqual(participantIds, ["participant-1", "participant-2"]);
        assert.deepEqual(types, PREFETCH_EFFECT_TYPES);
        return { "participant-1": { HITCHHIKE: [effect] } };
      },
      async findEffectsForRaceByTypes() {
        assert.fail("covered effect reads must not fall through");
      },
      async findRaceEffectsByType() {
        assert.fail("covered race effect reads must not fall through");
      },
    },
  });

  assert.deepEqual(calls, { samples: 1, daily: 1, effects: 1 });
  assert.equal(
    await scoped.stepSampleModel.sumStepsInWindow(
      "user-1",
      new Date("2026-08-10T01:00:00Z"),
      new Date("2026-08-10T02:00:00Z")
    ),
    600
  );
  assert.equal(
    await scoped.stepSampleModel.hasAnyInWindow(
      "user-1",
      start,
      now
    ),
    true
  );
  assert.equal(
    (
      await scoped.stepsModel.findByUserIdAndDate("user-1", "2026-08-10")
    ).steps,
    900
  );
  assert.deepEqual(
    await scoped.raceActiveEffectModel.findRaceEffectsByType(
      "race-1",
      "HITCHHIKE"
    ),
    [effect]
  );
});

test("race scoring prefetch preserves closed-bucket semantics", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const scoped = await prefetchRaceScoringModels({
    races: [
      {
        id: "race-1",
        startedAt: start,
        powerupsEnabled: true,
        participants: [{ id: "participant-1", userId: "user-1" }],
      },
    ],
    now: new Date("2026-08-10T03:00:00Z"),
    stepSampleModel: {
      async findRowsForUsersInRange() {
        return [
          {
            userId: "user-1",
            start: new Date("2026-08-10T01:00:00Z"),
            end: new Date("2026-08-10T02:00:00Z"),
            steps: 600,
          },
          {
            userId: "user-1",
            start: new Date("2026-08-10T02:00:00Z"),
            end: new Date("2026-08-10T03:00:00Z"),
            steps: 900,
          },
        ];
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });

  const total = await scoped.stepSampleModel.sumClosedStepsInWindow(
    "user-1",
    start,
    new Date("2026-08-10T03:00:00Z"),
    new Date("2026-08-10T02:30:00Z")
  );
  assert.equal(total, 600, "the still-open second bucket stays excluded");
});

test("compact sample timelines preserve offsets for races longer than 30 days", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const sampleStart = new Date("2026-02-01T00:00:00Z");
  const sampleEnd = new Date("2026-02-01T01:00:00Z");
  const scoped = await prefetchRaceScoringModels({
    races: [{
      id: "race-30d", startedAt: start, powerupsEnabled: true,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date("2026-02-02T00:00:00Z"),
    stepSampleModel: {
      async findRowsForUsersInRange() {
        return [
          {
            userId: "user-1", start,
            end: new Date(start.getTime() + 60_000), steps: 1,
          },
          { userId: "user-1", start: sampleStart, end: sampleEnd, steps: 1234 },
        ];
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });
  assert.equal(
    await scoped.stepSampleModel.sumStepsInWindow("user-1", sampleStart, sampleEnd),
    1234,
  );
});

test("worker scoring input batches exact user ranges in stable groups of 25 and prefetches finish inputs", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-10T12:00:00Z");
  const participants = Array.from({ length: 51 }, (_, index) => ({
    id: `participant-${String(index).padStart(2, "0")}`,
    userId: `user-${String(index).padStart(2, "0")}`,
    joinedAt: new Date(start.getTime() + index * 1000),
  }));
  const sampleChunks = [];
  let eventReads = 0;
  const scoped = await prefetchRaceScoringModels({
    races: [{
      id: "race-1",
      startedAt: start,
      powerupsEnabled: true,
      participants,
    }],
    now,
    strictWorkerMode: true,
    stepSampleModel: {
      async findRowsForUserRanges(bounds) {
        sampleChunks.push(bounds);
        return bounds.map((bound) => ({
          id: `sample-${bound.ordinal}`,
          userId: bound.userId,
          start: new Date("2026-08-10T01:00:00Z"),
          end: new Date("2026-08-10T02:00:00Z"),
          steps: 60,
        }));
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
    powerupEventModel: {
      async findByRaceAsc() {
        eventReads += 1;
        return [{ id: "event-1", raceId: "race-1" }];
      },
    },
  });

  assert.deepEqual(sampleChunks.map((chunk) => chunk.length), [25, 25, 1]);
  assert.deepEqual(
    sampleChunks.flat().map(({ userId, ordinal }) => ({ userId, ordinal })),
    participants.map((participant, ordinal) => ({
      userId: participant.userId,
      ordinal,
    })),
  );
  assert.equal(eventReads, 1);
  assert.equal(
    (await scoped.stepSampleModel.findByUserIdAndTimeRange(
      "user-00",
      start,
      now,
    )).length,
    1,
  );
  assert.deepEqual(
    await scoped.powerupEventModel.findByRaceAsc("race-1"),
    [{ id: "event-1", raceId: "race-1" }],
  );
});

test("worker scoring input fails closed instead of issuing a participant-local fallback", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-10T12:00:00Z");
  const scoped = await prefetchRaceScoringModels({
    races: [{
      id: "race-1",
      startedAt: start,
      powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now,
    strictWorkerMode: true,
    stepSampleModel: {
      async findRowsForUserRanges() { return []; },
      async sumStepsInWindows() {
        assert.fail("worker fallback must never execute");
      },
    },
    stepsModel: {
      async findByUserIdsAndDateRange() { return []; },
      async findByUserIdAndDateRange() {
        assert.fail("worker fallback must never execute");
      },
    },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });

  await assert.rejects(
    scoped.stepSampleModel.sumStepsInWindows("user-1", [{
      start: new Date("2026-08-01T00:00:00Z"),
      end: now,
    }]),
    /outside the bounded worker scoring input/,
  );
  await assert.rejects(
    scoped.stepsModel.findByUserIdAndDate("user-1", new Date("2026-08-01T00:00:00Z")),
    /outside the bounded worker scoring input/,
  );
  await assert.rejects(
    scoped.raceActiveEffectModel.findEffectsForRaceByTypes(
      "race-1", "participant-1", ["UNPREFETCHED_TYPE"],
    ),
    /outside the bounded worker scoring input/,
  );
  await assert.rejects(
    scoped.raceActiveEffectModel.findEffectsForRaceByType(
      "race-1", "participant-1", "UNPREFETCHED_TYPE",
    ),
    /outside the bounded worker scoring input/,
  );
  await assert.rejects(
    scoped.raceActiveEffectModel.findRaceEffectsByType("race-1", "UNPREFETCHED_TYPE"),
    /outside the bounded worker scoring input/,
  );
});

test("strict worker scoring rejects every missing required bulk capability", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const base = {
    races: [{
      id: "race-1", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date("2026-08-10T04:00:00Z"),
    strictWorkerMode: true,
  };
  for (const missing of ["samples", "daily", "effects"]) {
    await assert.rejects(prefetchRaceScoringModels({
      ...base,
      stepSampleModel: missing === "samples" ? {} : { async findRowsForUserRanges() { return []; } },
      stepsModel: missing === "daily" ? {} : { async findByUserIdsAndDateRange() { return []; } },
      raceActiveEffectModel: missing === "effects" ? {} : {
        async findEffectsForRaceParticipantsByTypes() { return {}; },
      },
    }), /bounded worker scoring input model is unavailable/, missing);
  }
});

test("one exceptional user is cursor-paged without truncating its timeline", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-10T04:00:00Z");
  const calls = [];
  const rows = [0, 1, 2].map((hour) => ({
    ordinal: 0,
    id: `sample-${hour}`,
    userId: "user-1",
    start: new Date(start.getTime() + hour * 60 * 60 * 1000),
    end: new Date(start.getTime() + (hour + 1) * 60 * 60 * 1000),
    steps: 100,
  }));
  const scoped = await prefetchRaceScoringModels({
    races: [{
      id: "race-1",
      startedAt: start,
      powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now,
    strictWorkerMode: true,
    maxSampleRowsPerChunk: 2,
    stepSampleModel: {
      async findRowsForUserRanges(_bounds, options) {
        calls.push(options.cursor);
        return options.cursor ? rows.slice(2) : rows.slice(0, 2);
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], null);
  assert.deepEqual(calls[1], {
    ordinal: 0,
    periodStart: rows[1].start,
    id: "sample-1",
  });
  assert.equal(
    await scoped.stepSampleModel.sumStepsInWindow("user-1", start, now),
    300,
  );
  assert.equal(
    (await scoped.stepSampleModel.findByUserIdAndTimeRange("user-1", start, now)).length,
    3,
  );
});

test("a pathological single user uses one database cursor pass and no retained in-process timeline", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const rows = Array.from({ length: 7 }, (_, index) => ({
    ordinal: 0,
    id: `sample-${String(index).padStart(2, "0")}`,
    userId: "user-1",
    start: new Date(start.getTime() + index * 60_000),
    end: new Date(start.getTime() + (index + 1) * 60_000),
    steps: 10,
  }));
  let calls = 0;
  const scoped = await prefetchRaceScoringModels({
    races: [{
      id: "race-pathological", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date(start.getTime() + 10 * 60_000),
    strictWorkerMode: true,
    maxSampleRowsPerChunk: 2,
    maxRetainedSampleRowsPerUser: 3,
    stepSampleModel: {
      async findRowsForUserRanges(_bounds, { maxRows, cursor }) {
        calls += 1;
        const after = cursor == null
          ? 0
          : rows.findIndex((row) => row.id === cursor.id) + 1;
        return rows.slice(after, after + maxRows);
      },
      async sumStepsInWindows() {
        assert.fail("strict streaming must not fall through to participant-local SQL");
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
  });

  assert.equal(scoped.stepSampleModel.retainedSampleRowCount(), 0,
    "detection pages must be discarded once the user crosses the retained-row ceiling");
  const callsAfterPrepare = calls;
  assert.equal(await scoped.stepSampleModel.sumStepsInWindow(
    "user-1", start, new Date(start.getTime() + 10 * 60_000),
  ), 70);
  scoped.stepSampleModel.releaseUsers(["user-1"]);
  await scoped.stepSampleModel.prepareUsers(["user-1"]);
  assert.equal(calls, callsAfterPrepare,
    "the base-to-Hitchhike phase release must retain the generation spool");
  assert.equal(await scoped.stepSampleModel.hasAnyInWindow(
    "user-1", start, new Date(start.getTime() + 10 * 60_000),
  ), true);
  scoped.stepSampleModel.releaseUsers(["user-1"]);
  await scoped.stepSampleModel.prepareUsers(["user-1"]);
  const streamed = await scoped.stepSampleModel.findByUserIdAndTimeRange(
    "user-1", start, new Date(start.getTime() + 10 * 60_000),
  );
  assert.equal(typeof streamed[Symbol.asyncIterator], "function");
  const seen = [];
  for await (const row of streamed) seen.push(row.steps);
  assert.deepEqual(seen, [10, 10, 10, 10, 10, 10, 10]);
  assert.equal(calls, callsAfterPrepare,
    "base, Hitchhike/effect, and finish phases share the same database pass");
  assert.equal(scoped.stepSampleModel.retainedSampleRowCount(), 0);
  scoped.stepSampleModel.releaseAll();
});

test("heap guard retries an oversized user group as smaller whole-user batches", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const boundCounts = [];
  const heapValues = [0, 64, 0, 0, 0, 0];
  await prefetchRaceScoringModels({
    races: [{
      id: "race-1",
      startedAt: start,
      powerupsEnabled: false,
      participants: [
        { id: "participant-1", userId: "user-1" },
        { id: "participant-2", userId: "user-2" },
      ],
    }],
    now: new Date("2026-08-10T04:00:00Z"),
    strictWorkerMode: true,
    maxHeapGrowthBytes: 32,
    memoryUsage: () => ({ heapUsed: heapValues.shift() ?? 0 }),
    stepSampleModel: {
      async findRowsForUserRanges(bounds) {
        boundCounts.push(bounds.length);
        return [];
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });
  assert.deepEqual(boundCounts, [2, 1, 1]);
});

test("memory guard includes post-conversion external and ArrayBuffer growth", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const snapshots = [
    { heapUsed: 0, external: 0, arrayBuffers: 0 },
    { heapUsed: 0, external: 40, arrayBuffers: 40 },
  ];
  await assert.rejects(prefetchRaceScoringModels({
    races: [{
      id: "race-1", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date("2026-08-10T04:00:00Z"),
    strictWorkerMode: true,
    maxSampleRowsPerChunk: 1,
    maxHeapGrowthBytes: 32,
    memoryUsage: () => snapshots.shift() || { heapUsed: 0, external: 40, arrayBuffers: 40 },
    stepSampleModel: {
      async findRowsForUserRanges() {
        return [{
          id: "sample-1", ordinal: 0, userId: "user-1",
          start, end: new Date(start.getTime() + 1000), steps: 1,
        }];
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
  }), /32 MiB.*memory guard/);
});

test("exceptional-user threshold pages are checked against the process memory guard before spooling", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const snapshots = [
    { heapUsed: 0, external: 0, arrayBuffers: 0 },
    { heapUsed: 0, external: 64, arrayBuffers: 64 },
  ];
  await assert.rejects(prefetchRaceScoringModels({
    races: [{
      id: "race-exceptional-guard", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "participant-1", userId: "user-1" }],
    }],
    now: new Date("2026-08-10T04:00:00Z"),
    strictWorkerMode: true,
    maxSampleRowsPerChunk: 2,
    maxRetainedSampleRowsPerUser: 1,
    maxHeapGrowthBytes: 32,
    memoryUsage: () => snapshots.shift() || { heapUsed: 0, external: 64, arrayBuffers: 64 },
    stepSampleModel: {
      async findRowsForUserRanges() {
        return [0, 1].map((index) => ({
          id: `sample-${index}`, ordinal: 0, userId: "user-1",
          start: new Date(start.getTime() + index * 1000),
          end: new Date(start.getTime() + (index + 1) * 1000), steps: 1,
        }));
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
  }), /32 MiB.*memory guard/);
});

test("prefetch construction failure disposes an exceptional spool created by an earlier recursive bound", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bara-scoring-test-"));
  let scratchDirectoriesCreated = 0;
  const row = (userId, index) => ({
    id: `${userId}-sample-${index}`,
    ordinal: userId === "user-1" ? 0 : 1,
    userId,
    start: new Date(start.getTime() + index * 1000),
    end: new Date(start.getTime() + (index + 1) * 1000),
    steps: 1,
  });
  try {
    await assert.rejects(prefetchRaceScoringModels({
      races: [{
        id: "race-construction-failure", startedAt: start, powerupsEnabled: false,
        participants: [
          { id: "participant-1", userId: "user-1" },
          { id: "participant-2", userId: "user-2" },
        ],
      }],
      now: new Date("2026-08-10T04:00:00Z"),
      strictWorkerMode: true,
      maxUsersPerChunk: 2,
      maxSampleRowsPerChunk: 2,
      maxRetainedSampleRowsPerUser: 1,
      createScoringScratchDirectory() {
        scratchDirectoriesCreated += 1;
        return fs.mkdtempSync(path.join(scratchRoot, "spool-"));
      },
      stepSampleModel: {
        async findRowsForUserRanges(bounds, { cursor }) {
          if (bounds.length === 2) return [row("user-1", 0), row("user-2", 0)];
          if (bounds[0].userId === "user-2") throw new Error("second bound failed");
          return cursor ? [] : [row("user-1", 0), row("user-1", 1)];
        },
      },
      stepsModel: { async findByUserIdsAndDateRange() { return []; } },
      raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
    }), /second bound failed/);
    assert.equal(scratchDirectoriesCreated, 1,
      "the first exceptional bound must have created its owned scratch spool");
    assert.deepEqual(fs.readdirSync(scratchRoot), [],
      "a spool created before the later bound failed must be removed immediately");
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("deferred worker sampling retains only the active whole-user page and discards it", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const participants = Array.from({ length: 500 }, (_, index) => ({
    id: `participant-${index}`, userId: `user-${index}`, joinedAt: start,
  }));
  let reads = 0;
  const scoped = await prefetchRaceScoringModels({
    races: [{ id: "race-500", startedAt: start, powerupsEnabled: false, participants }],
    now: new Date("2026-08-10T04:00:00Z"),
    strictWorkerMode: true,
    deferredSampleLoading: true,
    stepSampleModel: {
      async findRowsForUserRanges(bounds) {
        reads += 1;
        return bounds.map((bound) => ({
          id: `sample-${bound.ordinal}`, ordinal: bound.ordinal,
          userId: bound.userId, start, end: new Date(start.getTime() + 60_000), steps: 1,
        }));
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
  });
  assert.equal(reads, 0, "deferred mode must not retain all 500 timelines up front");
  let peak = 0;
  for (let offset = 0; offset < participants.length; offset += 25) {
    const users = participants.slice(offset, offset + 25).map((row) => row.userId);
    await scoped.stepSampleModel.prepareUsers(users);
    peak = Math.max(peak, scoped.stepSampleModel.retainedUserCount());
    scoped.stepSampleModel.releaseUsers(users);
  }
  assert.equal(peak, 25);
  assert.equal(scoped.stepSampleModel.retainedUserCount(), 0);
  assert.equal(reads, 20, "SQL grows by whole-user pages, not participants");
});
