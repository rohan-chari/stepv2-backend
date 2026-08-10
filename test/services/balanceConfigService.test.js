const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildBalanceConfig,
  validateConfig,
  checkSoftBounds,
  mergeOverDefaults,
} = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");
const {
  rarityOddsForPosition,
  typeOddsForPosition,
  RARITY_ORDER,
} = require("../../src/modules/powerups/powerupOdds");
const { luckyMinRarity } = require("../../src/modules/powerups/commands/usePowerup");

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Test #13 (cold start half) — a process that has NEVER read the config
// successfully must still answer, from code defaults, without throwing.
describe("balanceConfig — never throws on a DB failure (D4)", () => {
  it("serves code defaults with a null version when the table is unreadable", async () => {
    const service = buildBalanceConfig({
      prisma: {
        balanceConfig: {
          async findFirst() {
            throw new Error("relation balance_config does not exist");
          },
        },
      },
    });

    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.version, null);
    assert.deepEqual(snapshot.config, defaultConfig());

    // And the sync accessor used by the hot roll paths agrees.
    assert.deepEqual(service.getConfigSync(), defaultConfig());
  });

  it("keeps serving the last good snapshot when a later read fails", async () => {
    let shouldFail = false;
    const stored = defaultConfig();
    stored.dailyBox.streakCap = 14;
    const service = buildBalanceConfig({
      cacheTtlMs: 0,
      prisma: {
        balanceConfig: {
          async findFirst() {
            if (shouldFail) throw new Error("connection terminated");
            return { version: 4, config: stored, active: true };
          },
        },
      },
    });

    assert.equal((await service.getSnapshot()).version, 4);
    shouldFail = true;
    const after = await service.getSnapshot();
    // A brief blip must not swing every player's odds back to defaults and then
    // back again — the last known-good config keeps serving.
    assert.equal(after.version, 4);
    assert.equal(after.config.dailyBox.streakCap, 14);
  });
});

describe("balanceConfig — merge over defaults", () => {
  it("fills missing keys from code defaults so a partial stored config still resolves", () => {
    const merged = mergeOverDefaults({ dailyBox: { streakCap: 10 } });
    assert.equal(merged.dailyBox.streakCap, 10);
    // untouched nested keys survive
    assert.deepEqual(merged.dailyBox.coinRanges.COMMON, [10, 30]);
    assert.equal(merged.rarityByType.SHORTCUT, "RARE");
  });

  it("replaces arrays wholesale rather than unioning them", () => {
    const merged = mergeOverDefaults({ storeOnlyTypes: ["LEECH"] });
    assert.deepEqual(merged.storeOnlyTypes, ["LEECH"]);
  });
});

describe("validateConfig / checkSoftBounds", () => {
  it("accepts the shipped default config with no errors and no bound warnings", () => {
    assert.deepEqual(validateConfig(defaultConfig()), []);
    assert.deepEqual(checkSoftBounds(defaultConfig()), []);
  });

  it("flags a soft-bound violation without treating it as a hard error", () => {
    const config = defaultConfig();
    config.dailyBox.coinRanges.COMMON = [0, 0];
    assert.deepEqual(validateConfig(config), []);
    const warnings = checkSoftBounds(config);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].path.startsWith("dailyBox.coinRanges.COMMON"));
  });

  it("flags a RARE position-odds share above the sane ceiling", () => {
    const config = defaultConfig();
    config.positionOdds.last = [0.1, 0.2, 0.7];
    assert.deepEqual(validateConfig(config), []);
    const warnings = checkSoftBounds(config);
    assert.ok(
      warnings.some((w) => w.path === "positionOdds.last.RARE"),
      `expected a positionOdds.last.RARE warning, got ${JSON.stringify(warnings)}`
    );
  });
});

