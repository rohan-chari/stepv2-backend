const assert = require("node:assert/strict");
const test = require("node:test");

const { rollRarePrizeKind } = require("../../src/modules/economy/dailyBoxOdds");

// Item 10: a tunable coins slice in the RARE roll (DAILY_SPIN_RARE_COINS_SHARE)
// revives coin flow for high-streak / all-accessory users. The slice DISPLACES
// only the powerup portion — accessory rewards are never capped away. Default 0
// preserves the exact legacy accessory/powerup 50-50 roll (asserted by the
// existing dailyBoxOdds tests). Here we drive the share explicitly.

test("with coinsShare, a RARE with only a powerup pool pays COINS at the share rate", async () => {
  // roll below the share -> COINS; at/above -> POWERUP.
  assert.equal(rollRarePrizeKind(0, 5, () => 0.2, { coinsShare: 0.4 }), "COINS");
  assert.equal(rollRarePrizeKind(0, 5, () => 0.6, { coinsShare: 0.4 }), "POWERUP");
});

test("coins slice only displaces the powerup half — the accessory half is untouched", async () => {
  const seq = [0.9, 0.1]; // first roll -> not accessory (>=0.5), second -> COINS (<share)
  let i = 0;
  const rng = () => seq[i++];
  assert.equal(rollRarePrizeKind(3, 3, rng, { coinsShare: 0.5 }), "COINS");

  // Accessory half is reached whenever the FIRST roll < 0.5 — never coins.
  assert.equal(rollRarePrizeKind(3, 3, () => 0.1, { coinsShare: 0.9 }), "ACCESSORY");
});

test("coinsShare 0 reproduces the legacy behavior (never COINS)", async () => {
  assert.equal(rollRarePrizeKind(0, 5, () => 0.0, { coinsShare: 0 }), "POWERUP");
  assert.equal(rollRarePrizeKind(3, 3, () => 0.9, { coinsShare: 0 }), "POWERUP");
});

test("accessory-only pool always pays an accessory regardless of share", async () => {
  assert.equal(rollRarePrizeKind(5, 0, () => 0.1, { coinsShare: 0.9 }), "ACCESSORY");
});

test("both pools empty is still null", async () => {
  assert.equal(rollRarePrizeKind(0, 0, () => 0.5, { coinsShare: 0.5 }), null);
});
