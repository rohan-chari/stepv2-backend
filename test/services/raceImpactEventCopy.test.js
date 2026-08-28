const assert = require("node:assert/strict");
const test = require("node:test");

const {
  naturalExpiryImpactDescription,
} = require("../../src/modules/races/models/raceImpactEvent");

test("natural expiry copy uses canonical names, commas, and signed outcome wording", () => {
  assert.equal(
    naturalExpiryImpactDescription("RUNNERS_HIGH", -1234),
    "Runner's High wore off. You lost 1,234 steps.",
  );
  assert.equal(
    naturalExpiryImpactDescription("LEG_CRAMP", 2500),
    "Leg Cramp wore off. You gained 2,500 steps.",
  );
});
