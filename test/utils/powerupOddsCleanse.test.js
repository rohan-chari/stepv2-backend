const assert = require("node:assert/strict");
const test = require("node:test");

const { rollPowerup, RARITY_TIERS } = require("../../src/utils/powerupOdds");

// ---------------------------------------------------------------------------
// Generation-pool: CLEANSE is a self-only powerup in the RARE tier. It was
// introduced into the UNCOMMON tier in 1.1.7 and promoted to RARE on
// 2026-07-15. Written from the spec, not by mirroring implementation code.
// ---------------------------------------------------------------------------

test("CLEANSE is in the RARE generation tier", () => {
  assert.ok(
    RARITY_TIERS.RARE.includes("CLEANSE"),
    "RARITY_TIERS.RARE should include CLEANSE"
  );
});

test("CLEANSE is NOT in the COMMON or UNCOMMON tiers", () => {
  assert.ok(!RARITY_TIERS.COMMON.includes("CLEANSE"), "COMMON should not include CLEANSE");
  assert.ok(!RARITY_TIERS.UNCOMMON.includes("CLEANSE"), "UNCOMMON should not include CLEANSE");
});

test("rollPowerup can roll CLEANSE when the RARE tier is selected", () => {
  const rareTier = RARITY_TIERS.RARE;
  const cleanseIndex = rareTier.indexOf("CLEANSE");
  assert.ok(cleanseIndex >= 0, "CLEANSE must be in the RARE tier for this test");

  // Force RARE (rng above the COMMON+UNCOMMON bands — RARE is the last bucket,
  // so 0.99 lands there for any position) then land the type index on CLEANSE.
  const typeRng = (cleanseIndex + 0.5) / rareTier.length;
  const seq = [0.99, typeRng];
  let i = 0;
  const rng = () => seq[i++ % seq.length];

  const { type, rarity } = rollPowerup(2, 4, rng);
  assert.equal(rarity, "RARE");
  assert.equal(type, "CLEANSE");
});
