const assert = require("node:assert/strict");
const test = require("node:test");

const {
  workerOwnsProductionRefresh,
} = require("../../src/modules/races/queries/getRaceProgress");

test("production standings refresh stays off the HTTP request path", () => {
  assert.equal(workerOwnsProductionRefresh({
    hasInjectedDependencies: false,
    legacyReplayForTests: false,
  }), true);
  assert.equal(workerOwnsProductionRefresh({
    hasInjectedDependencies: true,
    legacyReplayForTests: false,
  }), false);
  assert.equal(workerOwnsProductionRefresh({
    hasInjectedDependencies: false,
    legacyReplayForTests: true,
  }), false);
});
