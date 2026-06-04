// Box-progress effective steps.
//
// Box/powerup progress is IMMUNE to the two opponent debuffs that reduce a
// player's step total — Leg Cramp (frozen steps) and Wrong Turn (reversed
// steps) — so being attacked never stalls your mystery-box earning. The race
// LEADERBOARD total still subtracts those debuffs (standings stay debuff-
// sensitive); only the box gate + countdown ignore them.
//
// We start from the already-computed leaderboard `total` (which has
// `- frozenSteps` and `- 2*reversedSteps` baked in) and ADD BACK exactly the
// Leg-Cramp portion of the freeze and the Wrong-Turn reversal:
//
//   boxEffective = total + legCrampFrozenSteps + 2*reversedSteps + bonusProtection
//
// Campfire Rest's self-imposed freeze is intentionally NOT added back (it is a
// self-buff, not an opponent debuff), so it still counts. Bonus-steal pushbacks
// (Banana Peel/Red Card/Shortcut/Pinecone/Trail Mine) remain protected via the
// maxBonusSteps high-water, exactly as before.
//
// Note (minor, documented): for the rare overlap of Leg Cramp/Wrong Turn with
// Runner's High, only the raw frozen/reversed steps are restored at 1x — the
// stripped buff multiplier on those overlapping steps is not re-applied. The
// primary intent (the debuff never freezes box progress) holds.
function computeBoxEffectiveSteps({
  total = 0,
  legCrampFrozenSteps = 0,
  reversedSteps = 0,
  bonusSteps = 0,
  maxBonusSteps = 0,
} = {}) {
  const bonusProtection = Math.max(0, (maxBonusSteps || 0) - (bonusSteps || 0));
  return Math.max(
    0,
    (total || 0) +
      (legCrampFrozenSteps || 0) +
      2 * (reversedSteps || 0) +
      bonusProtection
  );
}

module.exports = { computeBoxEffectiveSteps };
