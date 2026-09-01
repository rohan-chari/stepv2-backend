const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AdmissionTimeoutError,
  createBoundedAdmission,
} = require("../../src/shared/admission/boundedAdmission");

test("bounded admission caps active work and serves queued work in FIFO order", async () => {
  const admission = createBoundedAdmission({ concurrency: 2, maximumQueued: 3, waitMs: 1000 });
  const first = await admission.acquire();
  const second = await admission.acquire();
  const order = [];
  const third = admission.acquire().then((release) => { order.push("third"); return release; });
  const fourth = admission.acquire().then((release) => { order.push("fourth"); return release; });

  assert.deepEqual(admission.snapshot(), { active: 2, queued: 2, admitted: 2, rejected: 0 });
  second();
  const releaseThird = await third;
  assert.deepEqual(order, ["third"]);
  releaseThird();
  const releaseFourth = await fourth;
  assert.deepEqual(order, ["third", "fourth"]);
  releaseFourth();
  first();
  assert.equal(admission.snapshot().active, 0);
});

test("bounded admission rejects queue overflow and wait expiry without running work", async () => {
  let current = 0;
  const timers = [];
  const admission = createBoundedAdmission({
    concurrency: 1,
    maximumQueued: 1,
    waitMs: 250,
    nowMs: () => current,
    setTimer(callback) { timers.push(callback); return callback; },
    clearTimer() {},
  });
  const release = await admission.acquire();
  const queued = admission.acquire();
  await assert.rejects(admission.acquire(), AdmissionTimeoutError);
  current = 251;
  timers.shift()();
  await assert.rejects(queued, AdmissionTimeoutError);
  release();
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, admitted: 1, rejected: 2 });
});
