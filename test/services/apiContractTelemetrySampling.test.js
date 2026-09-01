const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createApiContractLogSampler,
} = require("../../src/shared/http/apiContractTelemetry");

test("contract telemetry logs the first and one in every hundred successes", () => {
  const shouldLog = createApiContractLogSampler({ successEvery: 100 });
  const decisions = Array.from({ length: 205 }, () => shouldLog({
    contract: "home-shell-v1",
    statusCode: 200,
  }));
  assert.deepEqual(decisions.flatMap((value, index) => value ? [index] : []), [0, 100, 200]);
});

test("contract telemetry always logs errors and samples contracts independently", () => {
  const shouldLog = createApiContractLogSampler({ successEvery: 100 });
  assert.equal(shouldLog({ contract: "home-shell-v1", statusCode: 500 }), true);
  assert.equal(shouldLog({ contract: "home-shell-v1", statusCode: 200 }), true);
  assert.equal(shouldLog({ contract: "race-list-v1", statusCode: 200 }), true);
  assert.equal(shouldLog({ contract: null, statusCode: 200 }), false);
});
