const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXPECTED_LOGICAL_OWNERS,
  GENERATION_CAPABILITIES,
  exactCensusReady,
} = require("../../src/modules/steps/models/globalStepEventGeneration");

function owner(logicalOwnerId, overrides = {}) {
  return {
    logicalOwnerId,
    generation: 2,
    capabilities: [...GENERATION_CAPABILITIES],
    ...overrides,
  };
}

test("generation readiness requires the exact split production owner census", () => {
  assert.deepEqual(EXPECTED_LOGICAL_OWNERS, [
    "http:0",
    "http:1",
    "step:0",
    "resolution:0",
    "event:0",
    "notification:0",
    "cron:0",
  ]);

  const complete = EXPECTED_LOGICAL_OWNERS.map((id) => owner(id));
  assert.equal(exactCensusReady(complete), true);

  assert.equal(exactCensusReady(complete.slice(0, -1)), false);
  assert.equal(exactCensusReady([...complete, owner("extra:0")]), false);
  assert.equal(
    exactCensusReady(complete.map((row) =>
      row.logicalOwnerId === "event:0" ? owner("event:0", { generation: 1 }) : row
    )),
    false,
  );
});

test("generation readiness fails when any split owner lacks a required capability", () => {
  const rows = EXPECTED_LOGICAL_OWNERS.map((id) => owner(id));
  rows.find((row) => row.logicalOwnerId === "notification:0").capabilities =
    GENERATION_CAPABILITIES.filter((capability) => capability !== "TOKEN_LIFECYCLE");
  assert.equal(exactCensusReady(rows), false);
});
