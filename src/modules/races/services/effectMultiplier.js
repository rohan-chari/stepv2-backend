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

  // 3. Reductions subtract additively, floored at 0. Applied ONCE at the max
  //    lostFraction among active reductions so a victim under two storms (or a
  //    storm + coin-flip loss) clamps at a single 0.5x, never 0.25x/0x.
  let lost = 0;
  let reduced = false;
  for (const e of rainstorms) {
    if (isActiveAt(e, timeMs)) {
      lost = Math.max(lost, reductionLostFraction(e));
      reduced = true;
    }
  }
  for (const e of coinFlipLoses) {
    if (isActiveAt(e, timeMs)) {
      lost = Math.max(lost, reductionLostFraction(e));
      reduced = true;
    }
  }
  if (reduced) M = Math.max(0, M - lost);

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
