const assert = require("node:assert/strict");
const test = require("node:test");

const { computeRankings } = require("../../src/utils/rankings");

test("two participants, clear winner", () => {
  const result = computeRankings([
    { id: "a", totalSteps: 8000 },
    { id: "b", totalSteps: 5000 },
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].id, "a");
  assert.equal(result[0].rank, 1);
  assert.equal(result[1].id, "b");
  assert.equal(result[1].rank, 2);
});

test("two participants, tied steps", () => {
  const result = computeRankings([
    { id: "a", totalSteps: 5000 },
    { id: "b", totalSteps: 5000 },
  ]);

  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 1);
});

test("both zero steps (start of week)", () => {
  const result = computeRankings([
    { id: "a", totalSteps: 0 },
    { id: "b", totalSteps: 0 },
  ]);

  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 1);
});

test("single participant", () => {
  const result = computeRankings([{ id: "a", totalSteps: 3000 }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].rank, 1);
});

test("four participants with ties (future multi-participant)", () => {
  const result = computeRankings([
    { id: "a", totalSteps: 8000 },
    { id: "b", totalSteps: 5000 },
    { id: "c", totalSteps: 5000 },
    { id: "d", totalSteps: 3000 },
  ]);

  const byId = Object.fromEntries(result.map((r) => [r.id, r.rank]));
  assert.equal(byId["a"], 1);
  assert.equal(byId["b"], 2);
  assert.equal(byId["c"], 2);
  assert.equal(byId["d"], 4);
});

test("empty array", () => {
  const result = computeRankings([]);
  assert.deepEqual(result, []);
});

test("preserves totalSteps in output", () => {
  const result = computeRankings([
    { id: "a", totalSteps: 8000 },
    { id: "b", totalSteps: 5000 },
  ]);

  assert.equal(result[0].totalSteps, 8000);
  assert.equal(result[1].totalSteps, 5000);
});
