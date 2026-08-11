const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// RAINSTORM scoring math.
//
// A RAINSTORM effect is an ADDITIVE -0.5x on step accrual during its window
// (folded into frozenSteps by computeEffectModifiers):
//   * rain only:               1x - 0.5x = 0.5x
//   * rain + Runner's High:    1x + 1x - 0.5x = 1.5x  (stays additive)
//   * rain + Leg Cramp:        0x (freeze dominates; rain penalty SUSPENDED so
//                              frozen steps can never go negative)
//   * rain + Wrong Turn:       -1x (reversal dominates; rain suspended)
// multiplierForTime (finish-time interpolation) must agree with these exact
// values so live totals and finish snapshots never diverge.
//
// NOTE (batch 2026-08-10b item 6): the "rain + Runner's High = 1.5x" case below
// describes the behaviour with RAINSTORM_MULTIPLICATIVE_ENABLED unset/"false",
// which is the shipped default. That flag makes rain MULTIPLICATIVE, and this
// is the one existing expected value the fix legitimately changes (1.5x -> 1x).
// The assertion is left exactly as-is because it pins the flag-OFF path, which
// is production at deploy time; the flag-ON value is asserted in the item 6
// section at the bottom of this file. See the batch spec, §Item 6.
// ---------------------------------------------------------------------------

const { computeEffectModifiers } = require("../../src/modules/races/queries/getRaceProgress");
const { calculateCurrentTotal } = require("../../src/modules/races/services/raceStateResolution");

const T0 = new Date("2026-07-04T12:00:00Z");
const T1 = new Date("2026-07-04T13:00:00Z");

// Uniform-rate step model: `steps` spread evenly over [T0, T1].
function makeStepModel(steps) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const ss = T0.getTime();
      const se = T1.getTime();
      const os = Math.max(ss, new Date(start).getTime());
      const oe = Math.min(se, new Date(end).getTime());
      if (oe <= os) return 0;
      return Math.round(steps * ((oe - os) / (se - ss)));
    },
    async findByUserIdAndTimeRange() { return []; },
  };
}

function effect(type, overrides = {}) {
  return {
    type,
    startsAt: T0,
    expiresAt: T1,
    status: "ACTIVE",
    metadata: { multiplier: type === "RAINSTORM" ? 0.5 : undefined },
    ...overrides,
  };
}

async function totalFor(effects, steps) {
  const { frozenSteps, buffedSteps, reversedSteps } = await computeEffectModifiers(
    effects,
    steps,
    "user-1",
    makeStepModel(steps),
    true
  );
  return Math.max(0, steps - frozenSteps + buffedSteps - 2 * reversedSteps);
}

test("rain alone halves steps in the window", async () => {
  assert.equal(await totalFor([effect("RAINSTORM")], 6000), 3000);
});

test("rain multiplier defaults to 0.5 when metadata is missing/malformed", async () => {
  assert.equal(
    await totalFor([effect("RAINSTORM", { metadata: {} })], 6000),
    3000
  );
  assert.equal(
    await totalFor([effect("RAINSTORM", { metadata: { multiplier: "wat" } })], 6000),
    3000
  );
});

test("rain + Runner's High stays additive: 1.5x", async () => {
  const effects = [effect("RAINSTORM"), effect("RUNNERS_HIGH")];
  assert.equal(await totalFor(effects, 6000), 9000);
});

test("rain is suspended during a Leg Cramp: frozen steps stay 0, never negative", async () => {
  const effects = [effect("RAINSTORM"), effect("LEG_CRAMP")];
  assert.equal(await totalFor(effects, 6000), 0);
});

test("rain is suspended during a Wrong Turn: reversal stays exactly -1x", async () => {
  const effects = [effect("RAINSTORM"), effect("WRONG_TURN")];
  // base 6000 - reversed(2*6000) = -6000 → clamped to 0
  assert.equal(await totalFor(effects, 6000), 0);
});

test("partial-window rain only penalizes the rained half", async () => {
  const halfway = new Date("2026-07-04T12:30:00Z");
  const rain = effect("RAINSTORM", { expiresAt: halfway });
  // 3000 steps fall in the rain window → lose 1500; other 3000 untouched.
  assert.equal(await totalFor([rain], 6000), 4500);
});

