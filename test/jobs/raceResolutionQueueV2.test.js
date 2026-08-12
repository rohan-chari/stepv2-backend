const assert = require("node:assert/strict");
const test = require("node:test");

const {
  runBoundedRaceResolutionJobs,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

test("one lane does not start a second race-resolution job before the first settles", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;

  const ticking = runBoundedRaceResolutionJobs(1, async () => {
    calls += 1;
    await first;
    return { id: "first" };
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal(await ticking, 1);
});

test("two lanes claim and process distinct race-resolution jobs concurrently", async () => {
  const releases = [];
  let calls = 0;
  const started = [];

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    const id = ++calls;
    started.push(id);
    await new Promise((resolve) => releases.push(resolve));
    return { id: `job-${id}` };
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  releases.forEach((release) => release());
  assert.equal(await ticking, 2);
});

test("an empty lane does not prevent a claimed sibling job from completing", async () => {
  let calls = 0;
  const completed = await runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    return calls === 1 ? { id: "only-job" } : null;
  });

  assert.equal(completed, 1);
  assert.equal(calls, 2);
});

test("a failed lane waits for its running sibling before surfacing the failure", async () => {
  let releaseSibling;
  const sibling = new Promise((resolve) => {
    releaseSibling = resolve;
  });
  let calls = 0;
  let settled = false;

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    if (calls === 1) throw new Error("claim database unavailable");
    await sibling;
    return { id: "sibling" };
  });
  ticking.catch(() => {
    settled = true;
  });

  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(settled, false, "the helper must retain the sibling lane");

  releaseSibling();
  await assert.rejects(ticking, /claim database unavailable/);
  assert.equal(settled, true);
});
