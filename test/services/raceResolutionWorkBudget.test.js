const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionWorkBudget,
} = require("../../src/modules/races/services/raceResolutionWorkBudget");

test("shared resolution budget never runs more than two core/post handlers", async () => {
  const budget = buildRaceResolutionWorkBudget({ maxActive: 2 });
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const run = (lane) =>
    budget.run(lane, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    });

  const work = [run("core"), run("post"), run("core"), run("post")];
  await new Promise(setImmediate);
  assert.equal(active, 2);
  releases.shift()();
  await new Promise(setImmediate);
  assert.equal(active, 2);
  releases.shift()();
  await new Promise(setImmediate);
  releases.shift()();
  await new Promise(setImmediate);
  releases.shift()();
  await Promise.all(work);
  assert.equal(maxActive, 2);
});

test("a queued core handler gets the next free slot after one post claim", async () => {
  const budget = buildRaceResolutionWorkBudget({ maxActive: 1 });
  const order = [];
  let releaseFirst;
  const first = budget.run("post", async () => {
    order.push("post-1");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  });
  await new Promise(setImmediate);

  const secondPost = budget.run("post", async () => order.push("post-2"));
  const core = budget.run("core", async () => order.push("core"));
  releaseFirst();
  await Promise.all([first, secondPost, core]);

  assert.deepEqual(order, ["post-1", "core", "post-2"]);
});

test("budget rejects unknown lane names", async () => {
  const budget = buildRaceResolutionWorkBudget();
  await assert.rejects(() => budget.run("delivery", async () => {}), /invalid lane/);
});

// Semaphore scheduling is an in-process property: hold handlers at a real
// promise barrier rather than infer concurrency from HTTP response timing.
test("configured three-slot budget runs three core/post handlers but not four", async () => {
  const budget = buildRaceResolutionWorkBudget({ maxActive: 3 });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let active = 0;
  let peak = 0;
  const work = ["core", "post", "core", "post", "core"].map(lane => budget.run(lane, async () => {
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
  }));
  await new Promise(setImmediate);
  try {
    assert.equal(active, 3);
    assert.equal(budget.snapshot().maxActive, 3);
  } finally {
    release();
    await Promise.all(work);
  }
  assert.equal(peak, 3);
  assert.equal(budget.snapshot().active, 0);
});

test("process startup honors concurrency 3 and returning the env to 2", () => {
  const { execFileSync } = require("node:child_process");
  const modulePath = require.resolve("../../src/modules/races/services/raceResolutionWorkBudget");
  for (const [value, expected] of [["3",3], ["2",2], ["1",1], ["",2], ["garbage",2], ["1.5",2], ["99",2]]) {
    const result = execFileSync(process.execPath, ["-e",
      `console.log(require(${JSON.stringify(modulePath)}).raceResolutionWorkBudget.snapshot().maxActive)`], {
      env: { ...process.env, ASYNC_RACE_RESOLUTION_CONCURRENCY: value }, encoding: "utf8",
    });
    assert.equal(result.trim(), String(expected), `setting ${JSON.stringify(value)}`);
  }
});

test("failed work releases its slot at concurrency three", async () => {
  const budget = buildRaceResolutionWorkBudget({ maxActive: 3 });
  const results = await Promise.allSettled(Array.from({length: 9}, (_, i) =>
    budget.run(i % 2 ? "post" : "core", async () => { if (i % 2) throw new Error("expected"); return i; })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
  assert.equal(budget.snapshot().active, 0);
});
