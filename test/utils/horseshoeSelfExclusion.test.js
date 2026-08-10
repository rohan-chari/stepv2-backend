const assert = require("node:assert/strict");
const test = require("node:test");

const {
  rollPowerup,
  eligiblePoolFor,
  typeOddsForPosition,
} = require("../../src/modules/powerups/powerupOdds");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");

// Batch 2026-08-09 item 8b — the Lucky Horseshoe cannot roll itself.
//
// Mechanism note (architect correction, and the reason this file exists at the
// ODDS layer rather than in openMysteryBox): with rareChanceByLevel = [1,1,1,1]
// the tier is coerced to RARE BEFORE the type is picked, so the old post-pick
// backstop inside openMysteryBox never runs. The exclusion therefore lives at
// the rollPowerup -> eligiblePoolFor seam, and it is gated on `minRarity` so it
// applies to FORCED boxes only.

const CFG = defaultConfig();
const ONLY = ["LUCKY_HORSESHOE"];

// A deterministic rng that cycles through fixed values, so a "never" assertion
// is a real sweep of the draw space rather than a lucky sample.
function cyclingRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const SWEEP = Array.from({ length: 200 }, (_, i) => i / 200);

test("a FORCED box never returns a Lucky Horseshoe", () => {
  for (let i = 0; i < 500; i++) {
    const { type, rarity } = rollPowerup(1, 4, cyclingRng(SWEEP.slice(i % 50)), {
      config: CFG,
      minRarity: "RARE",
      excludeTypes: ONLY,
    });
    assert.equal(rarity, "RARE", "a forced box is always at least RARE");
    assert.notEqual(type, "LUCKY_HORSESHOE");
  }
});

test("a NATURAL roll is unaffected — a horseshoe is still reachable", () => {
  // No minRarity => the exclusion must not be applied even if the caller
  // passes one. This is the property that keeps an ordinary rare drop normal.
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const { type } = rollPowerup(4, 4, Math.random, {
      config: CFG,
      excludeTypes: ONLY,
    });
    seen.add(type);
  }
  assert.ok(
    seen.has("LUCKY_HORSESHOE"),
    `a natural roll must still be able to yield a horseshoe, saw ${[...seen].join(",")}`
  );
});

test("the exclusion is scoped to minRarity, not to the option being present", () => {
  const forced = eligiblePoolFor("RARE", undefined, CFG, ONLY);
  assert.ok(!forced.pool.includes("LUCKY_HORSESHOE"));

  const natural = eligiblePoolFor("RARE", undefined, CFG, undefined);
  assert.ok(natural.pool.includes("LUCKY_HORSESHOE"));
});

test("empty-pool fallback: excluding the whole tier yields the type, never null", () => {
  const oneTypeConfig = {
    ...CFG,
    dropPool: { ...CFG.dropPool, RARE: ["LUCKY_HORSESHOE"] },
  };
  const { pool } = eligiblePoolFor("RARE", undefined, oneTypeConfig, ONLY);
  assert.deepEqual(
    pool,
    ["LUCKY_HORSESHOE"],
    "excluding the only survivor must fall back, not empty the tier"
  );

  const { type, rarity } = rollPowerup(1, 4, Math.random, {
    config: oneTypeConfig,
    minRarity: "RARE",
    excludeTypes: ONLY,
  });
  assert.equal(rarity, "RARE");
  assert.equal(type, "LUCKY_HORSESHOE", "a duplicate beats a null roll");
});

test("the odds DISCLOSURE deliberately does not mirror the exclusion", () => {
  // The sheet quotes steady-state box odds; the forced box is a special case it
  // does not model (it also does not model the guaranteed-RARE coercion).
  // Pinned so nobody "fixes" half of it.
  const odds = typeOddsForPosition(2, 4, CFG, undefined);
  assert.ok(
    odds.LUCKY_HORSESHOE > 0,
    "horseshoe must still be disclosed with non-zero odds"
  );
});

test("the guarantee still holds at every upgrade level (all levels are 100%)", () => {
  assert.deepEqual(CFG.luckyHorseshoe.rareChanceByLevel, [1, 1, 1, 1]);
});

// Item 8a — Fanny Pack is out of generation entirely.
test("FANNY_PACK is in no drop pool but keeps its canonical rarity", () => {
  for (const tier of ["COMMON", "UNCOMMON", "RARE"]) {
    assert.ok(
      !CFG.dropPool[tier].includes("FANNY_PACK"),
      `FANNY_PACK must not be droppable in ${tier}`
    );
  }
  // validateConfig requires rarity coverage for every balance type, and
  // rarity-without-a-drop-slot is the established retirement pattern.
  assert.equal(CFG.rarityByType.FANNY_PACK, "RARE");
});

test("a box roll can never produce a FANNY_PACK", () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    seen.add(rollPowerup(2, 4, Math.random, { config: CFG }).type);
  }
  assert.ok(!seen.has("FANNY_PACK"), "Fanny Pack must be undropable");
});

// Item 6 — Power Outage swaps into the RARE tier.
test("POWER_OUTAGE is RARE, droppable, and no longer store-only", () => {
  assert.equal(CFG.rarityByType.POWER_OUTAGE, "RARE");
  assert.ok(CFG.dropPool.RARE.includes("POWER_OUTAGE"));
  assert.ok(
    !CFG.storeOnlyTypes.includes("POWER_OUTAGE"),
    "storeOnlyTypes is UNIONED with the stored list on every load — leaving it " +
      "here would silently re-strip the drop after any deploy"
  );
});

