const assert = require("node:assert/strict");
const test = require("node:test");

const { StepSample } = require("../../src/modules/steps/models/stepSample");

const sample = (start, steps = 100, sourceId = "source-1") => ({
  periodStart: `2026-09-15T${String(start).padStart(2, "0")}:00:00.000Z`,
  periodEnd: `2026-09-15T${String(start + 1).padStart(2, "0")}:00:00.000Z`,
  steps,
  sourceName: "test",
  sourceId,
});

test("append-only proof uses one authoritative read and the bulk insert path", async () => {
  const queries = [];
  const executes = [];
  const client = {
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      return [{ latestEnd: new Date("2026-09-15T10:00:00.000Z"), start: null }];
    },
    async $executeRawUnsafe(sql) {
      executes.push(sql);
      return 1;
    },
  };

  const result = await StepSample.reconcileBatchOn(
    client,
    "user-1",
    [sample(10), sample(11)],
    Date.parse("2026-09-15T12:00:00.000Z"),
    { appendOnlyFastPath: true, scoringInputLockHeld: true, manageScoringVersion: false },
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0], /ORDER BY period_end DESC/);
  assert.equal(executes.length, 1);
  assert.match(executes[0], /INSERT INTO step_samples/);
  assert.doesNotMatch(executes[0], /DELETE FROM step_samples/);
  assert.deepEqual(result, {
    storageChanged: true,
    scoringChanged: true,
    earliestChangedStartMs: Date.parse("2026-09-15T10:00:00.000Z"),
  });
});

test("overlap, replay, and out-of-order batches use the existing reconciliation write", async () => {
  const executes = [];
  const client = {
    async $queryRawUnsafe() {
      return [{
        latestEnd: new Date("2026-09-15T12:00:00.000Z"),
        start: new Date("2026-09-15T10:00:00.000Z"),
        end: new Date("2026-09-15T11:00:00.000Z"),
        steps: 50,
        sourceName: "test",
        sourceId: "source-old",
        sourceDeviceId: null,
        deviceModel: null,
        recordingMethod: null,
        metadata: null,
      }];
    },
    async $executeRawUnsafe(sql) {
      executes.push(sql);
      return 1;
    },
  };

  const result = await StepSample.reconcileBatchOn(
    client,
    "user-1",
    [sample(10, 75, "source-correction")],
    Date.parse("2026-09-15T12:00:00.000Z"),
    { appendOnlyFastPath: true, manageScoringVersion: false },
  );

  assert.equal(executes.length, 1);
  assert.match(executes[0], /WITH deleted AS/);
  assert.match(executes[0], /DELETE FROM step_samples/);
  assert.equal(result.storageChanged, true);
});

test("a direct fast-path caller acquires the scoring lock before proving coverage", async () => {
  const queries = [];
  const client = {
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      if (/WITH locked AS MATERIALIZED/.test(sql)) {
        return [{
          generation: 1n,
          sourceQueueSemanticsGeneration: 1n,
          scoringWatermark: null,
          nextSampleBoundaryAt: null,
          historicalRawRevision: null,
          historicalRawCompleteGeneration: null,
          historicalRawProtectedCutoff: null,
          inserted: false,
          dbNowMs: Date.now(),
        }];
      }
      return [{ latestEnd: new Date("2026-09-15T10:00:00.000Z"), start: null }];
    },
    async $executeRawUnsafe() { return 1; },
  };

  await StepSample.reconcileBatchOn(
    client,
    "user-1",
    [sample(10)],
    Date.parse("2026-09-15T12:00:00.000Z"),
    { appendOnlyFastPath: true, manageScoringVersion: false },
  );

  assert.equal(queries.length, 2);
  assert.match(queries[0], /FOR NO KEY UPDATE/);
  assert.match(queries[1], /ORDER BY period_end DESC/);
});

