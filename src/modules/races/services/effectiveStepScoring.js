const { computeGlobalEventBoost } = require("../../steps/globalStepEvent");
const { computeLeechEarnedTransfer } = require("../../powerups/leechTransfers");

function computeEffectModifiersFallback(effects, rawTotal) {
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

  for (const effect of effects) {
    const meta = effect.metadata || {};

    if (effect.type === "LEG_CRAMP" || effect.type === "QUICKSAND") {
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }

    if (effect.type === "RUNNERS_HIGH") {
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }

    if (effect.type === "WRONG_TURN") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      reversedSteps += Math.max(0, end - start);
    }

    if (effect.type === "RAINSTORM") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.round(
        Math.max(0, end - start) * rainstormLostFraction(effect)
      );
    }

    // Powerups Wave 5 (§3) — snapshot fallback branches mirroring the
    // sample-driven scorer. UMBRELLA has no snapshot term (its only job is to
    // subtract rain overlap, and without samples the conservative choice is to
    // leave the rain penalty in place — see §6.5).
    if (effect.type === "UPRISING" || effect.type === "RALLY_FLAG") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined ? meta.stepsAtExpiry : rawTotal;
      const m = Number(meta.multiplier) || (effect.type === "UPRISING" ? 2 : 1.25);
      buffedSteps += (m - 1) * Math.max(0, end - start);
    }

    if (effect.type === "COIN_FLIP") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined ? meta.stepsAtExpiry : rawTotal;
      const m = Number(meta.multiplier);
      const span = Math.max(0, end - start);
      if (Number.isFinite(m) && m > 1) buffedSteps += (m - 1) * span;
      else if (Number.isFinite(m) && m < 1) frozenSteps += Math.round(span * (1 - m));
    }

    if (effect.type === "GHOST_PEPPER") {
      // Without hourly samples the boost/freeze split can't be reconstructed
      // from a single snapshot, so treat the whole window's steps as boosted at
      // (mult−1) — the same conservative one-term choice the base fallback uses
      // for Campfire's boost.
      const start = meta.stepsAtBoostStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined ? meta.stepsAtExpiry : rawTotal;
      const mult = Number(meta.multiplier) || 3;
      buffedSteps += (mult - 1) * Math.max(0, end - start);
    }
  }

  return { frozenSteps, buffedSteps, reversedSteps, leechTransfers: [] };
}

// Fraction of steps LOST to a rainstorm (multiplier 0.5 => 0.5 lost). Read from
// metadata defensively so a missing/malformed multiplier degrades to the
// canonical 0.5x rather than crashing or zeroing steps.
function rainstormLostFraction(effect) {
  const multiplier = Number((effect.metadata || {}).multiplier);
  const m = Number.isFinite(multiplier) && multiplier >= 0 && multiplier <= 1
    ? multiplier
    : 0.5;
  return 1 - m;
}

