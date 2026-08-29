const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const test = require("node:test");

const { createStepsRouter } = require("../../src/modules/steps/routes/steps");
const {
  recordStepTelemetryPhase,
  markStepTelemetryTransactionError,
} = require("../../src/shared/observability/stepTelemetryContext");

async function exercise(dependencies, path, body) {
  const app = express();
  app.use(express.json());
  app.use("/steps", createStepsRouter({
    requireAuth(req, _res, next) { req.user = { id: "private-user" }; next(); },
    ...dependencies,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "00000000-0000-4000-8000-000000000000" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("legacy route telemetry is aggregate-only and preserves the wire response", async () => {
  const metrics = [];
  const response = await exercise({
    stepTelemetry: { recordStepRequest: (value) => metrics.push(value) },
    recordSteps: async () => ({ id: "row", steps: 123 }),
  }, "/steps", { steps: 123, date: "2026-08-29" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { record: { id: "row", steps: 123 } });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].endpoint, "steps");
  assert.equal(metrics[0].outcome, "success");
  assert.deepEqual(Object.keys(metrics[0]).sort(), ["authenticationDurationMs", "durationMs", "endpoint", "outcome"]);
});

test("validation and pool-checkout failures receive bounded classifications", async () => {
  const metrics = [];
  await exercise({ stepTelemetry: { recordStepRequest: (value) => metrics.push(value) } }, "/steps", {});
  const poolError = new Error("timeout exceeded when trying to connect");
  await exercise({
    stepTelemetry: { recordStepRequest: (value) => metrics.push(value) },
    recordStepSamples: async () => { throw poolError; },
  }, "/steps/samples", { samples: [] });
  assert.equal(metrics[0].outcome, "validation_4xx");
  assert.equal(metrics[1].outcome, "pool_checkout_timeout");
});

test("outer transaction timing is attributed once to the request aggregate", async () => {
  const metrics = [];
  await exercise({
    stepTelemetry: { recordStepRequest: (value) => metrics.push(value) },
    recordSteps: async () => {
      recordStepTelemetryPhase("transaction_total", 42);
      return { id: "row" };
    },
  }, "/steps", { steps: 1, date: "2026-08-29" });
  assert.equal(metrics[0].transactionDurationMs, 42);
});

test("uncategorized caught 500s are server failures while marked transaction-boundary errors stay distinct", async () => {
  const metrics = [];
  await exercise({
    stepTelemetry: { recordStepRequest: (value) => metrics.push(value) },
    recordStepSamples: async () => { throw new Error("post-transaction failure"); },
  }, "/steps/samples", { samples: [] });

  await exercise({
    stepTelemetry: { recordStepRequest: (value) => metrics.push(value) },
    recordStepSamples: async () => {
      const error = new Error("transaction boundary failure");
      markStepTelemetryTransactionError(error);
      throw error;
    },
  }, "/steps/samples", { samples: [] });

  assert.equal(metrics[0].outcome, "server_5xx");
  assert.equal(metrics[1].outcome, "transaction_error");
});
