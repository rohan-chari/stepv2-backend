const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTokenLifecycleRequirementBatch,
} = require("../../src/modules/steps/models/globalStepEventGeneration");

test("simultaneous device registrations share one generation-read decision", async () => {
  let loads = 0;
  const batch = createTokenLifecycleRequirementBatch(async () => {
    loads += 1;
    return true;
  });
  const client = {};
  const values = await Promise.all(Array.from({ length: 100 }, () =>
    batch.load({ client, now: new Date() })));
  assert.equal(loads, 1);
  assert.equal(values.every(Boolean), true);
});

test("generation-read batching is isolated by database client", async () => {
  let loads = 0;
  const batch = createTokenLifecycleRequirementBatch(async () => {
    loads += 1;
    return false;
  });
  await Promise.all([
    batch.load({ client: {}, now: new Date() }),
    batch.load({ client: {}, now: new Date() }),
  ]);
  assert.equal(loads, 2);
});