test("settlement path (calculateCurrentTotal) matches the display math for rain", async () => {
  const steps = 6000;
  const rain = effect("RAINSTORM");
  const effectModel = {
    async findEffectsForRaceByType(raceId, participantId, type) {
      return type === "RAINSTORM" ? [rain] : [];
    },
  };
  const { total } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    baseAdjusted: steps,
    hasSampleData: true,
    raceActiveEffectModel: effectModel,
    stepSampleModel: makeStepModel(steps),
  });
  assert.equal(total, await totalFor([rain], steps));
  assert.equal(total, 3000);
});

// ---------------------------------------------------------------------------
// Batch 2026-08-10 (part 2) — Item 6: RAINSTORM is MULTIPLICATIVE.
//
// "Steps halved by rain" only equalled `M − 0.5` when the victim was unbuffed.
// Step 3 of signedMultiplierAt now computes the resulting M for EVERY active
// reduction independently and keeps the LOWEST:
//   * a `rainstorms` candidate yields M * retained  (a true halving)
//   * a `coinFlipLoses` candidate yields max(0, M − lost)  (unchanged)
//
// Behind `RAINSTORM_MULTIPLICATIVE_ENABLED` (default "false"), read at CALL
// time. Every case below is asserted in BOTH flag states.
// ---------------------------------------------------------------------------

const {
  signedMultiplierForEffects,
} = require("../../src/modules/races/services/effectiveStepScoring");
const {
  signedMultiplierAt,
} = require("../../src/modules/races/services/effectMultiplier");
const {
  determineFinishSnapshot,
} = require("../../src/modules/races/services/raceStateResolution");

const MID = new Date("2026-07-04T12:30:00Z");
const FLAG = "RAINSTORM_MULTIPLICATIVE_ENABLED";

function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prev;
    }
  })();
}

// Full effect rows (with a `type`) as the live paths build them.
const RAIN = () => effect("RAINSTORM");
const RALLY = () => effect("RALLY_FLAG", { metadata: { multiplier: 1.25 } });
const PEPPER = () =>
  effect("GHOST_PEPPER", { metadata: { multiplier: 3, boostMs: 60 * 60 * 1000 } });
const RH = () => effect("RUNNERS_HIGH", { metadata: {} });

function mAt(effects, at = MID) {
  return signedMultiplierForEffects(effects, at.getTime());
}

// ── 1. The prod repro ("runners hi", DrAmogh, 2026-08-10) ──────────────────
test("ON: Rally Flag (1.25) + Ghost Pepper (3) + rainstorm = 2.125x, not 3.75x", async () => {
  await withFlag("true", async () => {
    const effects = [RALLY(), PEPPER(), RAIN()];
    assert.equal(mAt(effects), 2.125, "4.25 halved, not 4.25 − 0.5");
    // A 2x global step event multiplies on top: 2.125 × 2 = 4.25 displayed,
    // which is the ~4x the user expected instead of the 7x they saw.
    assert.equal(await totalFor(effects, 6000), 12750, "6000 × 2.125");
  });
});

test("OFF (the deploy default): the same case stays subtractive at 3.75x", async () => {
  await withFlag(undefined, async () => {
    const effects = [RALLY(), PEPPER(), RAIN()];
    assert.equal(mAt(effects), 3.75, "4.25 − 0.5");
    assert.equal(await totalFor(effects, 6000), 22500);
  });
  await withFlag("false", async () => {
    assert.equal(mAt([RALLY(), PEPPER(), RAIN()]), 3.75);
  });
});

// ── 2. The unbuffed victim is BIT-IDENTICAL in both states ─────────────────
test("unbuffed + rainstorm = 0.5 under either flag state", async () => {
  for (const flag of [undefined, "false", "true"]) {
    await withFlag(flag, async () => {
      assert.equal(mAt([RAIN()]), 0.5, `flag=${flag}`);
      assert.equal(await totalFor([RAIN()], 6000), 3000, `flag=${flag}`);
    });
  }
});

// ── 3. Two storms still clamp to a SINGLE reduction ────────────────────────
test("ON: two simultaneous rainstorms = one 0.5 factor, never 0.25", async () => {
  await withFlag("true", async () => {
    assert.equal(mAt([RAIN(), RAIN()]), 0.5);
    assert.equal(await totalFor([RAIN(), RAIN()], 6000), 3000);
    // …and on a buffed victim: 4.25 × 0.5 once, not twice.
    assert.equal(mAt([RALLY(), PEPPER(), RAIN(), RAIN()]), 2.125);
  });
});

