const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isStealablePowerup,
} = require("../../../src/modules/powerups/services/powerupStealability");

test("Pickpocket only treats eligible held powerups as stealable", () => {
  assert.equal(isStealablePowerup({ status: "HELD", type: "LEG_CRAMP" }), true);
  assert.equal(isStealablePowerup({ status: "USED", type: "LEG_CRAMP" }), false);
  assert.equal(isStealablePowerup({ status: "HELD", type: "SNEAKY_SWAP" }), false);
  assert.equal(isStealablePowerup({ status: "HELD", type: "MYSTERY_BOX" }), false);
  assert.equal(isStealablePowerup({ status: "HELD", type: "POWER_OUTAGE" }), false);
});
