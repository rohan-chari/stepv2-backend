const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const {
  createStepsRouter,
  STEP_ADMISSION_CONCURRENCY,
} = require("../../src/modules/steps/routes/steps");
const { createBoundedAdmission } = require("../../src/shared/admission/boundedAdmission");

test("each HTTP worker reserves four of ten connections for app reads", () => {
  assert.equal(STEP_ADMISSION_CONCURRENCY, 6);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function workerHarness() {
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const app = express();
  app.use(express.json());
  app.use("/steps", createStepsRouter({
    requireAuth(req, _res, next) { req.user = { id: "synthetic-user" }; next(); },
    recordSteps: async ({ steps, date }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const gate = deferred();
      releases.push(() => { active -= 1; gate.resolve(); });
      await gate.promise;
      return { id: `record-${steps}`, userId: "synthetic-user", date: new Date(date), steps, stepGoal: 5000 };
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    releases,
    maximumActive: () => maximumActive,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("two HTTP workers independently cap step work while one excess request waits", async () => {
  const workers = await Promise.all([workerHarness(), workerHarness()]);
  try {
    const requests = workers.flatMap((worker, workerIndex) =>
      Array.from({ length: STEP_ADMISSION_CONCURRENCY + 1 }, (_, index) => fetch(`${worker.base}/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps: workerIndex * 10 + index + 1, date: "2026-08-30" }),
      }))
    );
    while (workers.some((worker) => worker.releases.length < STEP_ADMISSION_CONCURRENCY)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(
      workers.map((worker) => worker.maximumActive()),
      [STEP_ADMISSION_CONCURRENCY, STEP_ADMISSION_CONCURRENCY],
    );
    assert.deepEqual(
      workers.map((worker) => worker.releases.length),
      [STEP_ADMISSION_CONCURRENCY, STEP_ADMISSION_CONCURRENCY],
    );
    workers.forEach((worker) => worker.releases.shift()());
    while (workers.some((worker) => worker.releases.length < STEP_ADMISSION_CONCURRENCY)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(
      workers.map((worker) => worker.maximumActive()),
      [STEP_ADMISSION_CONCURRENCY, STEP_ADMISSION_CONCURRENCY],
    );
    workers.forEach((worker) => worker.releases.splice(0).forEach((release) => release()));
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200));
  } finally {
    workers.forEach((worker) => worker.releases.splice(0).forEach((release) => release()));
    await Promise.all(workers.map((worker) => worker.close()));
  }
});

test("pre-auth admission prevents excess authentication from reaching the database concurrently", async () => {
  const authGates = [];
  const app = express();
  app.use(express.json());
  app.use("/steps", createStepsRouter({
    stepAdmission: createBoundedAdmission({ concurrency: 1, maximumQueued: 2, waitMs: 1_000 }),
    requireAuth(req, _res, next) {
      const gate = deferred();
      authGates.push(() => { req.user = { id: "synthetic-user" }; gate.resolve(); });
      gate.promise.then(next);
    },
    recordSteps: async ({ steps, date }) => ({
      id: `record-${steps}`, userId: "synthetic-user", date: new Date(date), steps, stepGoal: 5000,
    }),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(`${base}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: 1, date: "2026-08-30" }),
    });
    while (authGates.length < 1) await new Promise((resolve) => setImmediate(resolve));

    const second = fetch(`${base}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: 2, date: "2026-08-30" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(authGates.length, 1);

    authGates.shift()();
    assert.equal((await first).status, 200);
    while (authGates.length < 1) await new Promise((resolve) => setImmediate(resolve));
    authGates.shift()();
    assert.equal((await second).status, 200);
  } finally {
    authGates.splice(0).forEach((release) => release());
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a completed durable write releases admission before response cleanup finishes", async () => {
  const cleanupGate = deferred();
  let cleanupStarted = false;
  const admission = createBoundedAdmission({ concurrency: 1, maximumQueued: 1, waitMs: 1_000 });
  const app = express();
  app.use(express.json());
  app.use("/steps", createStepsRouter({
    stepAdmission: admission,
    requireAuth(req, _res, next) { req.user = { id: "synthetic-user" }; next(); },
    recordSteps: async ({ steps, date }) => {
      const { releaseStepAdmission } = require("../../src/shared/observability/stepTelemetryContext");
      releaseStepAdmission();
      if (steps === 1) {
        cleanupStarted = true;
        await cleanupGate.promise;
      }
      return { id: `record-${steps}`, userId: "synthetic-user", date: new Date(date), steps, stepGoal: 5000 };
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(`${base}/steps`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: 1, date: "2026-08-30" }),
    });
    while (!cleanupStarted) await new Promise((resolve) => setImmediate(resolve));
    const second = await fetch(`${base}/steps`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: 2, date: "2026-08-30" }),
    });
    assert.equal(second.status, 200);
    assert.equal(admission.snapshot().active, 0);
    cleanupGate.resolve();
    assert.equal((await first).status, 200);
  } finally {
    cleanupGate.resolve();
    await new Promise((resolve) => server.close(resolve));
  }
});