// ── 4 / 4a. The minimum rule, and the inversion it fixes ───────────────────
test("ON: rainstorm + coin-flip loss on a buffed victim -> the storm's result wins", async () => {
  await withFlag("true", async () => {
    const loss = effect("COIN_FLIP", { metadata: { multiplier: 0.5 } });
    const effects = [RALLY(), PEPPER(), RAIN(), loss];
    // candidates: 4.25 × 0.5 = 2.125 (storm) and 4.25 − 0.5 = 3.75 (coin flip).
    assert.equal(mAt(effects), 2.125);
  });
});

test("ON: INVERSION GUARD — a lostFraction 0.75 coin flip does NOT shield from the storm", async () => {
  await withFlag("true", async () => {
    // metadata.multiplier 0.25 => lostFraction 0.75, a NOMINALLY stronger debuff.
    const harshLoss = effect("COIN_FLIP", { metadata: { multiplier: 0.25 } });
    const effects = [RALLY(), PEPPER(), RAIN(), harshLoss];
    // "max lostFraction wins" would have picked the coin flip: 4.25 − 0.75 = 3.5.
    // "apply every candidate, keep the lowest M" picks 4.25 × 0.5 = 2.125.
    assert.equal(mAt(effects), 2.125, "the storm, not 3.5");
  });
});

// ── 5. Coin Flip's losing side stays SUBTRACTIVE (deliberate divergence) ───
test("coin-flip loss ALONE on a buffed racer is unchanged in both flag states", async () => {
  const loss = () => effect("COIN_FLIP", { metadata: { multiplier: 0.5 } });
  for (const flag of [undefined, "true"]) {
    await withFlag(flag, async () => {
      assert.equal(
        mAt([RALLY(), PEPPER(), loss()]),
        3.75,
        `coin flip must remain M − lost (flag=${flag})`
      );
    });
  }
});

// ── 6 / 7. Freeze and Wrong Turn are untouched ─────────────────────────────
test("ON: freeze (Leg Cramp) + rainstorm is still exactly 0", async () => {
  await withFlag("true", async () => {
    assert.equal(mAt([RAIN(), effect("LEG_CRAMP")]), 0);
    assert.equal(await totalFor([RAIN(), effect("LEG_CRAMP")], 6000), 0);
  });
});

test("ON: Wrong Turn negates the HALVED rate", async () => {
  await withFlag("true", async () => {
    assert.equal(mAt([RAIN(), effect("WRONG_TURN")]), -0.5, "unbuffed: unchanged");
    // Buffed: 2 × 0.5 = 1, negated. (OFF this is −(2 − 0.5) = −1.5.)
    assert.equal(mAt([RH(), RAIN(), effect("WRONG_TURN")]), -1);
  });
  await withFlag(undefined, async () => {
    assert.equal(mAt([RH(), RAIN(), effect("WRONG_TURN")]), -1.5);
  });
});

// ── 4b. The UMBRELLA-adjusted synthetic rows carry NO `type` ───────────────
//
// `umbrellaAdjustedRainstorms` returns `{startsAt, expiresAt, metadata}` rows.
// An implementation dispatching on `effect.type === "RAINSTORM"` would leave
// umbrella-holders on the OLD subtractive math — wrong in exactly the case the
// Umbrella exists for (architect R8).
const UMB_START = new Date("2026-07-04T12:00:00Z");
const UMB_END = new Date("2026-07-04T12:30:00Z");
const COVERED = new Date("2026-07-04T12:15:00Z"); // umbrella up
const EXPOSED = new Date("2026-07-04T12:45:00Z"); // umbrella lapsed

function umbrellaCase() {
  return [
    RH(),
    RAIN(),
    effect("UMBRELLA", { startsAt: UMB_START, expiresAt: UMB_END, metadata: {} }),
  ];
}

test("ON: buffed + rainstorm + partially-overlapping umbrella takes the MULTIPLICATIVE branch", async () => {
  await withFlag("true", async () => {
    const effects = umbrellaCase();
    assert.equal(mAt(effects, COVERED), 2, "umbrella cancels the rain entirely");
    assert.equal(mAt(effects, EXPOSED), 1, "2 × 0.5 — the synthetic row has no `type`");
  });
});

