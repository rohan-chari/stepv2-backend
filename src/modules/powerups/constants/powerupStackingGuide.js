// Versioned, code-owned presentation of the mechanics enforced by
// usePowerup/effectMultiplier. This table is deliberately not admin-editable:
// a mechanics change and its guide update must land in the same code review.
const STACKING_VERSION = 2;

const SAME_POWERUP_RULES = new Set([
  "NOT_APPLICABLE", "BLOCKED", "EXTENDS", "ALLOWED", "LIMITED",
]);
const OTHER_EFFECT_RULES = new Set([
  "NOT_APPLICABLE", "ALLOWED", "CONDITIONAL", "CONFLICTS",
]);

function rule(samePowerup, otherEffects, summary) {
  return Object.freeze({ samePowerup, otherEffects, summary });
}

const instant = (summary) => rule("NOT_APPLICABLE", "NOT_APPLICABLE", summary);
const blockedBuff = (name) => rule(
  "BLOCKED",
  "CONDITIONAL",
  `Only one ${name} can be active. Different boosts add; freeze overrides, Rainstorm reduces, a losing Coin Flip subtracts, and Wrong Turn negates the final rate.`,
);

const POWERUP_STACKING_GUIDE = Object.freeze({
  LEG_CRAMP: rule("BLOCKED", "CONFLICTS", "Only one Leg Cramp can affect a racer. It cannot coexist with Wrong Turn; Quicksand also rejects a cramped target. Freeze overrides step multipliers."),
  RED_CARD: instant("Red Card resolves immediately, so active stacking does not apply."),
  SHORTCUT: instant("Shortcut transfers steps immediately, so active stacking does not apply."),
  COMPRESSION_SOCKS: rule("BLOCKED", "CONDITIONAL", "Only one shield can be active. Defense resolves Mirror, then Decoy, then Compression Socks; the shield blocks one eligible attack and is consumed."),
  PROTEIN_SHAKE: instant("Protein Shake grants steps immediately, so active stacking does not apply."),
  RUNNERS_HIGH: blockedBuff("Runner's High"),
  SECOND_WIND: instant("Second Wind grants its catch-up bonus immediately, so active stacking does not apply."),
  STEALTH_MODE: rule("BLOCKED", "ALLOWED", "Only one Stealth Mode can be active. It can coexist with scoring and defensive effects because it changes presentation privacy, not score."),
  WRONG_TURN: rule("BLOCKED", "CONFLICTS", "Only one Wrong Turn can affect a racer. It cannot coexist with Leg Cramp; when not frozen it negates the final effective step rate."),
  FANNY_PACK: rule("BLOCKED", "ALLOWED", "Only one Fanny Pack slot expansion can be active. It does not change scoring effects."),
  TRAIL_MIX: instant("Trail Mix grants its bonus immediately from unique powerup use history, so active stacking does not apply."),
  DETOUR_SIGN: rule("BLOCKED", "ALLOWED", "Only one Detour Sign can affect a racer. It hides standings presentation and does not alter scoring effects."),
  LUCKY_HORSESHOE: rule("BLOCKED", "ALLOWED", "Only one Lucky Horseshoe guarantee can wait for the next box. Other active effects do not change that guarantee."),
  CAMPFIRE_REST: rule("BLOCKED", "CONDITIONAL", "Only one Campfire Rest can be active. Its rest window freezes progress, so freeze overrides boosts, Rainstorm, Coin Flip, and Wrong Turn during that window."),
  TRAIL_MAGNET: rule("BLOCKED", "ALLOWED", "Only one Trail Magnet can wait for the next mystery box. It changes box distance, not step scoring."),
  POCKET_WATCH: rule("NOT_APPLICABLE", "CONDITIONAL", "Pocket Watch resolves immediately by extending eligible active timed buffs. It cannot extend excluded, expired, opponent, or non-timed effects."),
  TRAIL_MINE: rule("LIMITED", "ALLOWED", "Each mine is a separate trap from a separate item. Mines can coexist with other effects and resolve independently when crossed."),
  PINECONE_TOSS: instant("Pinecone Toss removes steps immediately, so active stacking does not apply."),
  SNEAKY_SWAP: instant("Pickpocket transfers an inventory item immediately, so active stacking does not apply."),
  MIRROR: rule("BLOCKED", "CONDITIONAL", "Only one Mirror can be active. Defense resolves Mirror before Decoy and Compression Socks; the next eligible attack reflects and consumes it."),
  CLEANSE: rule("NOT_APPLICABLE", "CONDITIONAL", "Cleanse resolves immediately and clears eligible opponent-applied debuffs. Signal Jammer prevents its use; self effects and excluded effects remain."),
  IMPOSTER: rule("BLOCKED", "NOT_APPLICABLE", "Imposter is retired. Historical effects do not accept another active copy."),
  RAINSTORM: rule("LIMITED", "CONDITIONAL", "One storm per caster may be active. Storms from different casters can overlap, but each victim's penalty clamps at one 0.5x; Umbrella and Compression Socks can prevent it."),
  SIGNAL_JAMMER: rule("BLOCKED", "CONDITIONAL", "Only one Signal Jammer can affect a racer. It can coexist with Power Outage and prevents powerup use, including Cleanse and Quick Rinse."),
  LEECH: rule("BLOCKED", "CONDITIONAL", "Only one live Leech may target a racer, regardless of attacker. A later attacker must wait for it to expire or be cleared."),
  DEFENSE_SCAN: instant("X-Ray reveals a defense snapshot immediately, so active stacking does not apply."),
  HITCHHIKE: rule("LIMITED", "CONDITIONAL", "One active link is allowed per caster and one per target. It copies only the target effective-step behavior supported by the current scorer."),
  QUICK_RINSE: rule("NOT_APPLICABLE", "CONDITIONAL", "Quick Rinse resolves immediately, has a once-per-hour race cooldown, and halves remaining time only on eligible opponent effects. Signal Jammer prevents its use."),
  QUICKSAND: rule("BLOCKED", "CONFLICTS", "Quicksand rejects a target already affected by Quicksand or Leg Cramp. Direct Leg Cramp currently may overlap an existing Quicksand; freeze still applies once."),
  UPRISING: rule("EXTENDS", "CONDITIONAL", "Repeated casts merge each eligible beneficiary window to the later expiry and do not add another multiplier row. Freeze, Rainstorm, Coin Flip, and Wrong Turn precedence still applies."),
  GHOST_PEPPER: blockedBuff("Ghost Pepper"),
  COIN_FLIP: rule("ALLOWED", "CONDITIONAL", "Repeated wins add (2x + 2x = 4x). Losses clamp at M-0.5, and a mixed win/loss is also M-0.5; freeze and Wrong Turn take precedence."),
  MYSTERY_POTION: instant("Mystery Potion resolves into its rolled mechanic immediately; stacking follows the rolled powerup's own rule."),
  DECOY: rule("BLOCKED", "CONDITIONAL", "Only one Decoy can be active. Defense resolves Mirror before Decoy, then Compression Socks; the next eligible targeted attack redirects or is absorbed."),
  POWER_OUTAGE: rule("LIMITED", "CONDITIONAL", "Repeated casts are accepted and consumed while already-outaged recipients are skipped. It can coexist with Signal Jammer; Umbrella and Compression Socks can prevent it."),
  UMBRELLA: rule("BLOCKED", "CONDITIONAL", "Duplicate Umbrellas add no benefit. Umbrella separately blocks eligible area attacks such as Rainstorm and Power Outage, but not targeted attacks."),
  RALLY_FLAG: rule("EXTENDS", "CONDITIONAL", "Repeated casts merge each teammate window to the later expiry and do not add another multiplier row. Freeze, Rainstorm, Coin Flip, and Wrong Turn precedence still applies."),
  DRILL_SERGEANT: rule("LIMITED", "CONDITIONAL", "Each eligible dare has its own target and deadline. Its eventual penalty is a separate impact and defenses are resolved when the dare is cast."),
  PIGGY_BANK: rule("BLOCKED", "ALLOWED", "Only one Piggy Bank can be active. It tracks its own coin window and can coexist with step-scoring effects."),
  BOUNTY: rule("LIMITED", "ALLOWED", "A bounty is a race-end objective tied to its target. It can coexist with scoring effects and does not itself change step rate."),
});

function validatePowerupStackingGuide(types) {
  const expected = new Set(types || []);
  const actual = new Set(Object.keys(POWERUP_STACKING_GUIDE));
  if (expected.size !== actual.size || [...expected].some((type) => !actual.has(type))) {
    throw new Error("POWERUP_STACKING_GUIDE must contain exactly one row per copy type");
  }
  for (const [type, entry] of Object.entries(POWERUP_STACKING_GUIDE)) {
    if (!SAME_POWERUP_RULES.has(entry.samePowerup)) throw new Error(`${type} has invalid samePowerup`);
    if (!OTHER_EFFECT_RULES.has(entry.otherEffects)) throw new Error(`${type} has invalid otherEffects`);
    if (typeof entry.summary !== "string" || entry.summary.trim() === "" || [...entry.summary].length > 240) {
      throw new Error(`${type} has invalid stacking summary`);
    }
  }
  return true;
}

module.exports = {
  STACKING_VERSION,
  SAME_POWERUP_RULES,
  OTHER_EFFECT_RULES,
  POWERUP_STACKING_GUIDE,
  validatePowerupStackingGuide,
};