// B4: with the PER-CASTER rainstorm limit, a single victim can be under two (or
// more) simultaneous storms — one RaceActiveEffect row per caster. The penalty
// must clamp at a SINGLE 0.5x, never stack to 0.25x/0x. We collapse all storm
// windows into their non-overlapping UNION and apply the penalty once per merged
// interval. lostFraction is the max across the merged storms (all are 0.5, so
// the result is the canonical single 0.5x). startEffect/endEffect carry the
// snapshots used only on the no-sample-data fallback path.
function mergeRainstormWindows(rainstorms) {
  if (!rainstorms || rainstorms.length === 0) return [];
  const items = rainstorms
    .map((e) => ({
      start: new Date(e.startsAt).getTime(),
      end: (e.expiresAt ? new Date(e.expiresAt) : new Date()).getTime(),
      effect: e,
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      last.lostFraction = Math.max(
        last.lostFraction,
        rainstormLostFraction(item.effect)
      );
      if (item.end > last.end) {
        last.end = item.end;
        last.endEffect = item.effect;
      }
    } else {
      merged.push({
        start: item.start,
        end: item.end,
        startEffect: item.effect,
        endEffect: item.effect,
        lostFraction: rainstormLostFraction(item.effect),
      });
    }
  }
  return merged;
}

// `globalContext` (optional, additive): { globalEvents: [...], now: Date }. When
// present, the EXTRA steps from any active GlobalStepEvent windows are returned
// as `globalBoostedSteps`, stacking multiplicatively with the per-participant
// timed multipliers below. Absent => globalBoostedSteps is 0 (legacy behavior).
async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel, hasSampleData = false, globalContext = null, now = null) {
  const nowDate = now || (globalContext && globalContext.now) || new Date();
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

  // Quicksand is canonically distinct for storage/serialization but shares the
  // exact Leg Cramp freeze mechanic in authoritative scoring.
  const legCramps = effects.filter((e) => e.type === "LEG_CRAMP" || e.type === "QUICKSAND");
  const runnersHighs = effects.filter((e) => e.type === "RUNNERS_HIGH");
  const wrongTurns = effects.filter((e) => e.type === "WRONG_TURN");
  const campfires = effects.filter((e) => e.type === "CAMPFIRE_REST");
  const rainstorms = effects.filter((e) => e.type === "RAINSTORM");
  const leeches = effects.filter((e) => e.type === "LEECH");
  // Powerups Wave 5 windowed step-modifiers (§3):
  //   * UPRISING (2x), RALLY_FLAG (1.25x), COIN_FLIP win (2x) — generic buffs.
  //   * COIN_FLIP lose (0.5x) — an additive reduction merged with Rainstorm.
  //   * GHOST_PEPPER — two-phase boost-then-freeze (Campfire inverted).
  //   * UMBRELLA — subtracts its overlap from opponent-sourced Rainstorm windows.
  const uprisings = effects.filter((e) => e.type === "UPRISING");
  const rallyFlags = effects.filter((e) => e.type === "RALLY_FLAG");
  const coinFlips = effects.filter((e) => e.type === "COIN_FLIP");
  const coinFlipWins = coinFlips.filter((e) => Number((e.metadata || {}).multiplier) > 1);
  const coinFlipLoses = coinFlips.filter((e) => {
    const m = Number((e.metadata || {}).multiplier);
    return Number.isFinite(m) && m < 1;
  });
  const ghostPeppers = effects.filter((e) => e.type === "GHOST_PEPPER");
  const umbrellas = effects.filter((e) => e.type === "UMBRELLA");

  for (const effect of legCramps) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      frozenSteps += sampleSteps;
    } else if (!hasSampleData) {
      // Only use snapshot fallback when user has no step sample data at all
      const meta = effect.metadata || {};
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }
  }

  for (const effect of runnersHighs) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      buffedSteps += sampleSteps;
    } else if (!hasSampleData) {
      // Only use snapshot fallback when user has no step sample data at all
      const meta = effect.metadata || {};
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }
  }

  for (const effect of campfires) {
    const meta = effect.metadata || {};
    const freezeMs = meta.freezeMs || 0;
    const multiplier = meta.multiplier || 1;
    const freezeStart = effect.startsAt;
    const freezeEnd = new Date(new Date(effect.startsAt).getTime() + freezeMs);
    const boostStart = freezeEnd;
    const boostEnd = effect.expiresAt || new Date();

    const frozenSampleSteps = await stepSampleModel.sumStepsInWindow(userId, freezeStart, freezeEnd);
    if (frozenSampleSteps > 0) {
      frozenSteps += frozenSampleSteps;
    } else if (!hasSampleData) {
      const start = meta.stepsAtRestStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }

    const boostedSampleSteps = await stepSampleModel.sumStepsInWindow(userId, boostStart, boostEnd);
    if (boostedSampleSteps > 0) {
      buffedSteps += boostedSampleSteps * Math.max(0, multiplier - 1);
    }
  }

  // Subtract overlap: steps during both a freeze and a buff should be frozen, not buffed
  for (const cramp of legCramps) {
    const crampStart = cramp.startsAt.getTime();
    const crampEnd = (cramp.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(crampStart, buffStart);
      const overlapEnd = Math.min(crampEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          buffedSteps -= overlapSteps;
        }
      }
    }
  }

  // Campfire Rest overlap with Runner's High:
  //   * Freeze phase: steps stay frozen — strip the RH buff for the overlap so
  //     RH cannot rescue frozen steps.
  //   * Boost phase: take the larger of the two multipliers, not both. Campfire
  //     contributes (multiplier - 1) and RH contributes 1; assuming campfire
  //     multiplier >= 2 (current upgrade range is 2.25–3.0), the RH +1 is the
  //     redundant one — strip it.
  // Matches raceStateResolution.js:238's max-not-sum semantics.
  for (const campfire of campfires) {
    const cfStart = campfire.startsAt.getTime();
    const cfFreezeMs = (campfire.metadata || {}).freezeMs || 0;
    const cfFreezeEnd = cfStart + cfFreezeMs;
    const cfBoostEnd = (campfire.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(cfStart, buffStart);
      const overlapEnd = Math.min(cfBoostEnd, buffEnd);
      if (overlapStart >= overlapEnd) continue;

      const overlapSteps = await stepSampleModel.sumStepsInWindow(
        userId, new Date(overlapStart), new Date(overlapEnd)
      );
      if (overlapSteps > 0) {
        buffedSteps -= overlapSteps;
      }
    }
  }

  // Wrong Turn: steps during the effect are reversed (subtracted twice — once to undo, once to negate)
  for (const effect of wrongTurns) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      reversedSteps += sampleSteps;
    }
  }

  // Wrong Turn + Runner's High overlap: steps are doubled AND negated
  for (const wt of wrongTurns) {
    const wtStart = wt.startsAt.getTime();
    const wtEnd = (wt.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(wtStart, buffStart);
      const overlapEnd = Math.min(wtEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          // Remove buff credit and negate for doubled reversal
          buffedSteps -= 2 * overlapSteps;
        }
      }
    }
  }

  // ── Powerups Wave 5 buffs (UPRISING / RALLY_FLAG / COIN_FLIP win / GHOST_PEPPER
  // boost) — additive (m-1)×windowSteps, reconciled to MAX-not-sum with each
  // other and Runner's High (§3.1/§3.3/§3.8), and stripped during any freeze. ─
  const windowStepsFor = async (effect, metaStartKey) => {
    const s = effect.startsAt;
    const e = effect.expiresAt || new Date();
    const samp = await stepSampleModel.sumStepsInWindow(userId, s, e);
    if (samp > 0) return samp;
    if (!hasSampleData) {
      const meta = effect.metadata || {};
      const start = meta[metaStartKey] || 0;
      const end =
        effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
          ? meta.stepsAtExpiry
          : rawTotal;
      return Math.max(0, end - start);
    }
    return 0;
  };

  // Collect boost windows (extra = multiplier − 1) for the max-not-sum pass. RH
  // is included so RH×(new buff) overlaps also resolve to the larger multiplier.
  const boostWindows = [];
  for (const rh of runnersHighs) {
    boostWindows.push({ start: new Date(rh.startsAt).getTime(), end: (rh.expiresAt ? new Date(rh.expiresAt) : new Date()).getTime(), extra: 1 });
  }
  for (const up of uprisings) {
    const m = Number((up.metadata || {}).multiplier) || 2;
    buffedSteps += (m - 1) * (await windowStepsFor(up, "stepsAtStart"));
    boostWindows.push({ start: new Date(up.startsAt).getTime(), end: (up.expiresAt ? new Date(up.expiresAt) : new Date()).getTime(), extra: m - 1 });
  }
  for (const rf of rallyFlags) {
    const m = Number((rf.metadata || {}).multiplier) || 1.25;
    buffedSteps += (m - 1) * (await windowStepsFor(rf, "stepsAtStart"));
    boostWindows.push({ start: new Date(rf.startsAt).getTime(), end: (rf.expiresAt ? new Date(rf.expiresAt) : new Date()).getTime(), extra: m - 1 });
  }
  for (const cf of coinFlipWins) {
    const m = Number((cf.metadata || {}).multiplier) || 2;
    buffedSteps += (m - 1) * (await windowStepsFor(cf, "stepsAtStart"));
    boostWindows.push({ start: new Date(cf.startsAt).getTime(), end: (cf.expiresAt ? new Date(cf.expiresAt) : new Date()).getTime(), extra: m - 1 });
  }
  // Ghost Pepper boost phase [start, start+boostMs): (mult−1)×steps.
  for (const gp of ghostPeppers) {
    const meta = gp.metadata || {};
    const mult = Number(meta.multiplier) || 3;
    const boostMs = Number(meta.boostMs) || 0;
    const boostStart = new Date(gp.startsAt);
    const boostEnd = new Date(new Date(gp.startsAt).getTime() + boostMs);
    const samp = await stepSampleModel.sumStepsInWindow(userId, boostStart, boostEnd);
    let boostSteps = samp;
    if (samp <= 0 && !hasSampleData) {
      // No conservative snapshot split available for the two phases; skip.
      boostSteps = 0;
    }
    if (boostSteps > 0) buffedSteps += (mult - 1) * boostSteps;
    boostWindows.push({ start: boostStart.getTime(), end: boostEnd.getTime(), extra: mult - 1 });
  }

  // MAX-not-sum reconciliation: for every overlapping pair of boost windows,
  // subtract the SMALLER extra over the overlap so two boosts never sum.
  for (let i = 0; i < boostWindows.length; i++) {
    for (let j = i + 1; j < boostWindows.length; j++) {
      const a = boostWindows[i];
      const b = boostWindows[j];
      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapStart >= overlapEnd) continue;
      const overlapSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(overlapStart), new Date(overlapEnd));
      if (overlapSteps > 0) buffedSteps -= Math.min(a.extra, b.extra) * overlapSteps;
    }
  }

  // Ghost Pepper freeze phase [start+boostMs, expiresAt): steps frozen, like a
  // Leg Cramp. Collected for the rain-suspend pass below too.
  const ghostFreezeWindows = [];
  for (const gp of ghostPeppers) {
    const meta = gp.metadata || {};
    const boostMs = Number(meta.boostMs) || 0;
    const freezeStart = new Date(new Date(gp.startsAt).getTime() + boostMs);
    const freezeEnd = gp.expiresAt ? new Date(gp.expiresAt) : new Date();
    ghostFreezeWindows.push({ start: freezeStart.getTime(), end: freezeEnd.getTime() });
    const samp = await stepSampleModel.sumStepsInWindow(userId, freezeStart, freezeEnd);
    if (samp > 0) frozenSteps += samp;
  }

  // Strip boost credit that overlaps ANY freeze window (Leg Cramp / Quicksand,
  // Campfire freeze phase, Ghost Pepper freeze) — freeze beats buff. RH is
  // already stripped for Leg Cramp / Campfire above; here we strip the new
  // buffs over every freeze window, plus RH/all over the Ghost freeze window.
  const allFreezeWindows = [
    ...legCramps.map((e) => ({ start: new Date(e.startsAt).getTime(), end: (e.expiresAt ? new Date(e.expiresAt) : new Date()).getTime() })),
    ...campfires.map((e) => ({ start: new Date(e.startsAt).getTime(), end: new Date(e.startsAt).getTime() + ((e.metadata || {}).freezeMs || 0) })),
    ...ghostFreezeWindows,
  ];
  const newBuffWindows = boostWindows.filter((w) =>
    // Only the wave-5 buffs need stripping here; RH is handled by the existing
    // Leg Cramp / Campfire loops, so exclude the extra===1 RH windows that were
    // already stripped. We still strip RH over the GHOST freeze window below.
    true
  );
  for (const fw of allFreezeWindows) {
    for (const bw of newBuffWindows) {
      // RH windows over Leg Cramp / Campfire freeze are already stripped by the
      // earlier loops; avoid double-stripping them there. RH over the Ghost
      // freeze window is NOT yet stripped, so include RH only for ghost windows.
      const isRh = bw.extra === 1 && runnersHighs.some(
        (rh) => new Date(rh.startsAt).getTime() === bw.start
      );
      const isGhostFreeze = ghostFreezeWindows.some((g) => g.start === fw.start && g.end === fw.end);
      if (isRh && !isGhostFreeze) continue;
      const overlapStart = Math.max(fw.start, bw.start);
      const overlapEnd = Math.min(fw.end, bw.end);
      if (overlapStart >= overlapEnd) continue;
      const overlapSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(overlapStart), new Date(overlapEnd));
      if (overlapSteps > 0) buffedSteps -= bw.extra * overlapSteps;
    }
  }

  // Rainstorm: an ADDITIVE -0.5x on step accrual during the storm window,
  // folded into frozenSteps (both are plain subtractions from the total).
  // Interactions:
  //   * Runner's High / Campfire boost overlap stays additive: 2x - 0.5x = 1.5x.
  //   * While steps are already FROZEN (Leg Cramp, Campfire freeze phase) or
  //     REVERSED (Wrong Turn), the rain penalty is SUSPENDED — those windows
  //     already contribute 0x / -1x, and stacking the rain penalty on top would
  //     over-punish (e.g. frozen steps going NEGATIVE). The overlap loop below
  //     subtracts the rain penalty back out for those windows.
  // multiplierForTime in raceStateResolution.js mirrors exactly this model so
  // finish-time interpolation agrees with these totals.
  // B4: apply the storm penalty ONCE over the UNION of all storm windows on
  // this victim, so two overlapping storms clamp at a single 0.5x (not 0.25x).
  const rainWindows = mergeRainstormWindows(rainstorms);
  for (const window of rainWindows) {
    const windowStart = new Date(window.start);
    const windowEnd = new Date(window.end);
    const lostFraction = window.lostFraction;

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      frozenSteps += Math.round(sampleSteps * lostFraction);
    } else if (!hasSampleData) {
      // Only use snapshot fallback when user has no step sample data at all.
      // Union approximation: earliest storm's start snapshot to the latest
      // storm's end snapshot, penalized once.
      const meta = window.startEffect.metadata || {};
      const start = meta.stepsAtStart || 0;
      const endMeta = window.endEffect.metadata || {};
      const end = window.endEffect.status === "EXPIRED" && endMeta.stepsAtExpiry !== undefined
        ? endMeta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.round(Math.max(0, end - start) * lostFraction);
    }
  }

  // Suspend the rain penalty during frozen/reversed windows (see note above).
  // Iterate the same merged storm windows so the suspend subtraction matches
  // the single-0.5x penalty applied above.
  for (const storm of rainWindows) {
    const stormStart = storm.start;
    const stormEnd = storm.end;
    const lostFraction = storm.lostFraction;

    const suspendedWindows = [
      ...legCramps.map((e) => ({
        start: e.startsAt.getTime(),
        end: (e.expiresAt || new Date()).getTime(),
      })),
      ...wrongTurns.map((e) => ({
        start: e.startsAt.getTime(),
        end: (e.expiresAt || new Date()).getTime(),
      })),
      ...campfires.map((e) => ({
        start: e.startsAt.getTime(),
        end: e.startsAt.getTime() + ((e.metadata || {}).freezeMs || 0),
      })),
      // Ghost Pepper freeze phase suspends the rain penalty too.
      ...ghostFreezeWindows,
    ];

    for (const window of suspendedWindows) {
      const overlapStart = Math.max(stormStart, window.start);
      const overlapEnd = Math.min(stormEnd, window.end);
      if (overlapStart >= overlapEnd) continue;

      const overlapSteps = await stepSampleModel.sumStepsInWindow(
        userId, new Date(overlapStart), new Date(overlapEnd)
      );
      if (overlapSteps > 0) {
        frozenSteps -= Math.round(overlapSteps * lostFraction);
      }
    }
  }

  // ── Coin Flip LOSE (§3.3): a self-inflicted additive reduction, folded into
  // frozenSteps exactly like Rainstorm. Merged so a user under BOTH a Coin Flip
  // lose and a Rainstorm is never penalized below 0.5x combined: apply each
  // penalty over its own merged windows, then subtract the overlap once. The
  // Umbrella subtraction below deliberately does NOT touch these self windows. ─
  const coinFlipWindows = mergeRainstormWindows(coinFlipLoses);
  for (const window of coinFlipWindows) {
    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(window.start), new Date(window.end));
    if (sampleSteps > 0) {
      frozenSteps += Math.round(sampleSteps * window.lostFraction);
    } else if (!hasSampleData) {
      const meta = window.startEffect.metadata || {};
      const start = meta.stepsAtStart || 0;
      const endMeta = window.endEffect.metadata || {};
      const end = window.endEffect.status === "EXPIRED" && endMeta.stepsAtExpiry !== undefined ? endMeta.stepsAtExpiry : rawTotal;
      frozenSteps += Math.round(Math.max(0, end - start) * window.lostFraction);
    }
  }
  // Dedupe rain∩coinflip overlap so combined stays at a single 0.5x, not 1.0x.
  for (const rw of rainWindows) {
    for (const cw of coinFlipWindows) {
      const overlapStart = Math.max(rw.start, cw.start);
      const overlapEnd = Math.min(rw.end, cw.end);
      if (overlapStart >= overlapEnd) continue;
      const overlapSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(overlapStart), new Date(overlapEnd));
      if (overlapSteps > 0) frozenSteps -= Math.round(overlapSteps * Math.min(rw.lostFraction, cw.lostFraction));
    }
  }
  // Coin Flip lose suspended during any freeze/reverse window (freeze beats it).
  for (const cw of coinFlipWindows) {
    const suspend = [
      ...legCramps.map((e) => ({ start: new Date(e.startsAt).getTime(), end: (e.expiresAt ? new Date(e.expiresAt) : new Date()).getTime() })),
      ...wrongTurns.map((e) => ({ start: new Date(e.startsAt).getTime(), end: (e.expiresAt ? new Date(e.expiresAt) : new Date()).getTime() })),
      ...ghostFreezeWindows,
    ];
    for (const w of suspend) {
      const overlapStart = Math.max(cw.start, w.start);
      const overlapEnd = Math.min(cw.end, w.end);
      if (overlapStart >= overlapEnd) continue;
      const overlapSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(overlapStart), new Date(overlapEnd));
      if (overlapSteps > 0) frozenSteps -= Math.round(overlapSteps * cw.lostFraction);
    }
  }

  // ── Umbrella (§3.7): subtract the overlap of each Umbrella aura with the
  // victim's merged Rainstorm windows (opponent-sourced by construction — every
  // RAINSTORM row on a user was placed by an opponent). Only Rainstorm, never a
  // self-sourced Coin Flip lose. Conservative fallback: no sample data ⇒ no
  // subtraction (the rain penalty stands). ─
  for (const umbrella of umbrellas) {
    const uStart = new Date(umbrella.startsAt).getTime();
    const uEnd = (umbrella.expiresAt ? new Date(umbrella.expiresAt) : new Date()).getTime();
    for (const rw of rainWindows) {
      const overlapStart = Math.max(uStart, rw.start);
      const overlapEnd = Math.min(uEnd, rw.end);
      if (overlapStart >= overlapEnd) continue;
      const overlapSteps = await stepSampleModel.sumStepsInWindow(userId, new Date(overlapStart), new Date(overlapEnd));
      if (overlapSteps > 0) frozenSteps -= Math.round(overlapSteps * rw.lostFraction);
    }
  }

  // Leech (§5): a leecher-driven, uncapped, ZERO-SUM step TRANSFER. Each LEECH on
  // THIS victim mints floor(leecherWindowSteps / ratio) candidate steps from the
  // LEECHER's (sourceUserId) in-window steps (the in-progress hour excluded for
  // monotonicity). Unlike the old debuff this is NOT folded into frozenSteps — it
  // is returned as per-leech `earnedTransfer` values so the caller can drain the
  // victim AND credit the attacker against the victim's actual available balance
  // (resolved deterministically across the whole race in applyLeechTransfers).
  // A leecher who doesn't walk drains nothing. There is no per-use cap; the
  // victim's floored balance is the only ceiling.
  const leechTransfers = [];
  for (const effect of leeches) {
    if (!effect.sourceUserId) continue;
    const earnedTransfer = await computeLeechEarnedTransfer(
      effect,
      stepSampleModel,
      nowDate
    );
    if (earnedTransfer > 0) {
      leechTransfers.push({
        effectId: effect.id,
        startsAt: effect.startsAt,
        sourceUserId: effect.sourceUserId,
        earnedTransfer,
      });
    }
  }

  // Global step-multiplier event boost (additive, stacks multiplicatively with
  // the per-participant multipliers above). Computed over the SAME effect groups
  // so display and settlement agree exactly.
  let globalBoostedSteps = 0;
  if (globalContext && globalContext.globalEvents && globalContext.globalEvents.length > 0) {
    globalBoostedSteps = await computeGlobalEventBoost({
      globalEvents: globalContext.globalEvents,
      effectGroups: { legCramps, runnersHighs, wrongTurns, campfires },
      userId,
      stepSampleModel,
      now: globalContext.now,
    });
  }

  return { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps, leechTransfers };
}

// §5.3 `powerupData.dropOdds`. Mirrors openMysteryBox's ranking rules exactly:
// individual races rank on true total steps; team races collapse to a 2-slot
// race where the trailing team gets the catch-up tier and a tie counts both
// teams as leading. Returns null if the viewer's slot can't be determined, in
// which case the field is omitted entirely (clients presence-check it).

module.exports = { computeEffectModifiers };
