const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeSettlementAttributionVector,
} = require("../../src/modules/races/services/raceSettlementAttribution");

test("canonical attribution uses ordered marginals through stacked effects, a floor, and a global event", async () => {
  const effects = [
    { id: "effect-buff", type: "RUNNERS_HIGH", startsAt: new Date("2026-08-17T10:00:00Z") },
    { id: "effect-floor", type: "WRONG_TURN", startsAt: new Date("2026-08-17T10:01:00Z") },
  ];
  const events = [{ id: "event-2x", startsAt: new Date("2026-08-17T10:02:00Z") }];
  const score = async ({ effectIds, globalEvents }) => {
    const hasBuff = effectIds.has("effect-buff");
    const hasFloor = effectIds.has("effect-floor");
    const withoutGlobal = hasFloor ? 0 : (hasBuff ? 150 : 100);
    return new Map([["participant", globalEvents.length ? withoutGlobal + 25 : withoutGlobal]]);
  };

  const vector = await computeSettlementAttributionVector({
    participants: [{ id: "participant", userId: "user" }], effects, globalEvents: events, score,
  });

  assert.deepEqual(vector.effectImpacts.map((row) => ({ effectId: row.effectId, deltaSteps: row.deltaSteps })), [
    { effectId: "effect-buff", deltaSteps: 50 },
    { effectId: "effect-floor", deltaSteps: -150 },
  ]);
  assert.deepEqual(vector.globalImpacts.map((row) => ({ eventId: row.eventId, deltaSteps: row.deltaSteps })), [
    { eventId: "event-2x", deltaSteps: 25 },
  ]);
  assert.equal(vector.finalTotals.get("participant"), 25);
  assert.equal(vector.baselineTotals.get("participant"), 100);
  assert.equal(vector.effectImpacts.reduce((sum, row) => sum + row.deltaSteps, 0) +
    vector.globalImpacts.reduce((sum, row) => sum + row.deltaSteps, 0), -75);
});

test("deterministic remainder allocation keeps integer settled vectors exact", async () => {
  const vector = await computeSettlementAttributionVector({
    participants: [{ id: "participant", userId: "user" }],
    effects: [
      { id: "a", type: "RUNNERS_HIGH", startsAt: new Date("2026-08-17T10:00:00Z") },
      { id: "b", type: "RALLY_FLAG", startsAt: new Date("2026-08-17T10:01:00Z") },
    ],
    globalEvents: [],
    score: async ({ effectIds }) => new Map([["participant",
      effectIds.has("b") ? 101 : effectIds.has("a") ? 100.4 : 100,
    ]]),
  });
  assert.deepEqual(vector.effectImpacts.map((row) => [row.effectId, row.deltaSteps]), [["b", 1]]);
});

test("local attribution emits an impact only for participants eligible for that event", async () => {
  const event = {
    id: "local-event", scheduleMode: "LOCAL_ENTITLEMENTS",
    startsAt: new Date("2026-08-20T12:00:00Z"),
  };
  const participants = [
    { id: "eligible-participant", userId: "eligible-user" },
    { id: "ineligible-participant", userId: "ineligible-user" },
  ];
  const eventsByUserId = new Map([
    ["eligible-user", [event]],
    ["ineligible-user", []],
  ]);
  const vector = await computeSettlementAttributionVector({
    participants,
    effects: [],
    globalEvents: [event],
    eventsByUserId,
    score: async ({ eventsByUserId: selected }) => new Map([
      ["eligible-participant", selected?.get("eligible-user")?.length ? 200 : 100],
      ["ineligible-participant", 100],
    ]),
  });

  assert.deepEqual(vector.globalImpacts, [{
    participantId: "eligible-participant",
    userId: "eligible-user",
    eventId: "local-event",
    deltaSteps: 100,
  }]);
});
