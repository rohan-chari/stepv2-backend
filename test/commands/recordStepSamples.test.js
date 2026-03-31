const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecordStepSamples, StepSampleError } = require("../../src/commands/recordStepSamples");

function makeDeps() {
  const saved = [];

  return {
    saved,
    deps: {
      StepSample: {
        async upsertBatch(userId, samples) {
          saved.push(...samples.map((s) => ({ userId, ...s })));
        },
      },
    },
  };
}

// ===========================================================================
// Overlap removal
// ===========================================================================

test("removes broad sample when granular samples exist within it", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await record({
    userId: "user-1",
    samples: [
      { periodStart: "2026-03-30T20:30:00Z", periodEnd: "2026-03-30T20:45:00Z", steps: 1044 },
      { periodStart: "2026-03-30T20:34:40Z", periodEnd: "2026-03-30T20:34:48Z", steps: 11 },
      { periodStart: "2026-03-30T20:34:48Z", periodEnd: "2026-03-30T20:44:43Z", steps: 904 },
    ],
  });

  // The 15-min bucket should be dropped because it contains the granular segments
  assert.equal(ctx.saved.length, 2);
  assert.ok(ctx.saved.every((s) => s.steps !== 1044));
});

test("keeps non-overlapping samples untouched", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await record({
    userId: "user-1",
    samples: [
      { periodStart: "2026-03-30T14:00:00Z", periodEnd: "2026-03-30T14:15:00Z", steps: 500 },
      { periodStart: "2026-03-30T14:15:00Z", periodEnd: "2026-03-30T14:30:00Z", steps: 300 },
    ],
  });

  assert.equal(ctx.saved.length, 2);
});

test("keeps broad sample when no granular samples overlap", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await record({
    userId: "user-1",
    samples: [
      { periodStart: "2026-03-30T20:00:00Z", periodEnd: "2026-03-30T20:15:00Z", steps: 1721 },
    ],
  });

  assert.equal(ctx.saved.length, 1);
  assert.equal(ctx.saved[0].steps, 1721);
});

test("removes multiple overlapping broad samples", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await record({
    userId: "user-1",
    samples: [
      // Two broad 15-min buckets
      { periodStart: "2026-03-30T19:30:00Z", periodEnd: "2026-03-30T19:45:00Z", steps: 1468 },
      { periodStart: "2026-03-30T19:45:00Z", periodEnd: "2026-03-30T20:00:00Z", steps: 1629 },
      // Granular segments within the first bucket
      { periodStart: "2026-03-30T19:38:38Z", periodEnd: "2026-03-30T19:41:27Z", steps: 80 },
      // Granular segment within the second bucket
      { periodStart: "2026-03-30T19:52:06Z", periodEnd: "2026-03-30T19:54:32Z", steps: 268 },
    ],
  });

  // Both broad buckets should be removed
  assert.equal(ctx.saved.length, 2);
  assert.ok(ctx.saved.every((s) => s.steps !== 1468 && s.steps !== 1629));
});

test("single sample passes through", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await record({
    userId: "user-1",
    samples: [
      { periodStart: "2026-03-30T08:15:00Z", periodEnd: "2026-03-30T08:30:00Z", steps: 22 },
    ],
  });

  assert.equal(ctx.saved.length, 1);
});

// ===========================================================================
// Validation
// ===========================================================================

test("rejects empty samples array", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await assert.rejects(
    () => record({ userId: "user-1", samples: [] }),
    (err) => {
      assert.ok(err instanceof StepSampleError);
      return true;
    }
  );
});

test("rejects sample missing periodStart", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await assert.rejects(
    () => record({ userId: "user-1", samples: [{ periodEnd: "2026-03-30T09:00:00Z", steps: 10 }] }),
    (err) => {
      assert.ok(err instanceof StepSampleError);
      return true;
    }
  );
});
