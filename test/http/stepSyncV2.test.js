const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const express = require("express");
const { createStepsRouter } = require("../../src/routes/steps");
const {
  StepSyncValidationError,
} = require("../../src/utils/stepSyncCanonical");
const { StepSyncConflictError } = require("../../src/commands/recordStepSyncV2");

const AUTH = (req, _res, next) => {
  req.user = { id: "user-1" };
  req.timeZone = "America/New_York";
  next();
};

async function withServer(deps, run) {
  const app = express();
  app.use(express.json());
  app.use("/steps", createStepsRouter({ requireAuth: AUTH, ...deps }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const OK_RESPONSE = {
  record: { id: "step-1", userId: "user-1", date: "2026-07-17T00:00:00.000Z", steps: 12345, stepGoal: 5000 },
  sampleCount: 9,
  uploaderReconciliation: { state: "CURRENT", resolvedRaceCount: 18, boxStateCurrent: true },
  raceResolution: { jobId: "job-1", generation: 14, state: "QUEUED", requestedAt: "2026-07-17T18:22:10.000Z" },
};

const body = { date: "2026-07-17", steps: 12345, samples: [] };
const KEY = "123e4567-e89b-12d3-a456-426614174000";

test("POST /steps/sync-v2 returns 202 with the exact contract shape", async () => {
  await withServer({ recordStepSyncV2: async () => OK_RESPONSE }, async (base) => {
    const res = await fetch(`${base}/steps/sync-v2`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": KEY },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.deepEqual(json, OK_RESPONSE);
    assert.equal(json.uploaderReconciliation.state, "CURRENT");
    assert.equal(json.raceResolution.state, "QUEUED");
  });
});

test("ASYNC_RACE_RESOLUTION_DISABLED returns 503 ASYNC_DISABLED before any work", async () => {
  process.env.ASYNC_RACE_RESOLUTION_DISABLED = "true";
  let called = false;
  try {
    await withServer(
      { recordStepSyncV2: async () => { called = true; return OK_RESPONSE; } },
      async (base) => {
        const res = await fetch(`${base}/steps/sync-v2`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": KEY },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 503);
        const json = await res.json();
        assert.equal(json.code, "ASYNC_DISABLED");
      }
    );
  } finally {
    delete process.env.ASYNC_RACE_RESOLUTION_DISABLED;
  }
  assert.equal(called, false, "command must not run when disabled");
});

test("oversized body (>64 KiB) returns 413 STEP_SYNC_TOO_LARGE", async () => {
  let called = false;
  // Real >64 KiB body (still under the 100kb express.json outer limit) so the
  // route's content-length guard fires before any command work.
  const bigBody = JSON.stringify({ date: "2026-07-17", steps: 1, samples: [], _pad: "x".repeat(70000) });
  await withServer(
    { recordStepSyncV2: async () => { called = true; return OK_RESPONSE; } },
    async (base) => {
      const res = await fetch(`${base}/steps/sync-v2`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": KEY },
        body: bigBody,
      });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).code, "STEP_SYNC_TOO_LARGE");
    }
  );
  assert.equal(called, false, "command must not run for an oversized body");
});

test("validation error maps to 400 INVALID_STEP_SYNC", async () => {
  await withServer(
    { recordStepSyncV2: async () => { throw new StepSyncValidationError("bad date"); } },
    async (base) => {
      const res = await fetch(`${base}/steps/sync-v2`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": KEY },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "INVALID_STEP_SYNC");
    }
  );
});

test("idempotency conflict maps to 409 IDEMPOTENCY_CONFLICT", async () => {
  await withServer(
    { recordStepSyncV2: async () => { throw new StepSyncConflictError(); } },
    async (base) => {
      const res = await fetch(`${base}/steps/sync-v2`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": KEY },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "IDEMPOTENCY_CONFLICT");
    }
  );
});

// ── status endpoint ──
test("GET status: missing/invalid generation → 400 INVALID_GENERATION", async () => {
  await withServer({ RaceResolutionJob: { findById: async () => null } }, async (base) => {
    const res = await fetch(`${base}/steps/race-resolution/job-1`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_GENERATION");
  });
});

test("GET status: unknown or not-owned job → non-leaking 404", async () => {
  await withServer(
    { RaceResolutionJob: { findById: async () => ({ id: "job-1", userId: "someone-else", generation: 3 }) } },
    async (base) => {
      const res = await fetch(`${base}/steps/race-resolution/job-1?generation=3`);
      assert.equal(res.status, 404);
    }
  );
});

test("GET status: owner sees serialized state", async () => {
  const job = {
    id: "job-1",
    userId: "user-1",
    generation: 14,
    state: "SUCCEEDED",
    requestedAt: new Date("2026-07-17T18:22:10.000Z"),
    startedAt: new Date("2026-07-17T18:22:10.250Z"),
    completedAt: new Date("2026-07-17T18:22:11.830Z"),
    retryAt: null,
  };
  await withServer({ RaceResolutionJob: { findById: async () => job } }, async (base) => {
    const res = await fetch(`${base}/steps/race-resolution/job-1?generation=14`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.raceResolution.state, "SUCCEEDED");
    assert.equal(json.raceResolution.generation, 14);
  });
});

test("GET status: older polled generation reports SUPERSEDED", async () => {
  const job = {
    id: "job-1",
    userId: "user-1",
    generation: 20,
    state: "RUNNING",
    requestedAt: new Date("2026-07-17T18:30:00.000Z"),
    startedAt: new Date("2026-07-17T18:30:00.100Z"),
    completedAt: null,
    retryAt: null,
  };
  await withServer({ RaceResolutionJob: { findById: async () => job } }, async (base) => {
    const res = await fetch(`${base}/steps/race-resolution/job-1?generation=14`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.raceResolution.state, "SUPERSEDED");
    assert.equal(json.raceResolution.generation, 14);
    assert.equal(json.raceResolution.startedAt, null);
  });
});