// Test #17
describe("odds interpolation across field sizes", () => {
  const config = defaultConfig();

  for (const n of [1, 2, 5, 20]) {
    it(`sums to 1.0 at every position for a field of ${n}`, () => {
      for (let position = 1; position <= n; position++) {
        const row = rarityOddsForPosition(position, n, config);
        const sum = row.reduce((a, b) => a + b, 0);
        assert.ok(
          Math.abs(sum - 1) < 1e-9,
          `position ${position}/${n} summed to ${sum}`
        );
        assert.ok(row.every((p) => p >= 0 && p <= 1));
      }
    });

    it(`is monotonic leader -> trailer for a field of ${n}`, () => {
      let previousRare = -Infinity;
      for (let position = 1; position <= n; position++) {
        const [, , rare] = rarityOddsForPosition(position, n, config);
        assert.ok(
          rare >= previousRare - 1e-12,
          `RARE odds must not fall as position worsens (pos ${position}/${n})`
        );
        previousRare = rare;
      }
    });
  }

  it("a solo racer sits at the midpoint of the curve", () => {
    const solo = rarityOddsForPosition(1, 1, config);
    const first = config.positionOdds.first;
    const last = config.positionOdds.last;
    solo.forEach((p, i) => {
      assert.ok(Math.abs(p - (first[i] + last[i]) / 2) < 1e-12);
    });
  });

  it("both team-race slots resolve and favour the trailing team", () => {
    const leading = rarityOddsForPosition(1, 2, config);
    const trailing = rarityOddsForPosition(2, 2, config);
    assert.ok(Math.abs(leading.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(Math.abs(trailing.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(trailing[2] > leading[2]);
  });

  it("per-type odds sum to 1.0 and never quote a store-only type", () => {
    for (const [position, total] of [
      [1, 1],
      [1, 8],
      [4, 8],
      [8, 8],
    ]) {
      const byType = typeOddsForPosition(position, total, config);
      const sum = Object.values(byType).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `byType summed to ${sum}`);
      for (const storeOnly of config.storeOnlyTypes) {
        assert.equal(byType[storeOnly], undefined);
      }
    }
  });

  it("a weighted type gets proportionally less of its tier", () => {
    const byType = typeOddsForPosition(8, 8, config);
    // RED_CARD is weighted 0.5, so it must sit at half of an unweighted rare.
    assert.ok(byType.RED_CARD < byType.MIRROR);
    assert.ok(Math.abs(byType.RED_CARD / byType.MIRROR - 0.5) < 1e-9);
  });
});

// Test #18 — the graduated ladder is RETIRED (batch 2026-08-09 item 8b, owner
// decision). `rareChanceByLevel` is [1,1,1,1]: the Lucky Horseshoe is now
// simply "your next box is rare", at every level, which is what players always
// assumed it did.
//
// These assertions previously pinned the 0 / 0.2 / 0.45 / 1.0 ramp. That ramp
// existed to stop levels 1 and 2 being no-ops under an even older binary cliff;
// it is superseded rather than weakened — the ladder is gone, so the levels are
// deliberately no-ops again and the cost ladder is zeroed to match
// (upgradeCosts.byType.LUCKY_HORSESHOE = [0,0,0,0]). The guarantee itself is
// pinned harder than before: it must hold at EVERY level, not just level 3.
describe("Lucky Horseshoe flat guarantee (batch 2026-08-09 item 8b)", () => {
  const config = defaultConfig();

  it("EVERY level forces RARE, including an unupgraded horseshoe", () => {
    const rng = mulberry32(1);
    for (let level = 0; level <= 3; level++) {
      for (let i = 0; i < 2000; i++) {
        assert.equal(
          luckyMinRarity(level, rng, config),
          "RARE",
          `level ${level} must guarantee RARE`
        );
      }
    }
  });

  it("the configured ladder is flat 100% at all four levels", () => {
    assert.deepEqual(config.luckyHorseshoe.rareChanceByLevel, [1, 1, 1, 1]);
  });

  it("the guarantee is independent of the rng — no draw can miss it", () => {
    for (const value of [0, 0.0001, 0.5, 0.9999]) {
      assert.equal(luckyMinRarity(0, () => value, config), "RARE");
      assert.equal(luckyMinRarity(3, () => value, config), "RARE");
    }
  });

  it("the floor is always UNCOMMON or better, never COMMON", () => {
    const rng = mulberry32(7);
    for (let level = 0; level <= 3; level++) {
      for (let i = 0; i < 500; i++) {
        assert.ok(["UNCOMMON", "RARE"].includes(luckyMinRarity(level, rng, config)));
      }
    }
  });

  it("an out-of-range level is clamped rather than throwing", () => {
    assert.equal(luckyMinRarity(99, () => 0.99, config), "RARE");
    assert.equal(luckyMinRarity(-5, () => 0.0, config), "RARE");
    assert.ok(["UNCOMMON", "RARE"].includes(luckyMinRarity(undefined, () => 0.5, config)));
  });

});

// Test #19
describe("seeded Monte Carlo — no store-only or retired type ever drops", () => {
  it("300k rolls across the whole position range only ever yield drop-pool types", () => {
    const { rollPowerup } = require("../../src/modules/powerups/powerupOdds");
    const config = defaultConfig();
    const droppable = new Set([
      ...config.dropPool.COMMON,
      ...config.dropPool.UNCOMMON,
      ...config.dropPool.RARE,
    ]);
    const rng = mulberry32(20260720);
    const seen = new Set();

    for (let i = 0; i < 300000; i++) {
      const total = 1 + (i % 12);
      const position = 1 + (i % total);
      const { type, rarity } = rollPowerup(position, total, rng, { config });
      assert.ok(RARITY_ORDER.includes(rarity));
      assert.ok(droppable.has(type), `${type} must never drop`);
      seen.add(type);
    }

    // Every store-only type stayed out...
    for (const storeOnly of config.storeOnlyTypes) {
      assert.ok(!seen.has(storeOnly), `${storeOnly} is store-only and must never drop`);
    }
    // ...as did the retired-but-still-rarity-carrying types.
    assert.ok(!seen.has("CAMPFIRE_REST"));
    assert.ok(!seen.has("TRAIL_MAGNET"));
    // ...and everything that IS droppable actually showed up.
    assert.equal(seen.size, droppable.size);
  });
});
