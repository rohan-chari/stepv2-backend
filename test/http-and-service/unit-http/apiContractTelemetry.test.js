const assert = require("node:assert/strict");
const test = require("node:test");
const { buildApiContractMetric } = require("../../src/shared/http/apiContractTelemetry");

test("contract telemetry is one PII-free bounded record", () => {
  const metric = buildApiContractMetric({
    body: {
      contract: "race-message-streams-v1",
      messages: [{ id: "secret-message-id", body: "secret body" }],
      activity: [],
    },
    statusCode: 200,
    durationMs: 12,
    request: { query: { activity: "false" } },
  });
  assert.deepEqual(metric.resultCounts, { messages: 1, activity: 0 });
  assert.equal(metric.messageMode, "activity_only");
  const line = JSON.stringify(metric);
  assert.doesNotMatch(line, /secret/);
  assert.equal(line.includes("\n"), false);
});

test("legacy bodies do not emit cleanup telemetry", () => {
  assert.equal(buildApiContractMetric({ body: { races: [] }, statusCode: 200 }), null);
});
