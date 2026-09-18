// §10.12 — structural guard on the Shell's blockable set.
//
// The Turtle's Shell blocks exactly the attack TYPES that an in-race mystery box
// can roll (`dropPool`). The complement — types you can only buy — must be
// declared in `storeOnlyTypes`. If a future attack type lands in NEITHER list,
// the Shell silently treats it as unblockable and nobody notices; if a type
// lands in BOTH, the two authorities contradict each other. This test pins both
// properties so the blockable set cannot drift as the economy is retuned.
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DEFAULT_CONFIG } = require("../../src/modules/economy/balanceConfig.defaults");
const { OFFENSE_TYPES } = require("../../src/modules/powerups/constants/powerupCategories");

function dropPoolTypes(config) {
  return new Set(
    ["COMMON", "UNCOMMON", "RARE"].flatMap((tier) => config.dropPool[tier] || [])
  );
}

// Known, deliberate exception: QUICKSAND is store-only in practice (it is gated
// by POWERUPS4_GATED_TYPES and absent from every drop tier) but was never added
// to `storeOnlyTypes`. Recorded here rather than silently tolerated — the guard
// still fails for any NEW unclassified attack type.
const UNCLASSIFIED_BY_DESIGN = new Set(["QUICKSAND"]);

describe("Shell blockable set (dropPool vs storeOnlyTypes)", () => {
  const drops = dropPoolTypes(DEFAULT_CONFIG);
  const storeOnly = new Set(DEFAULT_CONFIG.storeOnlyTypes);

  it("no type is in both dropPool and storeOnlyTypes", () => {
    const both = [...drops].filter((t) => storeOnly.has(t));
    assert.deepEqual(both, [], `types claimed by both authorities: ${both.join(", ")}`);
  });

  it("every attack type is classified by exactly one of the two lists", () => {
    const unclassified = [...OFFENSE_TYPES].filter(
      (t) => !drops.has(t) && !storeOnly.has(t) && !UNCLASSIFIED_BY_DESIGN.has(t)
    );
    assert.deepEqual(
      unclassified,
      [],
      `attack types in neither dropPool nor storeOnlyTypes (the Shell would silently ` +
        `never block them): ${unclassified.join(", ")}`
    );
  });

  it("the exception list stays out of the drop pool", () => {
    for (const type of UNCLASSIFIED_BY_DESIGN) {
      assert.equal(drops.has(type), false, `${type} entered the drop pool — reclassify it`);
    }
  });
});
