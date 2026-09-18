const assert = require("node:assert/strict");
const test = require("node:test");
const {
  serializeRaceResolutionStatus,
} = require("../../src/modules/races/models/raceResolutionJob");

const baseJob = {
  id: "job-1",
  userId: "u1",
  generation: 14,
  state: "SUCCEEDED",
  requestedAt: new Date("2026-07-17T18:22:10.000Z"),
  startedAt: new Date("2026-07-17T18:22:10.250Z"),
  completedAt: new Date("2026-07-17T18:22:11.830Z"),
  retryAt: null,
};

test("serializes the current generation state verbatim", () => {
  const s = serializeRaceResolutionStatus(baseJob, 14);
  assert.equal(s.state, "SUCCEEDED");
  assert.equal(s.generation, 14);
  assert.equal(s.jobId, "job-1");
  assert.ok(s.completedAt);
});

test("an older polled generation reports SUPERSEDED with null timestamps", () => {
  const s = serializeRaceResolutionStatus({ ...baseJob, generation: 20, state: "RUNNING" }, 14);
  assert.equal(s.state, "SUPERSEDED");
  assert.equal(s.generation, 14); // echoes the requested generation
  assert.equal(s.startedAt, null);
  assert.equal(s.completedAt, null);
  assert.equal(s.retryAt, null);
});

test("null for a missing job", () => {
  assert.equal(serializeRaceResolutionStatus(null, 1), null);
});
