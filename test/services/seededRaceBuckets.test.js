const test = require("node:test");
const assert = require("node:assert/strict");
const { planBuckets } = require("../../src/modules/races/services/seededRaceBuckets");

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `user-${String(index).padStart(2, "0")}`,
    matchSteps: index * 100,
  }));
}

test("bucket plan is permutation-independent, capped, and rebalances a trailing singleton", () => {
  const people = candidates(16);
  const forward = planBuckets(people, []).map((bucket) => bucket.map((row) => row.userId));
  const reverse = planBuckets([...people].reverse(), []).map((bucket) => bucket.map((row) => row.userId));
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.map((bucket) => bucket.length), [8, 8]);
});

test("direct accepted friends co-locate only when their step totals fit the skill band", () => {
  const people = [
    { userId: "a", matchSteps: 1000 },
    { userId: "b", matchSteps: 2500 },
    { userId: "c", matchSteps: 10000 },
  ];
  const within = planBuckets(people, [{ userAId: "a", userBId: "b" }]);
  assert.ok(within.some((bucket) => bucket.some((row) => row.userId === "a") && bucket.some((row) => row.userId === "b")));
  const outside = planBuckets(people, [{ userAId: "a", userBId: "c" }]);
  assert.deepEqual(
    outside.map((bucket) => bucket.map((row) => row.userId)),
    planBuckets(people, []).map((bucket) => bucket.map((row) => row.userId)),
    "out-of-band friendship creates no placement constraint"
  );
});
