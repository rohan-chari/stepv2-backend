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
//   boxEffective = baseAdjusted + max(bonusSteps, maxBonusSteps)
//
// baseAdjusted = the player's actual walked steps for the race window (from
// samples/daily totals, before any powerup effect). The bonus high-water
// (max(bonus, maxBonus)) keeps additive powerup bonuses (Protein Shake / Trail
// Mix) counting toward boxes while protecting against bonus-steal pushbacks
// (Banana Peel/Red Card/Shortcut/Pinecone/Trail Mine). Because baseAdjusted only
// grows as you walk and the bonus high-water never decreases, box progress is
// effectively monotonic and next_box can never be stranded by an expiring effect.
function computeBoxEffectiveSteps({
  baseAdjusted = 0,
  bonusSteps = 0,
  maxBonusSteps = 0,
} = {}) {
  return Math.max(
    0,
    (baseAdjusted || 0) + Math.max(bonusSteps || 0, maxBonusSteps || 0)
  );
}

module.exports = { computeBoxEffectiveSteps };
