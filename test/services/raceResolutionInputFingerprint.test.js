const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionInputFingerprint,
} = require("../../src/modules/races/services/raceResolutionInputFingerprint");

function fakeClient({ race = {}, inputs = [], effects = [], events = [] } = {}) {
  const results = [[{ race: { id: "r1", ...race }, participants: [] }], inputs, effects, events];
  let index = 0;
  return {
    async $queryRawUnsafe() { return results[index++]; },
  };
}

test("input fingerprint is stable for identical ordered scoring inputs", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const input = [{
    userId: "u1",
    generation: "4",
    hasSteps: true,
    hasSamples: true,
    nextSampleBoundary: new Date("2026-08-13T12:04:00.000Z"),
  }];
  const left = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 9,
    client: fakeClient({ inputs: input }),
  });
  const right = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 9,
    client: fakeClient({ inputs: input }),
  });
  assert.match(left.digest, /^[a-f0-9]{64}$/);
  assert.equal(left.digest, right.digest);
  assert.equal(left.nextSampleBoundary.toISOString(), "2026-08-13T12:04:00.000Z");
});

test("fingerprint changes for a monotonic source token, effect, event, or config version", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const base = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 1,
    client: fakeClient({ inputs: [{ userId: "u1", generation: "1" }] }),
  });
  for (const options of [
    { balanceConfigVersion: 2, inputs: [{ userId: "u1", generation: "1" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "2" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "1" }], effects: [{ id: "e1" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "1" }], events: [{ id: "g1" }] },
  ]) {
    const changed = await buildRaceResolutionInputFingerprint({
      raceId: "r1", now,
      client: fakeClient(options),
      ...options,
    });
    assert.notEqual(changed.digest, base.digest);
  }
});

test("missing source token with existing steps/samples fails closed", async () => {
  const value = await buildRaceResolutionInputFingerprint({
    raceId: "r1",
    now: new Date("2026-08-13T12:00:00.000Z"),
    balanceConfigVersion: 1,
    client: fakeClient({
      inputs: [{ userId: "u1", generation: null, hasSteps: true, hasSamples: false }],
    }),
  });
  assert.equal(value, null);
});
