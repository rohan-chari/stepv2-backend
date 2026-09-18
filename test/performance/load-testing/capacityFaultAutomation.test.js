const assert = require("node:assert/strict");
const test = require("node:test");

const { faultPlan } = require("../../../scripts/lima-capacity");

test("capacity fault plans target only disposable containers and capture recovery", () => {
  assert.deepEqual(faultPlan({ instance: "step-capacity", scenario: "redis-outage", durationSeconds: 60 }), {
    scenario: "redis-outage", target: "step-capacity-redis", durationSeconds: 60,
    action: "stop-start", requiresRecovery: true,
  });
  assert.deepEqual(faultPlan({ instance: "step-capacity", scenario: "worker-restart", durationSeconds: 60 }), {
    scenario: "worker-restart", target: "step-capacity-backend", durationSeconds: 0,
    action: "SIGUSR2", requiresRecovery: true,
  });
  assert.throws(() => faultPlan({ instance: "../prod", scenario: "redis-outage" }), /safe disposable/);
});
