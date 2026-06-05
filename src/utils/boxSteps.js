// Box-progress effective steps.
//
// Box/powerup progress tracks RAW WALKED STEPS only. It is immune to EVERY timed
// step multiplier — both opponent debuffs (Leg Cramp freeze, Wrong Turn reversal)
// AND self/temporary buffs (Runner's High, Campfire Rest boost, 2x global step
// events). Those multipliers inflate/deflate the LEADERBOARD total, but they must
// never move box progress: a buff that temporarily doubles your steps would
// otherwise ratchet next_box_at_steps up, then strand it above your real progress
// the moment the buff expires (and a debuff would stall earning). The leaderboard
// total stays fully effect-sensitive; only the box gate + "steps to next box"
// countdown use this raw value.
//
//   boxEffective = max(0, baseAdjusted)
//
// baseAdjusted = the player's actual walked steps for the race window (from
// samples/daily totals, before any powerup effect). Additive consumable bonuses
// (Protein Shake / Trail Mix / Second Wind) are EXCLUDED — they help the
// leaderboard total but must never bring a player closer to the next box. bonusSteps
// and maxBonusSteps are accepted for signature compatibility but ignored. Because
// baseAdjusted only grows as you walk, box progress is monotonic and next_box can
// never be stranded by an expiring effect or a bonus-steal pushback.
function computeBoxEffectiveSteps({
  baseAdjusted = 0,
  bonusSteps = 0,
  maxBonusSteps = 0,
} = {}) {
  return Math.max(0, baseAdjusted || 0);
}

module.exports = { computeBoxEffectiveSteps };
