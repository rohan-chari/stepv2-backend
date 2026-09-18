const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

describe("step pool telemetry preserves public behavior", () => {
  let server;
  let measurements;

  before(async () => {
    measurements = [];
    server = await startServer({
      stepTelemetry: {
        recordStepRequest(value) { measurements.push(value); },
        recordStepPhase() {},
      },
    });
  });

  after(async () => server.close());

  beforeEach(async () => {
    await cleanDatabase();
    measurements.length = 0;
  });

  it("records aggregate legacy intake after the real HTTP/DB handler chain", async () => {
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/steps", {
      token: user.token,
      body: { date: "2026-08-29", steps: 4321, skipRaceResolution: true },
    });
    assert.equal(response.status, 200);
    const saved = await prisma.step.findUnique({ where: { userId_date: { userId: user.user.id, date: new Date("2026-08-29") } } });
    assert.equal(saved.steps, 4321);
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0].endpoint, "steps");
    assert.equal(measurements[0].outcome, "success");
    assert.ok(measurements[0].transactionDurationMs >= 0);
    assert.equal(JSON.stringify(measurements).includes(user.user.id), false);
  });

  it("attributes sync-v2's outer transaction once without changing its 202 response", async () => {
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: user.token,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000042" },
      body: { date: "2026-08-29", steps: 2222, samples: [] },
    });
    assert.equal(response.status, 202);
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0].endpoint, "sync-v2");
    assert.equal(measurements[0].outcome, "success");
    assert.ok(measurements[0].transactionDurationMs >= 0);
  });
});