test("OFF: the same umbrella case keeps the old subtractive value", async () => {
  await withFlag(undefined, async () => {
    const effects = umbrellaCase();
    assert.equal(mAt(effects, COVERED), 2);
    assert.equal(mAt(effects, EXPOSED), 1.5, "2 − 0.5");
  });
});

// ── 4c. Display / scoring / finish-interpolation agreement (architect R9) ──
//
// calculateCurrentTotal previously returned the RAW `byType.RAINSTORM` list to
// finish-time interpolation and dropped `umbrellas` on the floor, so an
// umbrella'd racer's settlement multiplier disagreed with their display one.
// This fix makes both consumers see the same windows.
async function groupsFromSettlement(effects) {
  const model = {
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      const byType = Object.fromEntries(types.map((t) => [t, []]));
      for (const e of effects) (byType[e.type] ||= []).push(e);
      return byType;
    },
  };
  return calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    baseAdjusted: 6000,
    hasSampleData: true,
    raceActiveEffectModel: model,
    stepSampleModel: makeStepModel(6000),
    now: new Date("2026-07-04T13:30:00Z"),
  });
}

test("ON: finish interpolation sees the SAME umbrella-adjusted windows as display", async () => {
  await withFlag("true", async () => {
    const effects = umbrellaCase();
    const settlement = await groupsFromSettlement(effects);
    const groups = {
      legCramps: settlement.legCramps,
      runnersHighs: settlement.runnersHighs,
      wrongTurns: settlement.wrongTurns,
      campfires: settlement.campfires,
      rainstorms: settlement.rainstorms,
      uprisings: settlement.uprisings,
      rallyFlags: settlement.rallyFlags,
      coinFlipWins: settlement.coinFlipWins,
      coinFlipLoses: settlement.coinFlipLoses,
      ghostPeppers: settlement.ghostPeppers,
    };
    assert.equal(
      signedMultiplierAt(COVERED.getTime(), groups),
      mAt(effects, COVERED),
      "settlement == display while the umbrella is up"
    );
    assert.equal(
      signedMultiplierAt(EXPOSED.getTime(), groups),
      mAt(effects, EXPOSED),
      "settlement == display once it lapses"
    );
    assert.equal(signedMultiplierAt(COVERED.getTime(), groups), 2);
    assert.equal(signedMultiplierAt(EXPOSED.getTime(), groups), 1);
  });
});

test("determineFinishSnapshot interpolates at the halved rate for a buffed victim", async () => {
  await withFlag("true", async () => {
    const T0 = new Date("2026-04-07T10:00:00Z");
    const T1 = new Date("2026-04-07T11:00:00Z");
    const samples = [
      { periodStart: T0.toISOString(), periodEnd: T1.toISOString(), steps: 1200 },
    ]; // 20 raw steps/min
    const snapshot = await determineFinishSnapshot({
      participant: { userId: "user-1", bonusSteps: 0 },
      currentTotal: 6000,
      targetSteps: 600,
      effectiveStart: T0,
      effectGroups: {
        legCramps: [],
        runnersHighs: [{ startsAt: T0, expiresAt: T1, metadata: {} }],
        wrongTurns: [],
        campfires: [],
        // A synthetic umbrella-adjusted row: NO `type` field, by construction.
        rainstorms: [{ startsAt: T0, expiresAt: T1, metadata: { multiplier: 0.5 } }],
        uprisings: [],
        rallyFlags: [],
        coinFlipWins: [],
        coinFlipLoses: [],
        ghostPeppers: [],
      },
      stepSampleModel: { async findByUserIdAndTimeRange() { return samples; } },
      powerupEventModel: { async findByRaceAsc() { return []; } },
      raceId: "race-1",
      now: T1,
    });
    // RH = 2x, halved by rain = 1x => 20 counted/min => 600 at minute 30.
    // The old subtractive rule gave 1.5x => 30/min => minute 20 (10:20).
    assert.equal(snapshot.finishTotalSteps, 600);
    assert.equal(snapshot.finishedAt.toISOString(), "2026-04-07T10:30:00.000Z");
  });
});

// ── 8. Display / settlement parity on the plain buffed-storm case ──────────
test("ON: signedMultiplierForEffects and calculateCurrentTotal agree", async () => {
  await withFlag("true", async () => {
    const effects = [RALLY(), PEPPER(), RAIN()];
    const { total } = await groupsFromSettlement(effects);
    assert.equal(total, await totalFor(effects, 6000));
    assert.equal(total, 12750);
  });
});
