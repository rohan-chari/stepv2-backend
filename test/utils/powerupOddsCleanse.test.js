const assert = require("node:assert/strict");
const test = require("node:test");

const { rollPowerup, RARITY_TIERS } = require("../../src/utils/powerupOdds");

// ---------------------------------------------------------------------------
// Generation-pool change for 1.1.7: CLEANSE is added to the UNCOMMON tier.
// CLEANSE is a new UNCOMMON, self-only powerup. Written from the spec, not by
// mirroring implementation code.
// ---------------------------------------------------------------------------

test("CLEANSE is in the UNCOMMON generation tier", () => {
  assert.ok(
    RARITY_TIERS.UNCOMMON.includes("CLEANSE"),
    "RARITY_TIERS.UNCOMMON should include CLEANSE"
  );
});

test("CLEANSE is NOT in the COMMON or RARE tiers", () => {
  assert.ok(!RARITY_TIERS.COMMON.includes("CLEANSE"), "COMMON should not include CLEANSE");
  assert.ok(!RARITY_TIERS.RARE.includes("CLEANSE"), "RARE should not include CLEANSE");
});

test("rollPowerup can roll CLEANSE when the UNCOMMON tier is selected", () => {
  const uncommonTier = RARITY_TIERS.UNCOMMON;
  const cleanseIndex = uncommonTier.indexOf("CLEANSE");
  assert.ok(cleanseIndex >= 0, "CLEANSE must be in the UNCOMMON tier for this test");

  // Force UNCOMMON (rng in the uncommon band) then land the type index on
  // CLEANSE. For a mid-pack runner (position 2 of 4) the COMMON band ends
  // around 0.39 and the UNCOMMON band runs to ~0.67, so rng 0.5 lands UNCOMMON.
  const typeRng = (cleanseIndex + 0.5) / uncommonTier.length;
  const seq = [0.5, typeRng];
  let i = 0;
  const rng = () => seq[i++ % seq.length];

  const { type, rarity } = rollPowerup(2, 4, rng);
  assert.equal(rarity, "UNCOMMON");
  assert.equal(type, "CLEANSE");
});
