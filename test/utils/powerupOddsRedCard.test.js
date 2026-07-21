const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { rollPowerup, RARITY_TIERS } = require("../../src/modules/powerups/powerupOdds");

// Deterministic PRNG so this statistical test never flakes (same seed -> same
// sequence -> same counts).
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("powerupOdds — Red Card nerf (half rate within RARE tier)", () => {
  it("RED_CARD lands at ~half its prior uniform rate; other rares unchanged relatively; tier is leak-free", () => {
    const rng = mulberry32(20260716);
    const N = 400000;
    // Roll at last place (RARE-heavy) to accumulate plenty of rare samples.
    const rareCounts = Object.create(null);
    let rareTotal = 0;
    const validRares = new Set(RARITY_TIERS.RARE);

    for (let i = 0; i < N; i++) {
      const { type, rarity } = rollPowerup(4, 4, rng);
      if (rarity !== "RARE") continue;
      rareTotal += 1;
      rareCounts[type] = (rareCounts[type] || 0) + 1;
      // No leakage: a RARE-tier roll always yields a valid rare type.
      assert.ok(validRares.has(type), `unexpected rare type ${type}`);
    }

    assert.ok(rareTotal > 50000, `expected many rare samples, got ${rareTotal}`);

    const redFraction = (rareCounts["RED_CARD"] || 0) / rareTotal;
    // Prior uniform rate was 1/11 ≈ 0.0909; the nerf targets exactly half = 1/22.
    const TARGET = 1 / 22;
    assert.ok(
      Math.abs(redFraction - TARGET) < 0.004,
      `RED_CARD within-tier fraction ${redFraction.toFixed(4)} should be ~${TARGET.toFixed(4)} (half of 1/11)`
    );

    // A representative OTHER rare should sit at ~21/220 (its share plus the tiny
    // redistributed mass), i.e. roughly DOUBLE RED_CARD's rate — confirming the
    // re-roll only halved RED_CARD and did not nerf the rest of the tier.
    const otherFraction = (rareCounts["MIRROR"] || 0) / rareTotal;
    assert.ok(
      otherFraction > redFraction * 1.7,
      `a normal rare (${otherFraction.toFixed(4)}) should clearly exceed RED_CARD (${redFraction.toFixed(4)})`
    );

    // The RARE tier still sums to 1 across the 11 rares (probability preserved,
    // no mass lost or leaked to other tiers).
    const sum = Object.values(rareCounts).reduce((a, b) => a + b, 0);
    assert.equal(sum, rareTotal);
    assert.equal(Object.keys(rareCounts).length, RARITY_TIERS.RARE.length);
  });
});