test("POWER_OUTAGE carries the leading down-weight that keeps it off the leader", () => {
  assert.equal(CFG.positionRules.leadingDownweight.POWER_OUTAGE, 0.3);
  // It must appear in exactly ONE positionRules list, or validateConfig
  // complains and the intent gets muddled.
  assert.ok(!CFG.positionRules.leaderExcluded.includes("POWER_OUTAGE"));
  assert.ok(!CFG.positionRules.lastPlaceExcluded.includes("POWER_OUTAGE"));
  assert.ok(!CFG.positionRules.trailingDownweight.POWER_OUTAGE);
});

test("the down-weight makes a leader strictly less likely to draw POWER_OUTAGE than last place", () => {
  const leaderCtx = {
    normalizedPosition: 0,
    isStepLeader: true,
    isStepLast: false,
    isTeamRace: false,
    supportsPowerups5: true,
  };
  const lastCtx = {
    normalizedPosition: 1,
    isStepLeader: false,
    isStepLast: true,
    isTeamRace: false,
    supportsPowerups5: true,
  };
  const leaderOdds = typeOddsForPosition(1, 4, CFG, leaderCtx);
  const lastOdds = typeOddsForPosition(4, 4, CFG, lastCtx);
  assert.ok(
    lastOdds.POWER_OUTAGE > leaderOdds.POWER_OUTAGE,
    `expected trailing bias, got leader=${leaderOdds.POWER_OUTAGE} last=${lastOdds.POWER_OUTAGE}`
  );
});

// The swap must be odds-neutral for everyone else: Fanny Pack out, Power Outage
// in, same RARE tier size, so no other type's share moved.
test("the FANNY_PACK -> POWER_OUTAGE swap leaves the RARE tier size unchanged", () => {
  assert.equal(CFG.dropPool.RARE.length, 10);
});

// ---------------------------------------------------------------------------
// Reroll path — UNCHANGED, pinned rather than edited (architect correction).
// ---------------------------------------------------------------------------
//
// rerollMysteryBox deliberately applies NO Horseshoe minimum: the paid buff is
// consumed by the open it was active for. There is no duplicated floor block to
// edit there, and adding one would silently hand out a second guarantee. This
// asserts the absence structurally, over the real source, because "we did not
// add a thing" has no runtime signature to test.
test("rerollMysteryBox applies no rarity floor and no exclusion", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(
      __dirname,
      "../../src/modules/powerups/commands/rerollMysteryBox.js"
    ),
    "utf8"
  );
  // The two rollFn call sites must pass neither minRarity nor excludeTypes.
  const callSites = src.match(/rollFn\([^)]*\{[^}]*\}\)/g) || [];
  assert.ok(callSites.length >= 1, "expected at least one rollFn call site");
  for (const call of callSites) {
    assert.ok(
      !call.includes("minRarity"),
      `a reroll must never apply a rarity floor: ${call}`
    );
    assert.ok(
      !call.includes("excludeTypes"),
      `a reroll must not carry the forced-box exclusion: ${call}`
    );
  }
});

// A reroll must therefore still be able to land on a Lucky Horseshoe, exactly
// as it could before this batch.
test("a reroll-shaped roll (no minRarity) can still yield a horseshoe", () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    seen.add(rollPowerup(3, 4, Math.random, { config: CFG }).type);
  }
  assert.ok(seen.has("LUCKY_HORSESHOE"));
});

// ---------------------------------------------------------------------------
// Item 6 — the powerups5 HARD GATE still protects frozen clients.
// ---------------------------------------------------------------------------
//
// POWER_OUTAGE is droppable now, but it is also in POWERUPS5_GATED_TYPES, and
// that list is deliberately NOT touched by this batch. A pre-wave-5 binary
// cannot render or use the type — usePowerup rejects it with UPDATE_REQUIRED —
// so rolling one would burn a slot in a live race. Unlike the balance filters,
// this gate has NO empty-pool fallback, by design.
test("a non-powerups5 client can never roll POWER_OUTAGE", () => {
  const oldCtx = {
    normalizedPosition: 1,
    isStepLeader: false,
    isStepLast: true,
    isTeamRace: false,
    supportsPowerups5: false,
  };
  const { pool } = eligiblePoolFor("RARE", oldCtx, CFG);
  assert.ok(
    !pool.includes("POWER_OUTAGE"),
    "a frozen binary must never be handed a wave-5 type"
  );

  for (let i = 0; i < 2000; i++) {
    const { type } = rollPowerup(4, 4, Math.random, { config: CFG, ctx: oldCtx });
    assert.notEqual(type, "POWER_OUTAGE");
  }
});

test("a powerups5 client CAN roll POWER_OUTAGE at RARE", () => {
  const newCtx = {
    normalizedPosition: 1,
    isStepLeader: false,
    isStepLast: true,
    isTeamRace: false,
    supportsPowerups5: true,
  };
  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    seen.add(rollPowerup(4, 4, Math.random, { config: CFG, ctx: newCtx }).type);
  }
  assert.ok(
    seen.has("POWER_OUTAGE"),
    `a modern client must be able to roll it, saw ${[...seen].join(",")}`
  );
});
