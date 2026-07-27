// Mystery-box roller. This module holds MECHANICS ONLY — every number it uses
// (which types exist per tier, the position-odds curve, per-type weights) comes
// from `modules/economy/balanceConfig`. Do not add a table here; a structural guard
// test will fail if you do. See balanceConfig.defaults.js for why.
//
// NOTE: CAMPFIRE_REST and TRAIL_MAGNET are intentionally NOT generated anymore
// (1.1.7). Their enum values and effect-resolution code are kept (old apps +
// in-flight effects still resolve them), but they are absent from the config's
// dropPool, so they never roll into a new mystery box.
const { balanceConfig } = require("../economy/balanceConfig");
const { RARITIES } = require("../economy/balanceConfig.defaults");
// Client-feature gating list. Deliberately NOT balance config: which BINARIES
// may see a powerup type is a frozen-client compatibility question and must
// never become admin-editable (see constants/powerupGating.js).
const { POWERUPS5_GATED_TYPES } = require("./constants/powerupGating");

const RARITY_ORDER = RARITIES;

function resolveConfig(config) {
  return config || balanceConfig.getConfigSync();
}

function coerceMinRarity(rarity, minRarity) {
  if (!minRarity) return rarity;
  const rarityIndex = RARITY_ORDER.indexOf(rarity);
  const minIndex = RARITY_ORDER.indexOf(minRarity);
  if (rarityIndex === -1 || minIndex === -1) return rarity;
  return RARITY_ORDER[Math.max(rarityIndex, minIndex)];
}

// normalizedPosition: 0 = leader, 1 = last place. Everything between is a
// straight linear interpolation of the two configured rows.
function interpolateOdds(normalizedPosition, config) {
  const { positionOdds } = resolveConfig(config);
  const t = Math.max(0, Math.min(1, normalizedPosition));
  return [0, 1, 2].map(
    (i) => positionOdds.first[i] + t * (positionOdds.last[i] - positionOdds.first[i])
  );
}

function normalizePosition(position, totalParticipants) {
  return totalParticipants <= 1 ? 0.5 : (position - 1) / (totalParticipants - 1);
}

// Full [COMMON, UNCOMMON, RARE] distribution for a race slot — the same numbers
// the roll below actually uses. Exposed so the player-facing odds display and
// the roller can never drift apart.
function rarityOddsForPosition(position, totalParticipants, config) {
  return interpolateOdds(normalizePosition(position, totalParticipants), config);
}

function weightForType(type, config) {
  const weight = resolveConfig(config).typeWeights?.[type];
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 0
    ? weight
    : 1;
}

// ---------------------------------------------------------------------------
// Position-aware drop filtering (docs/position-aware-drops-requirements.md).
//
// Everything below acts STRICTLY WITHIN an already-chosen rarity tier. The tier
// distribution produced by rarityOddsForPosition is untouched, which is a hard
// requirement: the shipped odds sheet hides itself entirely if the `rarity`
// block stops summing to 1.0 ± 0.01.
// ---------------------------------------------------------------------------

// Normalized position at which a down-weight has fully faded out. Deliberately
// mid-field: a rule aimed at the front must be inert at the back, and vice
// versa, with a linear ramp in between so there is no cliff at any position.
const DOWNWEIGHT_NEUTRAL_POINT = 0.5;

function clamp01(value) {
  return Math.max(0, Math.min(1, typeof value === "number" && Number.isFinite(value) ? value : 0));
}

