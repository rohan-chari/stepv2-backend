// Single source of truth for the SIGNED effective step multiplier m(t)
// (buff-stacking spec §3). effectiveStepScoring.computeEffectModifiers,
// raceStateResolution.multiplierForTime, and globalStepEvent.computeGlobalEventBoost
// all delegate here so the three former copies can never drift again.
//
// Pure (no DB). `groups` carries the participant's effect rows split by type:
//   { legCramps, runnersHighs, wrongTurns, campfires, rainstorms, uprisings,
//     rallyFlags, coinFlipWins, coinFlipLoses, ghostPeppers }
// where `rainstorms` are the UMBRELLA-ADJUSTED windows (the caller subtracts each
// umbrella aura from the opponent-sourced rain windows BEFORE calling in, exactly
// as the pre-rewrite umbrella pass did).

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isActiveAt(effect, timeMs) {
  const startMs = toMs(effect.startsAt);
  const endMs = effect.expiresAt ? toMs(effect.expiresAt) : Infinity;
  return startMs <= timeMs && timeMs < endMs;
}

// Retained fraction r of a reduction (RAINSTORM / COIN_FLIP lose): metadata
// multiplier clamped to [0,1], else the canonical 0.5. lostFraction = 1 − r.
function reductionLostFraction(effect) {
  const m = Number((effect.metadata || {}).multiplier);
  const r = Number.isFinite(m) && m >= 0 && m <= 1 ? m : 0.5;
  return 1 - r;
}

// Batch 2026-08-10b item 6 — kill switch for the MULTIPLICATIVE rainstorm.
//
// Read at CALL time (the idiom `discardDailyCap()` uses), not module load:
// this function is pure and DB-free, so an app setting is the wrong shape, but
// "revert the commit" is not adequate for a change that alters scoring for
// every in-flight race on restart. With this OFF a bad settlement is reverted
// by a pm2 reload rather than a deploy. Ships "false"; flipped on in prod after
// staging verification (architect R10).
function rainstormMultiplicativeEnabled() {
  return process.env.RAINSTORM_MULTIPLICATIVE_ENABLED === "true";
}

