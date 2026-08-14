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
