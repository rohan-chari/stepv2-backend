const assert = require("node:assert/strict");
const test = require("node:test");

const { rollPowerup, RARITY_TIERS } = require("../../src/modules/powerups/powerupOdds");

// ---------------------------------------------------------------------------
// Generation-pool changes for 1.1.7:
//   - MIRROR is added to the RARE tier (new powerup).
//   - CAMPFIRE_REST is removed from ALL tiers (stop generating it; the enum
//     value and effect resolution are kept elsewhere for in-flight effects).
// Written from the spec, not by mirroring implementation.
// ---------------------------------------------------------------------------

const ALL_TIERS = ["COMMON", "UNCOMMON", "RARE"];

function allGeneratableTypes() {
  return ALL_TIERS.flatMap((tier) => RARITY_TIERS[tier]);
}

test("MIRROR is in the RARE generation tier", () => {
  assert.ok(
    RARITY_TIERS.RARE.includes("MIRROR"),
    "RARITY_TIERS.RARE should include MIRROR"
  );
});

test("CAMPFIRE_REST is NOT in any RARITY_TIERS array", () => {
  for (const tier of ALL_TIERS) {
    assert.ok(
      !RARITY_TIERS[tier].includes("CAMPFIRE_REST"),
      `RARITY_TIERS.${tier} should not include CAMPFIRE_REST`
    );
  }
});

test("the overall generation pool excludes CAMPFIRE_REST and includes MIRROR", () => {
  const pool = allGeneratableTypes();
  assert.ok(!pool.includes("CAMPFIRE_REST"), "pool must not contain CAMPFIRE_REST");
  assert.ok(pool.includes("MIRROR"), "pool must contain MIRROR");
});

test("rollPowerup never rolls CAMPFIRE_REST over many deterministic rolls", () => {
  // Sweep rng across the full [0,1) range for both rarity and type selection.
  for (let r = 0; r < 1; r += 0.01) {
    for (let t = 0; t < 1; t += 0.01) {
      const seq = [r, t];
      let i = 0;
      const rng = () => seq[i++ % seq.length];
      const { type } = rollPowerup(2, 4, rng);
      assert.notEqual(type, "CAMPFIRE_REST", `rolled CAMPFIRE_REST at r=${r}, t=${t}`);
    }
  }
});

test("rollPowerup can roll MIRROR when the RARE tier is selected", () => {
  // Force RARE (rng high), then sweep the type index to land on MIRROR.
  const rareTier = RARITY_TIERS.RARE;
  const mirrorIndex = rareTier.indexOf("MIRROR");
  assert.ok(mirrorIndex >= 0, "MIRROR must be in the RARE tier for this test");

  // type index = floor(rng() * tier.length) === mirrorIndex
  const typeRng = (mirrorIndex + 0.5) / rareTier.length;
  const seq = [0.999, typeRng];
  let i = 0;
  const rng = () => seq[i++ % seq.length];

  const { type, rarity } = rollPowerup(4, 4, rng);
  assert.equal(rarity, "RARE");
  assert.equal(type, "MIRROR");
});