function toSteps(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// THE shared position predicate. Both the roll (openMysteryBox) and the
// disclosure (getRaceProgress) derive their context here so the two can never
// disagree about who is excluded from what.
//
// The predicates are computed from TRUE INDIVIDUAL step totals, in solo AND team
// races, and deliberately NOT from `position`:
//   * RED_CARD / SECOND_WIND reject on a TIE at the top, and sort order among
//     equal step counts is arbitrary — a position index would exclude whichever
//     tied player happened to sort first.
//   * team races collapse `position` to 1-of-2 / 2-of-2 for tier purposes, but
//     RED_CARD's use-time check targets the INDIVIDUAL leader. A member of the
//     leading team who is not personally the step leader may still play it.
// `isTeamRace` and `supportsPowerups5` (2026-07-26) are the two HARD gates —
// see eligiblePoolFor. Both default to false, which is both the pre-existing
// behaviour for every caller that does not pass them AND the safe side of a
// compatibility gate: an unidentified client is treated as an old one.
function buildRollContext({
  stepTotals,
  myTotalSteps,
  position,
  totalParticipants,
  isTeamRace = false,
  supportsPowerups5 = false,
}) {
  const totals = Array.isArray(stepTotals) ? stepTotals.map(toSteps) : [];
  const mine = toSteps(myTotalSteps);
  return {
    normalizedPosition: normalizePosition(position, totalParticipants),
    // At or tied for the maximum: nobody has strictly more steps than me.
    isStepLeader: !totals.some((t) => t > mine),
    // At or tied for the minimum: nobody has strictly fewer steps than me.
    isStepLast: !totals.some((t) => t < mine),
    isTeamRace: isTeamRace === true,
    supportsPowerups5: supportsPowerups5 === true,
  };
}

// Linear ramp from "no effect" at mid-field to "full strength" at `from`.
// Returns 0..1, where 1 means the configured multiplier applies in full.
function rampStrength(t, from, towardFront) {
  const neutral = DOWNWEIGHT_NEUTRAL_POINT;
  if (towardFront) {
    if (t >= neutral) return 0;
    const span = neutral - from;
    if (!(span > 0)) return 1;
    return clamp01((neutral - t) / span);
  }
  if (t <= neutral) return 0;
  const span = from - neutral;
  if (!(span > 0)) return 1;
  return clamp01((t - neutral) / span);
}

function thresholdOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

// Relative weight multiplier for a type at this position. 1.0 == untouched.
// A down-weight is always a tilt: the type stays reachable everywhere.
function positionMultiplierFor(type, ctx, config) {
  const rules = resolveConfig(config).positionRules;
  if (!rules) return 1;
  const t = clamp01(ctx?.normalizedPosition ?? DOWNWEIGHT_NEUTRAL_POINT);
  let multiplier = 1;

  const leading = rules.leadingDownweight?.[type];
  if (typeof leading === "number" && Number.isFinite(leading) && leading >= 0) {
    const strength = rampStrength(t, thresholdOr(rules.leadingDownweightFrom, 0.4), true);
    multiplier *= 1 + strength * (leading - 1);
  }

  const trailing = rules.trailingDownweight?.[type];
  if (typeof trailing === "number" && Number.isFinite(trailing) && trailing >= 0) {
    const strength = rampStrength(t, thresholdOr(rules.trailingDownweightFrom, 0.6), false);
    multiplier *= 1 + strength * (trailing - 1);
  }

  return multiplier;
}

// The single seam. `pickTypeForRarity` (the roll) and `typeOddsForPosition` (the
// disclosure) BOTH read the pool and weights from here — if they ever stop
// doing so, the odds sheet starts lying to players.
function eligiblePoolFor(rarity, ctx, config) {
  const cfg = resolveConfig(config);
  const basePool = Array.isArray(cfg.dropPool?.[rarity]) ? cfg.dropPool[rarity] : [];
  const rules = cfg.positionRules;

  const excluded = new Set();
  if (rules && ctx?.isStepLeader && Array.isArray(rules.leaderExcluded)) {
    for (const type of rules.leaderExcluded) excluded.add(type);
  }
  if (rules && ctx?.isStepLast && Array.isArray(rules.lastPlaceExcluded)) {
    for (const type of rules.lastPlaceExcluded) excluded.add(type);
  }

  let pool = excluded.size > 0 ? basePool.filter((type) => !excluded.has(type)) : basePool.slice();
  // Empty-pool guard. An aggressive config must never make a tier unreachable or
  // make the roll return null — fall back to the unfiltered pool.
  //
  // SCOPE: this guard covers the BALANCE filters above it and nothing else.
  // Everything below is deliberately outside it.
  if (pool.length === 0) pool = basePool.slice();

  // ---- HARD GATES (2026-07-26). NEVER restored by the fallback above. -------
  //
  // The fallback is correct for a balance heuristic and WRONG for a
  // compatibility gate: restoring the unfiltered pool would hand a frozen client
  // the exact item the gate exists to keep away from it. If these empty a tier
  // the roll returns null and openMysteryBox cascades (§5.5) — that is the
  // intended outcome, not a bug to paper over with a second fallback.
  //
  // A wholly ABSENT ctx still means "no filtering at all" — the long-standing
  // contract of this module, which every pre-existing caller and the seeded
  // Monte Carlo guard rely on. That is safe because it is not a reachable
  // production state: both roll/disclosure sites build a ctx, and
  // teamOnlyCtxStructuralGuard asserts they always will. Within a ctx that IS
  // supplied, both fields default to FALSE (buildRollContext) — the safe side of
  // a compatibility gate, since an unidentified client is an old one.
  if (ctx) {
    // 1) teamOnlyTypes — droppable only when the race is a team race. Read
    //    default-safe: absent / not-an-array == no restriction.
    const teamOnly = Array.isArray(cfg.teamOnlyTypes) ? cfg.teamOnlyTypes : [];
    if (teamOnly.length > 0 && !ctx.isTeamRace) {
      pool = pool.filter((type) => !teamOnly.includes(type));
    }
    // 2) powerups5 — a pre-wave-5 binary can neither render nor use these, and
    //    usePowerup rejects them with UPDATE_REQUIRED, so rolling one would burn
    //    a slot in a live race. This is the first client gating the in-race roll
    //    has ever had; it was structurally unnecessary only while no wave-5 type
    //    was in any dropPool.
    if (!ctx.supportsPowerups5) {
      pool = pool.filter((type) => !POWERUPS5_GATED_TYPES.includes(type));
    }
  }

  const weights = pool.map(
    (type) => weightForType(type, cfg) * positionMultiplierFor(type, ctx, cfg)
  );
  return { pool, weights };
}

function drawWeighted(pool, weights, rng) {
  if (!pool || pool.length === 0) return null;
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return pool[Math.floor(rng() * pool.length)];
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// Weighted pick within an already-chosen tier.
//
// This replaces an older "roll uniformly, then re-roll RED_CARD 50% of the
// time" hack with a straight weighted draw, which expresses the same intent
// (RED_CARD half as likely as a uniform rare, the freed mass spread over the
// rest of the tier) declaratively and generalises to any future per-type weight.
//
// Position-blind by design — it is the primitive. Callers that know the player's
// position use pickTypeForRarity below.
function pickTypeFromPool(pool, rng, config) {
  if (!pool || pool.length === 0) return null;
  return drawWeighted(pool, pool.map((type) => weightForType(type, config)), rng);
}

// Position-aware pick for a tier. `ctx` absent == no filtering, i.e. exactly the
// pre-2026-07-26 behaviour, which is what keeps every existing caller intact.
function pickTypeForRarity(rarity, rng, config, ctx) {
  const { pool, weights } = eligiblePoolFor(rarity, ctx, config);
  return drawWeighted(pool, weights, rng);
}

// Probability of each individual TYPE for a given race slot: P(tier) times the
// type's weighted share within that tier. Used by the player-facing odds sheet,
// so what a player is shown is derived from the same tables — and now the same
// position filter — the roll uses.
//
// Note what does NOT change here: `rarityOdds[tierIndex]` is spread in full
// across whatever survives the filter, so each tier still contributes exactly
// its own probability and the tier distribution is untouched.
function typeOddsForPosition(position, totalParticipants, config, ctx) {
  const cfg = resolveConfig(config);
  const rarityOdds = rarityOddsForPosition(position, totalParticipants, cfg);
  const out = {};
  RARITY_ORDER.forEach((rarity, tierIndex) => {
    const basePool = Array.isArray(cfg.dropPool?.[rarity]) ? cfg.dropPool[rarity] : [];
    const { pool, weights } = eligiblePoolFor(rarity, ctx, cfg);
    const total = weights.reduce((a, b) => a + b, 0);
    // A filtered-out type is disclosed as an explicit 0 rather than dropped, so
    // a client that presence-checks the key still renders the row honestly.
    basePool.forEach((type) => {
      if (out[type] === undefined) out[type] = 0;
    });
    if (!(total > 0)) return;
    pool.forEach((type, i) => {
      out[type] = (out[type] || 0) + rarityOdds[tierIndex] * (weights[i] / total);
    });
  });
  return out;
}

function rollPowerup(position, totalParticipants, rng = Math.random, options = {}) {
  const config = resolveConfig(options.config);
  const [commonOdds, uncommonOdds] = interpolateOdds(
    normalizePosition(position, totalParticipants),
    config
  );

  const roll = rng();
  let rarity;
  if (roll < commonOdds) {
    rarity = "COMMON";
  } else if (roll < commonOdds + uncommonOdds) {
    rarity = "UNCOMMON";
  } else {
    rarity = "RARE";
  }

  // The tier is chosen BEFORE any position filtering, and the filter only ever
  // reshuffles weights inside it. That ordering is what keeps the `rarity` block
  // of the odds disclosure mathematically identical to before this feature.
  rarity = coerceMinRarity(rarity, options.minRarity);

  const type = pickTypeForRarity(rarity, rng, config, options.ctx);
  return { type, rarity };
}

module.exports = {
  rollPowerup,
  interpolateOdds,
  rarityOddsForPosition,
  typeOddsForPosition,
  pickTypeFromPool,
  pickTypeForRarity,
  eligiblePoolFor,
  positionMultiplierFor,
  buildRollContext,
  normalizePosition,
  coerceMinRarity,
  RARITY_ORDER,
  // Legacy named exports, kept so existing callers and tests keep working. They
  // are live VIEWS onto the active config, not tables — reading one is exactly
  // equivalent to reading getConfigSync().
  get RARITY_TIERS() {
    return balanceConfig.getConfigSync().dropPool;
  },
  get ODDS_TABLE() {
    return balanceConfig.getConfigSync().positionOdds;
  },
};
