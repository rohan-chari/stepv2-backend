const { computeGlobalEventBoost } = require("../../steps/globalStepEvent");
const { computeLeechEarnedTransfer } = require("../../powerups/leechTransfers");
const {
  signedMultiplierAt,
  multiplierBoundaries,
} = require("./effectMultiplier");

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

// Interval subtraction: [start, end] minus a set of "holes" (each {start, end}),
// returning the remaining non-empty sub-intervals. Used to strip UMBRELLA-covered
// spans out of a rainstorm window before m(t) (§3.3), so the rain penalty simply
// doesn't exist where an umbrella is up.
function subtractIntervals(start, end, holes) {
  let segments = [[start, end]];
  for (const hole of holes) {
    const next = [];
    for (const [s, e] of segments) {
      if (hole.end <= s || hole.start >= e) {
        next.push([s, e]);
        continue;
      }
      if (hole.start > s) next.push([s, Math.min(hole.start, e)]);
      if (hole.end < e) next.push([Math.max(hole.end, s), e]);
    }
    segments = next;
  }
  return segments.filter(([s, e]) => e > s);
}

// UMBRELLA-adjusted rainstorm windows: every RAINSTORM row is opponent-sourced by
// construction, so each umbrella aura cancels the rain penalty over its overlap.
// Returns pseudo-effect rows ({startsAt, expiresAt, metadata}) carrying each
// storm's own multiplier so signedMultiplierAt reads the right lostFraction.
function umbrellaAdjustedRainstorms(rainstorms, umbrellas, nowMs) {
  if (!umbrellas || umbrellas.length === 0) return rainstorms;
  const holes = umbrellas
    .map((u) => ({
      start: new Date(u.startsAt).getTime(),
      end: (u.expiresAt ? new Date(u.expiresAt) : new Date(nowMs)).getTime(),
    }))
    .filter((h) => Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  if (holes.length === 0) return rainstorms;

  const adjusted = [];
  for (const storm of rainstorms) {
    const rs = new Date(storm.startsAt).getTime();
    const re = (storm.expiresAt ? new Date(storm.expiresAt) : new Date(nowMs)).getTime();
    if (!Number.isFinite(rs) || !Number.isFinite(re) || re <= rs) continue;
    for (const [s, e] of subtractIntervals(rs, re, holes)) {
      adjusted.push({
        startsAt: new Date(s),
        expiresAt: new Date(e),
        metadata: storm.metadata || {},
      });
    }
  }
  return adjusted;
}

async function sumWindows(model, userId, windows) {
  if (windows.length === 0) return [];
  if (typeof model.sumStepsInWindows === "function") {
    return model.sumStepsInWindows(userId, windows);
  }
  return Promise.all(
    windows.map((w) => model.sumStepsInWindow(userId, w.start, w.end))
  );
}

// `globalContext` (optional, additive): { globalEvents: [...], now: Date }. When
// present, the EXTRA steps from any active GlobalStepEvent windows are returned
// as `globalBoostedSteps`, scaling the SIGNED per-participant rate (§3): positive
// segments gain, wrong-turned segments lose more, frozen segments earn 0. Absent
// => globalBoostedSteps is 0 (legacy behavior).
async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel, hasSampleData = false, globalContext = null, now = null) {
  const nowDate = now || (globalContext && globalContext.now) || new Date();
  const nowMs = new Date(nowDate).getTime();
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
  //   * UPRISING, RALLY_FLAG, COIN_FLIP win — generic buffs (sum).
  //   * COIN_FLIP lose — an additive reduction alongside Rainstorm.
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

  // Umbrella subtraction happens BEFORE m(t): pass the shared multiplier the
  // rain windows that actually penalize (§3.3). Display and settlement both build
  // `groups` here, so the same effectGroups feed the global-event math below —
  // no divergence.
  const effectiveRainstorms = umbrellaAdjustedRainstorms(rainstorms, umbrellas, nowMs);
  const groups = {
    legCramps,
    runnersHighs,
    wrongTurns,
    campfires,
    rainstorms: effectiveRainstorms,
    uprisings,
    rallyFlags,
    coinFlipWins,
    coinFlipLoses,
    ghostPeppers,
  };

  const hasStepEffect =
    legCramps.length ||
    runnersHighs.length ||
    wrongTurns.length ||
    campfires.length ||
    rainstorms.length ||
    uprisings.length ||
    rallyFlags.length ||
    coinFlips.length ||
    ghostPeppers.length;

  if (hasStepEffect) {
    if (hasSampleData) {
      // ── Segment walk (§4.2). Slice [earliest effect start, now] at every
      // multiplier boundary, read each segment's steps ONCE, and bucket the
      // signed multiplier into the existing frozen/buffed/reversed terms so the
      // total formula (base − frozen + buffed − 2·reversed + event + bonus) is
      // untouched. Segments only exist where effects exist — a participant with
      // no effects early-returns above, never adding a query. ──
      const starts = [];
      for (const e of [
        ...legCramps,
        ...runnersHighs,
        ...wrongTurns,
        ...campfires,
        ...effectiveRainstorms,
        ...uprisings,
        ...rallyFlags,
        ...coinFlipWins,
        ...coinFlipLoses,
        ...ghostPeppers,
      ]) {
        starts.push(new Date(e.startsAt).getTime());
      }
      const windowStart = Math.min(...starts);
      const windowEnd = nowMs;
      if (windowEnd > windowStart) {
        const boundaries = multiplierBoundaries(windowStart, windowEnd, groups);
        const segments = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
          const segStart = boundaries[i];
          const segEnd = boundaries[i + 1];
          if (segEnd <= segStart) continue;
          const m = signedMultiplierAt(segStart, groups);
          if (m === 1) continue; // no delta from base
          segments.push({
            m,
            start: new Date(segStart),
            end: new Date(segEnd),
          });
        }
        const sums = await sumWindows(
          stepSampleModel,
          userId,
          segments.map((s) => ({ start: s.start, end: s.end }))
        );
        for (let k = 0; k < segments.length; k++) {
          const s = sums[k];
          if (!s || s <= 0) continue;
          const m = segments[k].m;
          if (m === 0) {
            frozenSteps += s;
          } else if (m > 0) {
            buffedSteps += (m - 1) * s;
          } else {
            reversedSteps += s;
            buffedSteps += (m + 1) * s;
          }
        }
      }
    } else {
      // Snapshot fallback (§4.2): no hourly samples, so approximate each effect
      // from its stored step snapshots. Overlap reconciliation is a no-op without
      // samples (all overlap sums are 0), so the per-effect deltas below are the
      // exact behavior the pre-rewrite fallback produced. Wrong Turn / Ghost
      // freeze / Umbrella have no snapshot term, matching the old path.
      // Ghost Pepper and Campfire are handled outside this helper: Ghost Pepper
      // contributes nothing without samples (the boost/freeze split is
      // unreconstructable from one snapshot — the pre-rewrite path also skipped
      // it), and Campfire's freeze snapshot keys off stepsAtRestStart below.
      const snap = computeEffectModifiersFallback(
        [
          ...legCramps,
          ...runnersHighs,
          ...uprisings,
          ...rallyFlags,
          ...coinFlips,
        ],
        rawTotal
      );
      frozenSteps += snap.frozenSteps;
      buffedSteps += snap.buffedSteps;
      reversedSteps += snap.reversedSteps;
      // Campfire freeze-phase snapshot (computeEffectModifiersFallback keys Leg
      // Cramp off stepsAtFreezeStart, but Campfire stores stepsAtRestStart).
      for (const effect of campfires) {
        const meta = effect.metadata || {};
        const start = meta.stepsAtRestStart || 0;
        const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
          ? meta.stepsAtExpiry
          : rawTotal;
        frozenSteps += Math.max(0, end - start);
      }
      // Rainstorm snapshot over the merged (per-caster-clamped) windows.
      for (const window of mergeRainstormWindows(rainstorms)) {
        const meta = window.startEffect.metadata || {};
        const start = meta.stepsAtStart || 0;
        const endMeta = window.endEffect.metadata || {};
        const end = window.endEffect.status === "EXPIRED" && endMeta.stepsAtExpiry !== undefined
          ? endMeta.stepsAtExpiry
          : rawTotal;
        frozenSteps += Math.round(Math.max(0, end - start) * window.lostFraction);
      }
    }
  }

  // Leech (§5): a leecher-driven, uncapped, ZERO-SUM step TRANSFER. Each LEECH on
  // THIS victim mints floor(leecherWindowSteps / ratio) candidate steps from the
  // LEECHER's (sourceUserId) in-window steps (the in-progress hour excluded for
  // monotonicity). Unlike the old debuff this is NOT folded into frozenSteps — it
  // is returned as per-leech `earnedTransfer` values so the caller can drain the
  // victim AND credit the attacker against the victim's actual available balance
  // (resolved deterministically across the whole race in applyLeechTransfers).
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

  // Global step-multiplier event boost (additive term). Computed over the SAME
  // umbrella-adjusted `groups` with SIGNED m(t), so a pepper-stacked segment
  // gains m×E, a wrong-turned segment loses, and a frozen segment earns 0 — and
  // display == settlement because both build `groups` identically.
  let globalBoostedSteps = 0;
  if (globalContext && globalContext.globalEvents && globalContext.globalEvents.length > 0) {
    globalBoostedSteps = await computeGlobalEventBoost({
      globalEvents: globalContext.globalEvents,
      effectGroups: groups,
      userId,
      stepSampleModel,
      now: globalContext.now,
    });
  }

  return { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps, leechTransfers };
}

module.exports = { computeEffectModifiers };
