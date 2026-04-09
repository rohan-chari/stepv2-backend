const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecordStepSamples,
  StepSampleError,
} = require("../../src/commands/recordStepSamples");

function makeDeps() {
  const saved = [];

  return {
    saved,
    deps: {
      StepSample: {
        async upsertBatch(userId, samples) {
          saved.push(...samples.map((sample) => ({ userId, ...sample })));
        },
      },
      resolveRaceState: async () => {},
    },
  };
}

test("rejects samples marked as manual", async () => {
  const ctx = makeDeps();
  const record = buildRecordStepSamples(ctx.deps);

  await assert.rejects(
    () =>
      record({
        userId: "user-1",
        samples: [
          {
            periodStart: "2026-04-09T14:28:00.000Z",
            periodEnd: "2026-04-09T14:28:00.000Z",
            steps: 10000,
            recordingMethod: "manual",
            sourceName: "Health",
            sourceId: "com.apple.Health",
          },
        ],
      }),
    (err) => {
      assert.ok(err instanceof StepSampleError);
      assert.equal(err.message, "manual step samples are not allowed");
      return true;
    }
  );

  assert.equal(ctx.saved.length, 0);
});
