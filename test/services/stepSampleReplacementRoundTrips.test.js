const assert = require("node:assert/strict");
const test = require("node:test");

const {
  replaceSamplesOn,
} = require("../../src/modules/steps/models/stepSample");

test("overlap deletion and sample persistence share one database round trip", async () => {
  const calls = [];
  const client = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 1;
    },
  };
  const samples = [{
    periodStart: "2026-09-01T08:00:00.000Z",
    periodEnd: "2026-09-01T09:00:00.000Z",
    steps: 123,
    recordingMethod: "automatic",
  }];

  await replaceSamplesOn(client, "user-1", samples);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM step_samples/);
  assert.match(calls[0].sql, /INSERT INTO step_samples/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id, period_start\) DO UPDATE/);
});
