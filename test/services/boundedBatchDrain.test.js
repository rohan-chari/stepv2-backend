const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scheduleBoundedBatchDrain,
} = require("../../src/shared/batching/boundedBatchDrain");

test("arrivals during an awaited flush never start an overlapping drain", async () => {
  const queue = { pending: [], draining: false };
  let releaseFirst;
  let concurrent = 0;
  let maxConcurrent = 0;
  const seen = [];
  const flush = async (requests) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    seen.push(requests.map((request) => request.id));
    if (seen.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    concurrent -= 1;
    for (const request of requests) request.resolve();
  };
  const enqueue = (id) => new Promise((resolve, reject) => {
    queue.pending.push({ id, resolve, reject });
    scheduleBoundedBatchDrain(queue, flush);
  });

  const first = enqueue("first");
  await new Promise((resolve) => setImmediate(resolve));
  const second = enqueue("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(seen, [["first"], ["second"]]);
});
