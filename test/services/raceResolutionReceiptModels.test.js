const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionPostTaskReceiptModel,
} = require("../../src/modules/races/models/raceResolutionPostTaskReceipt");
const {
  buildRaceResolutionDeliveryIntentReceiptModel,
} = require("../../src/modules/races/models/raceResolutionDeliveryIntentReceipt");

test("task receipt replay is keyed by race and source generation", async () => {
  const calls = [];
  const model = buildRaceResolutionPostTaskReceiptModel({
    raceResolutionPostTaskReceipt: {
      findUnique: async (input) => { calls.push(input); return { dedupeKey: "d" }; },
    },
  });
  assert.deepEqual(await model.findByGeneration({ raceId: "r", sourceGeneration: 7 }), {
    dedupeKey: "d",
  });
  assert.deepEqual(calls[0].where, {
    raceId_sourceGeneration: { raceId: "r", sourceGeneration: 7 },
  });
});

test("intent receipt rejects an immutable delivery-key collision", async () => {
  const model = buildRaceResolutionDeliveryIntentReceiptModel({
    raceResolutionDeliveryIntentReceipt: {
      findUnique: async () => ({
        deliveryKeyHash: "a".repeat(64), raceId: "r", sourceGeneration: 1,
        taskDedupeKey: "task", intentKind: "NUDGE",
        terminalDisposition: "accepted",
      }),
    },
  });
  assert.throws(
    () => model.assertReplayIdentity({
      receipt: {
        deliveryKeyHash: "a".repeat(64), raceId: "r", sourceGeneration: 1,
        taskDedupeKey: "task", intentKind: "NUDGE",
        terminalDisposition: "accepted",
      },
      raceId: "r", sourceGeneration: 2, taskDedupeKey: "task", intentKind: "NUDGE",
    }),
    /immutable identity/,
  );
});
