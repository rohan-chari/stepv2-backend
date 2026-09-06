const assert = require("node:assert/strict");
const { test } = require("node:test");
const { planningInputModels } = require("../../src/modules/races/services/raceResolutionPlanningInputs");
const { GlobalStepEvent } = require("../../src/modules/steps/models/globalStepEvent");

// Capability/fallback guards on internal snapshots cannot be selected by an
// HTTP client. Scoring correctness itself is covered by the HTTP worker suite.
test("incomplete and unversioned planning inputs leave authoritative models unchanged", () => {
  for (const fingerprint of [null, {}, { globalEvents: [], inputs: [], participants: [], race: { id: "race" } }]) {
    assert.deepEqual(planningInputModels({ fingerprint, validUntil: new Date(2000) }), {});
  }
});

test("incompatible race, range, membership, or missing-impact policy falls back to authoritative event reads", async t => {
  const calls = [];
  t.mock.method(GlobalStepEvent, "findEligibleByRace", async options => { calls.push(options); return "authoritative"; });
  const fingerprint = {
    race: { id: "race", startedAt: 500 }, participants: [{ userId: "user", joinedAt: 600 }],
    globalEvents: [], inputs: [{ userId: "user", generation: "3" }],
    scoringReadSnapshot: { schema: 1, raceId: "race", asOf: 1000, through: 3000 },
  };
  const models = planningInputModels({ fingerprint, validUntil: new Date(2000) });
  const base = { raceId: "race", userIds: ["user"], rangeStart: new Date(500), rangeEnd: new Date(1500) };
  assert.deepEqual(await models.GlobalStepEvent.findEligibleByRace(base), new Map([["user", []]]));
  for (const override of [
    { raceId: "another" }, { userIds: ["new-member"] }, { rangeStart: new Date(499) },
    { rangeEnd: new Date(999) }, { rangeEnd: new Date(2000) },
    { allowMissingImpactEventUserKeys: new Set(["event:user"]) },
  ]) assert.equal(await models.GlobalStepEvent.findEligibleByRace({ ...base, ...override }), "authoritative");
  assert.equal(calls.length, 6);
});

test("missing user version coverage uses the normal generation lookup", async () => {
  let calls = 0;
  const models = planningInputModels({
    fingerprint: {
      race: { id: "race", startedAt: 0 }, participants: [], globalEvents: [],
      inputs: [{ userId: "covered", generation: "4" }],
      scoringReadSnapshot: { schema: 1, raceId: "race", asOf: 0, through: 2000 },
    }, validUntil: new Date(1000),
    scoringInputVersionModel: { async findMany() { calls++; return [{ userId: "new", generation: 9n }]; } },
  });
  assert.deepEqual(await models.scoringInputVersionModel.findMany({ where: { userId: { in: ["covered"] } } }), [{ userId: "covered", generation: 4n }]);
  assert.deepEqual(await models.scoringInputVersionModel.findMany({ where: { userId: { in: ["new"] } } }), [{ userId: "new", generation: 9n }]);
  assert.equal(calls, 1);
});