// §3 — the signed effective multiplier at instant `timeMs`.
function signedMultiplierAt(timeMs, groups = {}) {
  const {
    legCramps = [],
    runnersHighs = [],
    wrongTurns = [],
    campfires = [],
    rainstorms = [],
    uprisings = [],
    rallyFlags = [],
    coinFlipWins = [],
    coinFlipLoses = [],
    ghostPeppers = [],
  } = groups;

  // 1. Freeze wins over everything (Leg Cramp / Quicksand, Campfire freeze phase,
  //    Ghost Pepper freeze phase). Freeze also beats Wrong Turn — you can't be
  //    dragged backwards while frozen.
  if (legCramps.some((e) => isActiveAt(e, timeMs))) return 0;
  const campfireFrozen = campfires.some((e) => {
    const startMs = toMs(e.startsAt);
    const freezeMs = (e.metadata || {}).freezeMs || 0;
    return startMs <= timeMs && timeMs < startMs + freezeMs;
  });
  if (campfireFrozen) return 0;
  const ghostFrozen = ghostPeppers.some((e) => {
    const startMs = toMs(e.startsAt);
    const boostMs = Number((e.metadata || {}).boostMs) || 0;
    const endMs = e.expiresAt ? toMs(e.expiresAt) : Infinity;
    return timeMs >= startMs + boostMs && timeMs < endMs;
  });
  if (ghostFrozen) return 0;

  // 2. Buffs SUM (pepper 3 + RH 2 = 5). Every active row of every buff type
  //    contributes its own multiplier; M defaults to 1 when no buff is active.
  let sum = 0;
  let buffed = false;
  for (const e of runnersHighs) {
    if (isActiveAt(e, timeMs)) {
      sum += 2;
      buffed = true;
    }
  }
  for (const e of campfires) {
    const startMs = toMs(e.startsAt);
    const freezeMs = (e.metadata || {}).freezeMs || 0;
    const endMs = e.expiresAt ? toMs(e.expiresAt) : Infinity;
    if (timeMs >= startMs + freezeMs && timeMs < endMs) {
      sum += (e.metadata || {}).multiplier || 1;
      buffed = true;
    }
  }
  for (const e of uprisings) {
    if (isActiveAt(e, timeMs)) {
      sum += Number((e.metadata || {}).multiplier) || 2;
      buffed = true;
    }
  }
  for (const e of rallyFlags) {
    if (isActiveAt(e, timeMs)) {
      sum += Number((e.metadata || {}).multiplier) || 1.25;
      buffed = true;
    }
  }
  for (const e of coinFlipWins) {
    if (isActiveAt(e, timeMs)) {
      const m = Number((e.metadata || {}).multiplier);
      sum += Number.isFinite(m) && m > 1 ? m : 2;
      buffed = true;
    }
  }
  for (const e of ghostPeppers) {
    const startMs = toMs(e.startsAt);
    const boostMs = Number((e.metadata || {}).boostMs) || 0;
    if (timeMs >= startMs && timeMs < startMs + boostMs) {
      sum += Number((e.metadata || {}).multiplier) || 3;
      buffed = true;
    }
  }
  let M = buffed ? sum : 1;

  // 3. Reductions. Compute the resulting M for EVERY active reduction
  //    independently and keep the LOWEST (batch 2026-08-10b item 6):
  //      * a `rainstorms` candidate yields M * retained — a TRUE halving. The
  //        copy says "Steps halved by rain" and the metadata field is literally
  //        `multiplier: 0.5`; subtracting 0.5 only equals halving when the
  //        victim is unbuffed (prod, "runners hi", 2026-08-10: a 4.25x stack
  //        went to 3.75x instead of 2.125x).
  //      * a `coinFlipLoses` candidate yields max(0, M − lost) — UNCHANGED.
  //        The divergence is deliberate and user-decided, not drift.
  //
  //    "Lowest resulting M" rather than "max lostFraction wins, then branch":
  //    with one branch multiplicative and one subtractive, `lostFraction` is no
  //    longer a valid ordering. At M = 4.25 a coin-flip loss with
  //    lostFraction 0.75 yields 3.5 while a 0.5 Rainstorm yields 2.125, so the
  //    nominally STRONGER debuff would have shielded the victim from the storm.
  //    Taking the minimum also preserves the "never stack two reductions" clamp
  //    exactly: two storms both yield M * 0.5, and min(M*0.5, M*0.5) = M*0.5.
  //
  //    DISPATCH IS ON THE GROUP ARRAY, NEVER ON `effect.type` (architect R8).
  //    `umbrellaAdjustedRainstorms` feeds synthetic {startsAt, expiresAt,
  //    metadata} rows into `rainstorms` with NO `type` field, so a type-based
  //    branch would silently leave umbrella-holders on the old subtractive
  //    math — wrong in exactly the case the Umbrella exists for.
  const multiplicative = rainstormMultiplicativeEnabled();
  let reducedM = null;
  const consider = (candidate) => {
    reducedM = reducedM === null ? candidate : Math.min(reducedM, candidate);
  };
  for (const e of rainstorms) {
    if (!isActiveAt(e, timeMs)) continue;
    const lostFraction = reductionLostFraction(e);
    consider(
      multiplicative ? M * (1 - lostFraction) : Math.max(0, M - lostFraction)
    );
  }
  for (const e of coinFlipLoses) {
    if (!isActiveAt(e, timeMs)) continue;
    consider(Math.max(0, M - reductionLostFraction(e)));
  }
  if (reducedM !== null) M = Math.max(0, reducedM);

  // 4. Wrong Turn negates the full effective rate (including the reductions).
  if (wrongTurns.some((e) => isActiveAt(e, timeMs))) return -M;
  return M;
}

// Every distinct multiplier-transition instant strictly inside (windowStart,
// windowEnd), plus the two endpoints — sorted and deduped. Slicing a window at
// these boundaries yields sub-intervals of constant m. windowStart/windowEnd are
// epoch ms.
function multiplierBoundaries(windowStart, windowEnd, groups = {}) {
  const bounds = new Set([windowStart, windowEnd]);
  const add = (ms) => {
    if (ms > windowStart && ms < windowEnd) bounds.add(ms);
  };
  const {
    legCramps = [],
    runnersHighs = [],
    wrongTurns = [],
    campfires = [],
    rainstorms = [],
    uprisings = [],
    rallyFlags = [],
    coinFlipWins = [],
    coinFlipLoses = [],
    ghostPeppers = [],
  } = groups;

  for (const e of [
    ...legCramps,
    ...runnersHighs,
    ...wrongTurns,
    ...rainstorms,
    ...uprisings,
    ...rallyFlags,
    ...coinFlipWins,
    ...coinFlipLoses,
  ]) {
    add(toMs(e.startsAt));
    if (e.expiresAt) add(toMs(e.expiresAt));
  }
  for (const e of campfires) {
    const startMs = toMs(e.startsAt);
    const freezeMs = (e.metadata || {}).freezeMs || 0;
    add(startMs);
    add(startMs + freezeMs); // freeze -> boost transition
    if (e.expiresAt) add(toMs(e.expiresAt));
  }
  for (const e of ghostPeppers) {
    const startMs = toMs(e.startsAt);
    const boostMs = Number((e.metadata || {}).boostMs) || 0;
    add(startMs);
    add(startMs + boostMs); // boost -> freeze transition
    if (e.expiresAt) add(toMs(e.expiresAt));
  }

  return [...bounds].sort((a, b) => a - b);
}

module.exports = { signedMultiplierAt, multiplierBoundaries };
