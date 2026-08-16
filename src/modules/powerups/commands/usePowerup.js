const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const { User } = require("../../users");
const { PowerupUpgradeEvent } = require("../models/powerupUpgradeEvent");
const { eventBus } = require("../../../shared/events/eventBus");
const { prisma: defaultPrisma } = require("../../../db");
const { balanceConfig } = require("../../economy/balanceConfig");
const { POWERUP_NAMES } = require("./rollPowerup");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../../races/services/raceProgressSnapshot");
const {
  computeRaceState: defaultComputeRaceState,
  overlayComputedTotals,
} = require("../../races/services/computeRaceState");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../../races/services/raceStateResolution");
const {
  repairRacePowerupInventory: defaultRepairRacePowerupInventory,
} = require("../../races/services/racePowerupInventoryRepair");
const {
  isUpgradeable,
  isValidLevel,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
  formatDuration,
} = require("../powerupUpgrades");
const {
  deductCoinsAtomic: defaultDeductCoinsAtomic,
  InsufficientCoinsError,
} = require("../../../shared/economy/deductCoinsAtomic");
const {
  imposterEnabled: defaultImposterEnabled,
} = require("../constants/powerupGating");
const {
  isDrillSergeantQuietHours,
} = require("../constants/quietHours");
const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");
const {
  DEFAULT_CONFIG: BALANCE_DEFAULT_CONFIG,
} = require("../../economy/balanceConfig.defaults");
const {
  signedMultiplierForEffects,
} = require("../../races/services/effectiveStepScoring");
const {
  evaluateHighMultiplierAlert,
} = require("../../races/services/highMultiplierAlert");
// The SAME team-total summation the board (getRaceProgress -> teams block) uses,
// so Uprising's losing-team gate can never disagree with the standings the
// player is looking at (2026-07-25 §3).
const {
  buildTeamsBlockFromParticipants,
} = require("../../races/teamRaces");

// SIGNAL_JAMMER is a single-target attack (store-only): it is OFFENSIVE +
// TARGETED so the shared targeting validation, finished-target rejection, and
// the COMPRESSION_SOCKS-block pre-check apply to it exactly like LEG_CRAMP. It
// is, however, listed in SHOP_POWERUP_TYPES below, which EXCLUDES it from the
// MIRROR-reflect pre-check — a shop-bought attack can be blocked by socks but
// never reflected. Its own effect case just parks a 1h "can't use powerups"
// debuff on the target; the enforcement lives in the jam guard below.
// LEECH is a store-bought TARGETED debuff. It rides the OFFENSIVE_TYPES path
// for target resolution, enemy-only (team) validation, and the Compression
// Socks block, and is listed in SHOP_POWERUP_TYPES so a Mirror NEVER reflects
// it (parity with SIGNAL_JAMMER). Its effect is leecher-driven and scored in
// getRaceProgress (each of the leecher's in-window steps removes one from the
// victim, capped); the switch case here just parks the effect for the
// capability-versioned window (§7.5).
// HITCHHIKE (§7) is a store-bought TARGETED link. It gets its Socks-blocks /
// Mirror-never-reflects behavior purely by LIST MEMBERSHIP — OFFENSIVE_TYPES for
// target resolution + enemy-only validation + the Compression Socks block,
// SHOP_POWERUP_TYPES to skip the Mirror reflect pre-check, TARGETED_TYPES for the
// shared targeting validation. There is deliberately NO hard-coded branch in the
// style of the IMPOSTER one further down. Its effect is target-driven and scored
// in src/utils/hitchhikeCopies.js (the caster COPIES the target's raw in-window
// steps 1:1; the target loses nothing); the switch case here just parks the
// 60-minute link.
const OFFENSIVE_TYPES = ["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "PINECONE_TOSS", "SNEAKY_SWAP", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE", "DRILL_SERGEANT"];
// The three coin-shop-only powerups (they exist ONLY via the powerup shop:
// IMPOSTER, RAINSTORM, SIGNAL_JAMMER). Product rule: none of them can EVER be
// reflected by a Mirror, but ALL of them can be blocked by Compression Socks.
// So they are excluded from the Mirror pre-check (single-target) and from the
// per-victim Mirror branch (Rainstorm AoE), while the Socks block still applies:
//   * SIGNAL_JAMMER stays in OFFENSIVE_TYPES → gets the single-target Socks block.
//   * IMPOSTER gets a dedicated Socks block near its targeting validation.
//   * RAINSTORM keeps its per-victim Socks branch (Mirror branch removed).
const SHOP_POWERUP_TYPES = ["IMPOSTER", "RAINSTORM", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE"];
// IMPOSTER is TARGETED (it needs a rival to swap leaderboard display with) but
// it is deliberately NOT in OFFENSIVE_TYPES: it never touches the target's
// participant/steps and applies onSelf (target stored in metadata). As a shop
// powerup it can NEVER be reflected by a Mirror, but Compression Socks DOES
// block it (a dedicated block near its targeting validation), so it is not
// subject to the generic OFFENSIVE_TYPES Mirror pre-check.
const TARGETED_TYPES = ["LEG_CRAMP", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "SNEAKY_SWAP", "IMPOSTER", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE", "DRILL_SERGEANT", "BOUNTY"];
// Powerups Wave 5 (§4.1). All 11 are store-only and gated behind `powerups5`.
const POWERUPS5_TYPES = [
  "UPRISING", "GHOST_PEPPER", "COIN_FLIP", "MYSTERY_POTION", "DECOY",
  "POWER_OUTAGE", "UMBRELLA", "RALLY_FLAG", "DRILL_SERGEANT", "PIGGY_BANK", "BOUNTY",
];
// Types Sneaky Swap can never steal: another Sneaky Swap (no steal chains),
// unopened Mystery Boxes, and every wave-5 store purchase (owner decision D6 —
// expensive buys can't be sniped). Mirrors the isStealable helper in routes/races.js.
const UNSTEALABLE_TYPES = ["SNEAKY_SWAP", "MYSTERY_BOX", ...POWERUPS5_TYPES];
// AoE attacks (Rainstorm, Power Outage, Quicksand) are NOT redirected by a
// Decoy — they resolve per-victim, so a Decoy holder caught in one is hit
// normally and the Decoy is neither consumed nor triggered. That is deliberate;
// the intended counters to an AoE are Umbrella (immune) and Compression Socks
// (blocks).
//
// COMMENT CORRECTED, no behavior change (batch 2026-08-09 item 4 — an
// investigation-only item). This constant is DEAD CODE: the live Decoy gate
// tests bare `OFFENSIVE_TYPES`, so IMPOSTER is NOT actually Decoy-redirectable
// despite what this line has claimed since it was written. The comment used to
// assert the opposite and was the only documentation of the rule, so it was
// actively misleading. Making IMPOSTER genuinely redirectable is a separate
// product decision; until someone takes it, this constant describes an intent
// that was never wired up and must not be read as describing live behavior.
const DECOY_REDIRECTABLE_TYPES = [...OFFENSIVE_TYPES, "IMPOSTER"];
// Wave-5 durations.
// §3.4 duration standardization: non-upgradeable action windows standardize to
// 1h base (was 2h). POWER_OUTAGE (30m) and GHOST_PEPPER (30m+30m) are explicit
// owner exceptions and keep their durations.
const UPRISING_DURATION_MS = 1 * 60 * 60 * 1000;
const UPRISING_MULTIPLIER = 2;
const GHOST_PEPPER_BOOST_MS = 30 * 60 * 1000;
const GHOST_PEPPER_FREEZE_MS = 30 * 60 * 1000;
const GHOST_PEPPER_MULTIPLIER = 3;
const COIN_FLIP_DURATION_MS = 60 * 60 * 1000;
const DECOY_DURATION_MS = 24 * 60 * 60 * 1000;
const POWER_OUTAGE_DURATION_MS = 30 * 60 * 1000;
const UMBRELLA_DURATION_MS = 12 * 60 * 60 * 1000;
const RALLY_FLAG_DURATION_MS = 60 * 60 * 1000;
const RALLY_FLAG_MULTIPLIER = 1.25;
const DRILL_SERGEANT_DURATION_MS = 1 * 60 * 60 * 1000;
const DRILL_SERGEANT_GOAL_STEPS = 3000;
const DRILL_SERGEANT_PENALTY_STEPS = 1500;
const PIGGY_BANK_DURATION_MS = 24 * 60 * 60 * 1000;

// Env-tunable coin-faucet knobs (§3.10 / §3.11). Frozen into effect metadata at
// use-time so a mid-flight env change never alters a live piggy/bounty. Read via
// a positive-int guard so a malformed override falls back to the default rather
// than silently disabling the cap/payout.
function positiveIntEnv(raw, fallback) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
const PIGGY_BANK_STEPS_PER_COIN = positiveIntEnv(process.env.PIGGY_BANK_STEPS_PER_COIN, 300) || 300;
const PIGGY_BANK_COIN_CAP = positiveIntEnv(process.env.PIGGY_BANK_COIN_CAP, 80);
const BOUNTY_PAYOUT_COINS = positiveIntEnv(process.env.BOUNTY_PAYOUT_COINS, 150);
const IMPOSTER_DURATION_MS = 60 * 60 * 1000;
// RAINSTORM is purchase-only and UNTARGETED AoE: it debuffs every OTHER active
// participant (never the caster) at once, so it is NOT in OFFENSIVE_TYPES /
// TARGETED_TYPES (those drive the single-target Mirror/Socks pre-checks) —
// per-victim Compression Socks resolution happens inside its own case below. As
// a shop powerup it can never be reflected by a Mirror (SHOP_POWERUP_TYPES).
const RAINSTORM_DURATION_MS = 60 * 60 * 1000;
const RAINSTORM_MULTIPLIER = 0.5;
// SIGNAL_JAMMER is store-only and non-upgradeable, so its jam lasts a fixed 1h.
const SIGNAL_JAMMER_DURATION_MS = 60 * 60 * 1000;
// LEECH is store-only and non-upgradeable. Scoring
// is a 2:1 UNCAPPED transfer (§5) — every 2 steps the leecher walks in the window
// mints 1 step drained from the victim and credited to the leecher, bounded only
// by the victim's available balance. There is NO per-use cap. The conversion
// ratio is echoed into the effect metadata (`{ ratio, scoringVersion }`) and the
// scorer (getRaceProgress) reads `ratio`, defaulting absent metadata to 2 — so a
// future ratio change is data-only. A victim can be leeched by at most
// LEECH_MAX_PER_VICTIM sources at once (gang-stall guard).
//
// DURATION IS CAPABILITY-VERSIONED (§7.5). The window is chosen from the
// REQUEST's client features, never from the user's stored sticky union:
//   * no `powerups3` (every frozen binary in the wild) => 30 min, exactly the
//     duration that binary's own bundled copy describes.
//   * `powerups3` => 60 min, matching Hitchhike. With the in-progress hour bucket
//     excluded for monotonicity a 30-minute window usually closes before any
//     bucket it depends on does, so a buyer sees zero effect for the powerup's
//     whole life. In-flight rows are unaffected: they already carry a concrete
//     expiresAt.
const LEGACY_LEECH_DURATION_MS = 30 * 60 * 1000;
const LEECH_DURATION_MS = 60 * 60 * 1000;
const LEECH_RATIO = 2;
const LEECH_SCORING_VERSION = 2;
const LEECH_MAX_PER_VICTIM = 2;
// HITCHHIKE (§7.1): store-only, non-upgradeable, fixed 60-minute window. The
// caster COPIES the target's recorded raw steps at `copyRatio` (1:1) — the target
// loses nothing. Metadata carries `{ copyRatio, scoringVersion }` and the scorer
// reads copyRatio (defaulting to 1), so a rebalance is data-only. At most ONE
// active link per caster AND one per target (§7.2): unlike Leech, Hitchhike is not
// zero-sum, so concurrent links would compound.
const HITCHHIKE_DURATION_MS = 60 * 60 * 1000;
const HITCHHIKE_COPY_RATIO = 1;
const HITCHHIKE_LEGACY_SCORING_VERSION = 1;
const HITCHHIKE_EFFECTIVE_SCORING_VERSION = 2;
const HITCHHIKE_MAX_PER_TARGET = 1;
// QUICK_RINSE (§8): store-only, SELF-ONLY, instantaneous. Halves the REMAINING
// duration of every active timed opponent-inflicted effect on the user. Never
// touches self-buffs or untimed effects, and never expires a row outright — the
// halved expiresAt is always > now, so nothing already scored is clawed back.
const QUICK_RINSE_REDUCTION_FRACTION = 0.5;
// Effect types the TARGETED Pocket Watch mode may extend (§6.1). Deliberately a
// separate allowlist rather than a change to isPocketWatchExtendable, so the
// legacy self-buff path stays bit-identical. HITCHHIKE is excluded on purpose.
const POCKET_WATCH_TARGETABLE_TYPES = [
  "LEG_CRAMP",
  "WRONG_TURN",
  "DETOUR_SIGN",
  "SIGNAL_JAMMER",
  "LEECH",
  "RAINSTORM",
];
const SELF_ONLY_TYPES = [
  "QUICK_RINSE",
  "COMPRESSION_SOCKS",
  "MIRROR",
  "CLEANSE",
  "PROTEIN_SHAKE",
  "RUNNERS_HIGH",
  "SECOND_WIND",
  "STEALTH_MODE",
  "FANNY_PACK",
  "TRAIL_MIX",
  "LUCKY_HORSESHOE",
  "CAMPFIRE_REST",
  "TRAIL_MAGNET",
  "POCKET_WATCH",
  "TRAIL_MINE",
  // Wave 5 self-activated types (no target picker).
  "GHOST_PEPPER",
  "COIN_FLIP",
  "MYSTERY_POTION",
  "DECOY",
  "UMBRELLA",
  "PIGGY_BANK",
];

const FANNY_PACK_DURATION_MS = 24 * 60 * 60 * 1000;
// Mirror is a held buff modeled on Compression Socks: same activation style,
// same SELF_ONLY behavior, and the SAME active-shield duration as the base
// Compression Socks shield (24h). Mirror is non-upgradeable, so we use a fixed
// constant rather than the upgrade duration ladder.
const MIRROR_DURATION_MS = 24 * 60 * 60 * 1000;
const CAMPFIRE_FREEZE_MS = 30 * 60 * 1000;
const CAMPFIRE_BOOST_MS = 60 * 60 * 1000;

// Pocket Watch extends only the user's own active timed buffs — not debuffs
// (LEG_CRAMP, WRONG_TURN, DETOUR_SIGN) inflicted by opponents, and never
// itself. Self-applied effects have sourceUserId === targetUserId; in
// production both fields are always populated on raceActiveEffect rows.
function isPocketWatchExtendable(effect) {
  if (!effect.expiresAt) return false;
  if (effect.type === "POCKET_WATCH") return false;
  // §3.3 favorable-tail filter (shared by the VALIDATION pre-check AND the
  // APPLICATION loop, so they can never disagree — validation passing on a
  // pepper-only state while application extends nothing would waste the watch):
  // legacy Pocket Watch extends only effects whose REMAINING tail helps the
  // caster. Excluded self-harms:
  //   * GHOST_PEPPER — the tail is a burnout FREEZE, so extending expiresAt just
  //     lengthens the freeze (empirically proven — see the regression test).
  //   * COIN_FLIP losing rows — a self ×0.5 debuff (same footgun family).
  // Winning Coin Flips stay extendable, and CAMPFIRE_REST (freeze-then-boost)
  // stays extendable because extending its expiresAt lengthens the BOOST.
  if (effect.type === "GHOST_PEPPER") return false;
  if (effect.type === "COIN_FLIP") {
    const m = Number((effect.metadata || {}).multiplier);
    if (Number.isFinite(m) && m < 1) return false;
  }
  if (effect.sourceUserId && effect.targetUserId) {
    return effect.sourceUserId === effect.targetUserId;
  }
  return true;
}

// REQUEST-SCOPED capability read (§7.5). `clientFeatures` is whatever the route
// stamped on the request (a Set today; an array is tolerated defensively). It is
// NEVER the user's stored `clientFeatures` union — that column is sticky across
// every device the user has ever authed from (requireAuth.js:41-70), so reading
// it would silently upgrade a request made by a frozen binary.
function requestHasFeature(clientFeatures, token) {
  if (!clientFeatures) return false;
  if (typeof clientFeatures.has === "function") return clientFeatures.has(token);
  if (Array.isArray(clientFeatures)) return clientFeatures.includes(token);
  return false;
}

// An effect row is a live timed effect when it is ACTIVE and still has a future
// expiry. Rows whose expiresAt has passed but whose status hasn't been flipped by
// lazy expiry yet are treated as gone.
function isLiveTimedEffect(effect, nowDate) {
  if (!effect) return false;
  if (effect.status && effect.status !== "ACTIVE") return false;
  if (!effect.expiresAt) return false;
  return new Date(effect.expiresAt).getTime() > nowDate.getTime();
}

// Cleanse selector: an effect is "opponent-inflicted" (and therefore eligible
// to be cleared by Cleanse) only when it was applied to THIS user by SOMEONE
// ELSE — i.e. sourceUserId !== targetUserId. Self-buffs have
// sourceUserId === targetUserId and must NEVER be cleared. We require both
// fields to be present and the effect to target this user; if either is
// missing/null (a defensive guard against legacy rows), we treat it as a
// self-buff and leave it alone so we never clear the user's own buffs.
function isOpponentInflicted(effect, userId) {
  if (!effect.sourceUserId || !effect.targetUserId) return false;
  if (effect.targetUserId !== userId) return false;
  return effect.sourceUserId !== effect.targetUserId;
}

// Opponent-APPLIED but NOT a debuff on the target, so it must never be removed
// by Cleanse or Quick Rinse. BOUNTY (§3.11) is a placement wager the caster
// puts on a rival ahead of them: it inflicts nothing, it just records a stake
// settled at race end. Its row nonetheless lives on the TARGET's participant
// with sourceUserId = caster — exactly the shape isOpponentInflicted() reads as
// "a debuff someone else put on me" — so without this exclusion the bountied
// rival could erase the caster's wager with one Cleanse, and a Quick Rinse
// could be burned on it too (expiresAt = race end makes it a live timed
// effect). Anything added here must likewise be harmless to its target.
//
// RALLY_FLAG and UPRISING (batch 2026-08-09 item 7) are the opposite problem
// with the same shape: they are BUFFS, and they were being cleansed. Both write
// ONE ROW PER BENEFICIARY through upsertBuffWindow, all sourced from the
// caster — so on every beneficiary EXCEPT the caster the row reads
// sourceUserId = caster, targetUserId = beneficiary, which is exactly what
// isOpponentInflicted() means by "a debuff someone else put on me". The
// caster's own copy is self-sourced and was always safe, which is why players
// reported this as intermittent: whether your rally buff survived a Cleanse
// depended on whether you were the one who raised the flag.
//
// The frontend already classifies both as boosts (effect_polarity.dart); this
// makes the backend agree. Listing them here fixes CLEANSE and QUICK_RINSE and
// BOTH "nothing to cleanse/rinse" guards in one edit, because all four read the
// single isCleansableDebuff predicate below — which is also why the 400 and the
// 409 both need their own test.
// POWER_OUTAGE (batch 2026-08-15 item 6) joins the list for a third reason: it
// IS a genuine opponent-inflicted debuff, but it is an AoE strategic jam in the
// same family as RALLY_FLAG/UPRISING and the owner decided a single Cleanse
// should not undo a 30-minute blackout. Note the interaction that makes this
// mostly a guard-path change: a victim with a LIVE outage is already blocked by
// the jam guard above (~line 1043) and cannot fire a Cleanse at all, so the
// only state this exclusion actually changes is a lapsed-but-still-ACTIVE row
// that lazy expiry hasn't swept — CLEANSE, unlike QUICK_RINSE, does not test
// liveness. Both are covered by powerups-power-outage-not-cleansable.test.js.
const NON_CLEANSABLE_TYPES = ["BOUNTY", "RALLY_FLAG", "UPRISING", "POWER_OUTAGE"];

function isCleansableDebuff(effect, userId) {
  if (NON_CLEANSABLE_TYPES.includes(effect.type)) return false;
  return isOpponentInflicted(effect, userId);
}

// Red Card removes 10% of the leader's steps (restored from the 5% nerf — owner
// decision 2026-07-24). Server-side effect, so old clients apply the new value
// too. Drop odds (balanceConfig RED_CARD) are intentionally left unchanged.
const RED_CARD_PERCENT = 0.10;
const SECOND_WIND_MIN = 500;
const SECOND_WIND_MAX = 5000;
const SECOND_WIND_FACTOR = 0.25;

class PowerupUseError extends Error {
  constructor(message, statusCode, code, options) {
    super(message);
    this.name = "PowerupUseError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (INVALID_TARGET). Additive.
    if (code) this.code = code;
    // Item 12 scope: when true, a rejected REDEEMED powerup is NOT refunded to
    // the general inventory — it stays HELD in the race. Used for TRANSIENT
    // "not right now / already-active" guards (a jammed caster, your own storm
    // already active, a target already jammed), where the powerup is still
    // legitimately usable in THIS race once the condition clears. This
    // specifically preserves the owner-confirmed jam design (2026-07-21 B3:
    // jammed players keep their powerup). Genuine "can't be used here"
    // rejections (TARGET_STEALTHED, invalid target, Red-Card-while-leading,
    // capability gates) leave it false, so item 12 hands the item back.
    if (options && options.retainHeld) this.retainHeld = true;
  }
}

function levelPrefix(upgradeLevel) {
  return upgradeLevel > 0 ? `Lvl ${upgradeLevel} ` : "";
}

// Both delegate to the ONE shared formatter (batch 2026-08-09 item 1). They
// used to divide by an hour and interpolate, which printed "1.25 hours" the
// moment a ladder stopped being whole hours — and the push handler had its own
// third variant that printed "75 minutes" for the same cast. See
// powerupUpgrades.formatDuration.
function hoursText(type, upgradeLevel) {
  return formatDuration(upgradedDuration(type, upgradeLevel));
}

function durationText(durationMs) {
  return formatDuration(durationMs);
}

// TR-902: races are time-based, so nobody finishes mid-race — there is no
// finished/active split left to make. Ranking is purely by steps desc.
function sortedActiveParticipants(participants) {
  return [...participants].sort((a, b) => b.totalSteps - a.totalSteps);
}

function participantRank(participants, participant) {
  return sortedActiveParticipants(participants).findIndex((p) => p.id === participant.id);
}

function adjacentParticipant(participants, participant, direction) {
  const sorted = sortedActiveParticipants(participants);
  const index = sorted.findIndex((p) => p.id === participant.id);
  if (index === -1) return null;
  if (direction === "FRONT") return sorted[index - 1] || null;
  if (direction === "BEHIND") return sorted[index + 1] || null;
  return null;
}

// Lucky Horseshoe rarity floor for the next mystery box.
//
// This used to be a binary cliff — `upgradeLevel >= 3 ? "RARE" : "UNCOMMON"` —
// under which levels 1 and 2 were literal no-ops: a player paid 15 and then 45
// coins and the outcome distribution did not change at all. It is now a
// graduated chance from the balance config: roll against
// `luckyHorseshoe.rareChanceByLevel[level]` and fall back to the UNCOMMON floor
// on a miss. L0 is 0 (never rare) and L3 is 1.0 (always rare), so both ends of
// the old behaviour are preserved exactly.
//
// FORWARD-ONLY: the roll happens at USE time and the result is frozen into the
// effect's metadata (`minRarity`), so Horseshoes already in flight resolve on
// the value they were created with. No migration, no recomputation of any
// existing upgradeLevel.
function luckyMinRarity(upgradeLevel, rng = Math.random, config) {
  const ladder = (config || balanceConfig.getConfigSync()).luckyHorseshoe
    .rareChanceByLevel;
  const level = Math.max(0, Math.min(Math.floor(upgradeLevel || 0), ladder.length - 1));
  const p = ladder[level];
  return rng() < p ? "RARE" : "UNCOMMON";
}

// Weighted roll over a [{ outcome, weight }] pool. Uses the injected `random`
// so tests can pin the outcome deterministically.
function weightedRoll(pool, random) {
  const total = pool.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 0), 0);
  if (total <= 0) return pool[0]?.outcome ?? null;
  let r = random() * total;
  for (const entry of pool) {
    const w = entry.weight > 0 ? entry.weight : 0;
    if (r < w) return entry.outcome;
    r -= w;
  }
  return pool[pool.length - 1].outcome;
}

// Pick a Decoy redirect victim (§3.5 / D3): a uniformly-random alive participant
// excluding the attacker AND the Decoy holder (in team races, also excluding the
// holder's teammates so the redirect never friendly-fires the holder's side).
function pickDecoyRedirectVictim({
  acceptedParticipants,
  isAliveTarget,
  attackerUserId,
  holderParticipant,
  isTeamRace,
  random,
}) {
  const pool = acceptedParticipants.filter((p) => {
    if (!isAliveTarget(p)) return false;
    if (p.userId === attackerUserId) return false;
    if (p.id === holderParticipant.id) return false;
    if (isTeamRace && holderParticipant.team != null && p.team === holderParticipant.team) {
      return false;
    }
    return true;
  });
  if (pool.length === 0) return null;
  return pool[Math.floor(random() * pool.length)];
}

// Mystery Potion (§3.4): roll a weighted outcome and route it through the normal
// apply path for that outcome. Self-contained (returns a full use result). A
// potion may never fail after consumption: any invalid roll (no eligible enemy,
// a stacking rejection) falls back to PROTEIN_SHAKE.
async function applyMysteryPotion(ctx) {
  // `casterStealthed` is threaded in through ctx, NOT closed over: this
  // function is MODULE-scope while the memo it comes from is declared inside
  // buildUsePowerup, so referencing it directly threw a ReferenceError (-> 500)
  // on every enemy potion roll. Code review 2026-08-09.
  const {
    userId, raceId, powerupId, myParticipant, myDisplayName,
    acceptedParticipants, isEnemy, isAliveTarget, effectModel, participantModel,
    eventModel, events, awardCoins, random, now, currentTime, finalize,
    casterStealthed,
  } = ctx;

  const config = (() => {
    try {
      return balanceConfig.getConfigSync ? balanceConfig.getConfigSync() : null;
    } catch {
      return null;
    }
  })();
  const pool =
    (config && config.mysteryPotion && Array.isArray(config.mysteryPotion.pool) && config.mysteryPotion.pool.length > 0
      ? config.mysteryPotion.pool
      : BALANCE_DEFAULT_CONFIG.mysteryPotion.pool);

  let rolled = weightedRoll(pool, random);

  const enemyOutcomes = new Set(["PINECONE_TOSS", "LEG_CRAMP", "SHORTCUT"]);
  const aliveEnemies = acceptedParticipants.filter(
    (p) => p.userId !== userId && isAliveTarget(p) && isEnemy(p)
  );
  // Edge: enemy-targeted roll with no eligible enemy → re-roll into the self-only
  // subset (never an enemy outcome).
  if (enemyOutcomes.has(rolled) && aliveEnemies.length === 0) {
    const selfPool = pool.filter((e) => !enemyOutcomes.has(e.outcome));
    rolled = weightedRoll(selfPool.length ? selfPool : [{ outcome: "PROTEIN_SHAKE", weight: 1 }], random);
  }

  const result = { blocked: false, upgradeLevel: 0, coinsSpent: 0, outcome: "APPLIED" };
  const isTeamRace = myParticipant.team != null && acceptedParticipants.some((p) => p.team != null && p.team !== myParticipant.team);

  const applyProteinFallback = async (reason) => {
    const bonus = 1500;
    await participantModel.addBonusSteps(myParticipant.id, bonus);
    result.rolled = "PROTEIN_SHAKE";
    result.bonus = bonus;
    result.fallbackFrom = reason;
    await eventModel.create({
      raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
      description: `${myDisplayName} drank a Mystery Potion and got a Protein Shake! +${bonus.toLocaleString()} steps.`,
      metadata: { rolled: "PROTEIN_SHAKE" },
    });
  };

  const createOnSelf = async (effectType, metadata) =>
    effectModel.create({
      raceId, targetParticipantId: myParticipant.id, targetUserId: userId,
      sourceUserId: userId, powerupId, type: effectType, startsAt: currentTime,
      expiresAt: metadata.expiresAt, metadata: metadata.meta || {},
    });

  switch (rolled) {
    case "PROTEIN_SHAKE": {
      const bonus = 1500;
      await participantModel.addBonusSteps(myParticipant.id, bonus);
      result.rolled = "PROTEIN_SHAKE"; result.bonus = bonus;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and got a Protein Shake! +${bonus.toLocaleString()} steps.`, metadata: { rolled } });
      break;
    }
    case "RUNNERS_HIGH": {
      const existing = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "RUNNERS_HIGH");
      if (existing) { await applyProteinFallback("RUNNERS_HIGH"); break; }
      const effect = await createOnSelf("RUNNERS_HIGH", { expiresAt: new Date(currentTime.getTime() + 3 * 60 * 60 * 1000), meta: { stepsAtBuffStart: myParticipant.totalSteps } });
      result.rolled = "RUNNERS_HIGH"; result.effect = effect;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and hit a Runner's High! 2x steps for 3 hours.`, metadata: { rolled } });
      break;
    }
    case "COMPRESSION_SOCKS": {
      const existing = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "COMPRESSION_SOCKS");
      if (existing) { await applyProteinFallback("COMPRESSION_SOCKS"); break; }
      const effect = await createOnSelf("COMPRESSION_SOCKS", { expiresAt: new Date(currentTime.getTime() + 24 * 60 * 60 * 1000) });
      result.rolled = "COMPRESSION_SOCKS"; result.effect = effect;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and got Compression Socks! Shielded from the next attack.`, metadata: { rolled } });
      break;
    }
    case "COIN_REFUND": {
      const refundCoins = 80; // 2x the 40-coin price
      await awardCoins({ userId, amount: refundCoins, reason: "mystery_potion_refund", refId: powerupId });
      result.rolled = "COIN_REFUND"; result.coins = refundCoins;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and struck coins! +${refundCoins} coins.`, metadata: { rolled } });
      break;
    }
    case "LEG_CRAMP_SELF": {
      // Item 14 — the self-cramp potion outcome had no stacking check at all.
      // LC×WT mutual exclusion: while reversed, a self-cramp is INVALID →
      // protein fallback (a potion must never cleanse an enemy Wrong Turn).
      {
        const activeWT = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "WRONG_TURN");
        if (activeWT) { await applyProteinFallback("LEG_CRAMP_SELF"); break; }
      }
      await clearActiveLegCramps(effectModel, myParticipant.id);
      // Batch 2026-08-09 item 1: aligned DOWN from 2h to 1h so the Leg Cramp
      // nerf can't be dodged via a potion. Hardcoded rather than read from the
      // ladder because a potion outcome has no upgrade level — 1h is the L0
      // cramp. (The self wrong-turn below was already 1h.)
      const effect = await createOnSelf("LEG_CRAMP", { expiresAt: new Date(currentTime.getTime() + 60 * 60 * 1000), meta: { stepsAtFreezeStart: myParticipant.totalSteps } });
      result.rolled = "LEG_CRAMP_SELF"; result.effect = effect;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and cramped up! Their steps are frozen for 1 hour.`, metadata: { rolled } });
      break;
    }
    case "WRONG_TURN_SELF": {
      // LC×WT mutual exclusion: while frozen, a self-reversal is INVALID →
      // protein fallback (a potion must never cleanse an enemy Leg Cramp).
      {
        const activeCramp = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "LEG_CRAMP");
        if (activeCramp) { await applyProteinFallback("WRONG_TURN_SELF"); break; }
      }
      const effect = await createOnSelf("WRONG_TURN", { expiresAt: new Date(currentTime.getTime() + 60 * 60 * 1000), meta: { stepsAtStart: myParticipant.totalSteps } });
      result.rolled = "WRONG_TURN_SELF"; result.effect = effect;
      await eventModel.create({ raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
        description: `${myDisplayName} drank a Mystery Potion and got turned around! Their steps are reversed for 1 hour.`, metadata: { rolled } });
      break;
    }
    case "PINECONE_TOSS":
    case "LEG_CRAMP":
    case "SHORTCUT": {
      const handled = await applyPotionEnemyAttack({
        casterStealthed,
        rolled, aliveEnemies, acceptedParticipants, isAliveTarget, isTeamRace,
        userId, myParticipant, myDisplayName, effectModel, participantModel,
        eventModel, events, random, now, currentTime, raceId, powerupId, result,
      });
      if (!handled) { await applyProteinFallback(rolled); }
      break;
    }
    default: {
      await applyProteinFallback(rolled || "UNKNOWN");
    }
  }

  await finalize(null);
  return result;
}

// Enemy-targeted Mystery Potion outcome, honoring the victim's defenses in the
// canonical Mirror → Decoy → Socks order (§3.4/§3.5). Returns false when the roll
// is INVALID (stacking rejection / no eligible enemy) so the caller falls back to
// PROTEIN_SHAKE; returns true once the outcome is resolved (applied, blocked,
// reflected, or redirected).
// Item 14 (batch 2026-07-26) — Leg Cramp REPLACES, it never stacks.
//
// The pre-check at the top of usePowerup only validated the ORIGINAL target, so
// a Mirror reflect (and the Decoy-redirect Mirror branch, and the LEG_CRAMP_SELF
// potion outcome) could land a SECOND ACTIVE row on someone already cramped —
// and the scorers sum both rows, so overlapping windows double-froze.
//
// Expire every ACTIVE Leg Cramp on the participant immediately before writing
// the new one, so the caller's create() always leaves exactly one row, running
// for the FULL duration from the moment of application (reset, not union-extend
// and not a second row). QUICKSAND is deliberately untouched: it is the same
// mutually exclusive freeze family and has its own TARGET_ALREADY_FROZEN guard.
async function clearActiveLegCramps(effectModel, targetParticipantId) {
  if (!targetParticipantId) return;
  if (typeof effectModel.findActiveByTypeForParticipants === "function") {
    const rows = await effectModel.findActiveByTypeForParticipants(
      [targetParticipantId],
      "LEG_CRAMP"
    );
    for (const row of rows || []) {
      await effectModel.update(row.id, { status: "EXPIRED" });
    }
    return;
  }
  // Minimal test fakes only expose the single-row lookup; drain it.
  for (let guard = 0; guard < 10; guard++) {
    const row = await effectModel.findActiveByTypeForParticipant(
      targetParticipantId,
      "LEG_CRAMP"
    );
    if (!row) return;
    await effectModel.update(row.id, { status: "EXPIRED" });
  }
}

async function applyPotionEnemyAttack(a) {
  const {
    rolled, aliveEnemies, acceptedParticipants, isAliveTarget, isTeamRace,
    userId, myParticipant, myDisplayName, effectModel, participantModel,
    eventModel, events, random, now, currentTime, raceId, powerupId, result,
  } = a;
  if (aliveEnemies.length === 0) return false;
  let victim = aliveEnemies[Math.floor(random() * aliveEnemies.length)];

  // Validity pre-checks (a stacking rejection is INVALID → fallback).
  if (rolled === "SHORTCUT" && Math.max(0, victim.totalSteps) === 0) return false;
  if (rolled === "LEG_CRAMP") {
    const existing = await effectModel.findActiveByTypeForParticipant(victim.id, "LEG_CRAMP");
    if (existing) return false;
    // LC×WT mutual exclusion: a wrong-turned victim can't be cramped either —
    // treat like the stacking rejection (INVALID → protein fallback).
    const existingWT = await effectModel.findActiveByTypeForParticipant(victim.id, "WRONG_TURN");
    if (existingWT) return false;
  }

  let targetParticipant = victim;
  let sourceUserId = userId;
  let sourceName = myDisplayName;

  // Mirror (reflectable: these three are not shop types).
  const mirror = await effectModel.findActiveByTypeForParticipant(victim.id, "MIRROR");
  if (mirror) {
    await effectModel.update(mirror.id, { status: "EXPIRED" });
    targetParticipant = myParticipant; // reflect onto the caster
    sourceUserId = victim.userId;
    sourceName = victim.user?.displayName || "A runner";
    result.reflected = true; result.reflectedBy = "MIRROR";
  } else {
    // Decoy redirect (one hop, no chaining).
    const decoy = await effectModel.findActiveByTypeForParticipant(victim.id, "DECOY");
    if (decoy) {
      await effectModel.update(decoy.id, { status: "EXPIRED" });
      const redirect = pickDecoyRedirectVictim({
        acceptedParticipants, isAliveTarget, attackerUserId: userId,
        holderParticipant: victim, isTeamRace, random,
      });
      if (!redirect) {
        result.rolled = rolled; result.blocked = true; result.blockedBy = "DECOY"; result.outcome = "BLOCKED";
        return true;
      }
      targetParticipant = redirect;
      result.redirected = true; result.redirectedBy = "DECOY"; result.redirectedToUserId = redirect.userId;
      result.outcome = "REDIRECTED";
    }
  }
  // Socks on the final landing target: the (possibly redirected) victim — or,
  // after a Mirror reflect, the CASTER, whose own active socks block the bounce.
  const socks = await effectModel.findActiveByTypeForParticipant(targetParticipant.id, "COMPRESSION_SOCKS");
  if (socks) {
    await effectModel.update(socks.id, { status: "BLOCKED" });
    result.rolled = rolled; result.blocked = true; result.blockedBy = "COMPRESSION_SOCKS";
    result.outcome = result.outcome === "REDIRECTED" ? "REDIRECTED" : "BLOCKED";
    return true;
  }

  const resolvedTargetUserId = targetParticipant.userId;
  const targetName = targetParticipant.user?.displayName || "a runner";
  result.rolled = rolled;

  if (rolled === "PINECONE_TOSS") {
    const penalty = 750;
    await participantModel.subtractBonusSteps(targetParticipant.id, penalty);
    result.penalty = penalty;
    await eventModel.create({ raceId, actorUserId: sourceUserId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
      targetUserId: resolvedTargetUserId,
      description: `${sourceName}'s Mystery Potion tossed a Pinecone at ${targetName}! They lost ${penalty.toLocaleString()} steps.`, metadata: { rolled } });
  } else if (rolled === "SHORTCUT") {
    const stolen = Math.min(1000, Math.max(0, targetParticipant.totalSteps));
    if (stolen > 0) {
      await participantModel.subtractBonusSteps(targetParticipant.id, stolen);
      await participantModel.addBonusSteps(myParticipant.id, stolen);
    }
    result.stolen = stolen;
    await eventModel.create({ raceId, actorUserId: sourceUserId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
      targetUserId: resolvedTargetUserId,
      description: `${sourceName}'s Mystery Potion took a Shortcut, stealing ${stolen.toLocaleString()} steps from ${targetName}!`, metadata: { rolled } });
  } else if (rolled === "LEG_CRAMP") {
    // Item 14 — on reflect the caster may already hold a cramp. This used to
    // silently do nothing (the reflect was swallowed); it now RESETS to the full
    // duration, matching the main Leg Cramp path.
    await clearActiveLegCramps(effectModel, targetParticipant.id);
    // LC×WT mutual exclusion on the POST-shield landing target (a reflect may
    // have swapped it to the caster, whom the pre-check above never saw):
    // cancel a live Wrong Turn with a truncated window, same as the main path.
    {
      const conflictingWT = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "WRONG_TURN"
      );
      if (conflictingWT) {
        await effectModel.update(conflictingWT.id, {
          status: "EXPIRED",
          expiresAt: currentTime,
        });
      }
    }
    {
      const effect = await effectModel.create({
        raceId, targetParticipantId: targetParticipant.id, targetUserId: resolvedTargetUserId,
        sourceUserId, powerupId, type: "LEG_CRAMP", startsAt: currentTime,
        // Batch 2026-08-09 item 1: 2h -> 1h, same reason as the self-cramp
        // above — a potion must not out-freeze a real Leg Cramp.
        expiresAt: new Date(currentTime.getTime() + 60 * 60 * 1000),
        metadata: { stepsAtFreezeStart: targetParticipant.totalSteps },
      });
      result.effect = effect;
    }
    await eventModel.create({ raceId, actorUserId: sourceUserId, eventType: "POWERUP_USED", powerupType: "MYSTERY_POTION",
      targetUserId: resolvedTargetUserId,
      description: `${sourceName}'s Mystery Potion cramped ${targetName}! Their steps are frozen for 1 hour.`, metadata: { rolled } });
  }

  // `casterStealthed` is threaded in from the caller rather than re-read here:
  // this helper lives at module scope and has no myParticipant memo of its own.
  events.emit("POWERUP_USED", { raceId, userId: sourceUserId, powerupType: "MYSTERY_POTION", targetUserId: resolvedTargetUserId, upgradeLevel: 0, stealthed: a.casterStealthed === true });
  return true;
}

// Item 12 (BUG): return a REJECTED redeemed powerup to the general inventory
// instead of stranding it HELD in this race. Called only after usePowerup throws
// a PowerupUseError — which always happens BEFORE the item is marked USED, so
// the row is still HELD here. Refunds only REDEEMED powerups (rarity == null &&
// earnedAtSteps == null, per redeemPowerupToRace.js) — box-earned ones (rarity
// != null) are legitimately race-bound and stay HELD. Atomic + conditional on
// still-HELD so a concurrent consume can never double-refund. Best-effort at the
// call site: a refund failure must never mask the original rejection.
async function refundRedeemedOnRejection({
  db,
  powerupModel,
  userId,
  raceId,
  powerupId,
}) {
  if (typeof db?.$transaction !== "function") return;
  const powerup = await powerupModel.findById(powerupId);
  if (!powerup) return;
  if (powerup.userId !== userId || powerup.raceId !== raceId) return;
  if (powerup.status !== "HELD") return;
  const isRedeemed = powerup.rarity == null && powerup.earnedAtSteps == null;
  if (!isRedeemed) return;

  await db.$transaction(async (tx) => {
    // Only the caller that flips HELD -> DISCARDED performs the hand-back.
    const discarded = await tx.racePowerup.updateMany({
      where: { id: powerupId, status: "HELD" },
      data: { status: "DISCARDED" },
    });
    if (discarded.count !== 1) return;
    await tx.userPowerupItem.upsert({
      where: { userId_powerupType: { userId, powerupType: powerup.type } },
      create: { userId, powerupType: powerup.type, quantity: 1 },
      update: { quantity: { increment: 1 } },
    });
  });

  // C4 (spec §5 Phase E): the discard hand-back returns a redeemed powerup to
  // the GLOBAL inventory, so `v1:user:inventory:{id}` is now wrong. Post-commit
  // and swallowed — a cache DEL must never fail a discard.
  try {
    await require("../services/powerupInventoryCache").invalidateSafe(userId);
  } catch {}
}

function buildUsePowerup(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const userModel = dependencies.User || User;
  const upgradeEventModel = dependencies.PowerupUpgradeEvent || PowerupUpgradeEvent;
  const deductCoinsAtomic = dependencies.deductCoinsAtomic || defaultDeductCoinsAtomic;
  const events = dependencies.eventBus || eventBus;
  // C0 (spec §5a item 4): after a powerup's own small writes, ENQUEUE the race
  // rather than bulk-writing every participant row inline. The race-keyed worker
  // owns that write, and the fence serializes it against settlement.
  //
  // Two resolveRaceState calls survive inline BY DESIGN and are NOT converted:
  // the TRAIL_MINE pre-plant refresh and the Uprising losing-team gate. Both
  // READ freshly-resolved totals to make a decision in the same request, so an
  // async enqueue would decide off stale numbers (a mine planted behind its
  // owner detonates instantly on someone far behind). They are accepted residual
  // writers under §5a item 7 and go through the same ascending-userId write
  // order inside resolveRaceState.
  // Injected-deps callers (unit tests) get a no-op unless they pass one: an
  // enqueue here must never turn a pure unit test into a DB test.
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : hasInjectedDeps
      ? async () => null
      : defaultEnqueueRaceResolution;
  // As elsewhere in C0: an EXPLICITLY injected resolveRaceState still drives the
  // inline path (it is the seam for exercising it, and the path stays live
  // behind the `inlineRaceResolutionFallback` lever). The production singleton
  // injects nothing, so production only enqueues.
  const inlineResolveInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  // Read-only fresh totals for the two branches that need to DECIDE off current
  // steps (Trail Mine's plant position + last-place check, and Uprising's
  // losing-team gate). Both used to call resolveRaceState, which PERSISTS every
  // participant row — a second concurrent bulk writer in the HTTP request path,
  // which is precisely the class C0 exists to eliminate. computeRaceState runs
  // the same scoring pipeline with the writes discarded.
  const computeRaceState = dependencies.computeRaceState || defaultComputeRaceState;
  const resolveRaceState = inlineResolveInjected
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const repairRacePowerupInventory = dependencies.repairRacePowerupInventory ||
    dependencies.syncRacePowerupState ||
    (hasInjectedDeps
      ? async () => {}
      : defaultRepairRacePowerupInventory);
  const now = dependencies.now || (() => new Date());
  const random = dependencies.random || Math.random;
  const awardCoins = dependencies.awardCoins || defaultAwardCoins;
  // Imposter kill switch (Item 3). Injectable for tests; defaults to the env
  // reader (enabled unless IMPOSTER_ENABLED="false").
  const imposterEnabled = dependencies.imposterEnabled || defaultImposterEnabled;
  const usePowerupCore = async function usePowerup({
    userId,
    raceId,
    powerupId,
    targetUserId,
    targetUserIds,
    targetDirection,
    swapOfferedPowerupId,
    swapRequestedPowerupId,
    timeZone,
    upgradeLevel = 0,
    // §6.3 — OPTIONAL. Absent (every frozen client, and every legacy request)
    // means the untouched legacy Pocket Watch behavior.
    targetEffectId = null,
    // §7.5 — OPTIONAL, REQUEST-SCOPED capability tokens. Absent means "assume the
    // oldest contract", which is what a frozen binary's own copy describes.
    clientFeatures = null,
    // Internal observability seam. Never serialized or accepted from HTTP.
    onPerformanceContext = null,
  }) {
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new PowerupUseError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new PowerupUseError("This powerup does not belong to you", 403);
    }
    if (powerup.status !== "HELD") {
      throw new PowerupUseError("This powerup has already been used or discarded", 400);
    }
    onPerformanceContext?.({ powerupType: powerup.type || null });

    // Trail Mine plants at the owner's CURRENT step total, but stored totals go
    // stale between syncs: off a stale total the mine lands BEHIND its owner and
    // detonates instantly on a runner far behind them. So compute fresh totals
    // first — and use them for the last-place rank check too.
    //
    // C0: this is a READ. It used to call resolveRaceState, which persists every
    // participant row and made this request path a second bulk writer racing the
    // fenced worker. computeRaceState runs the identical scoring pipeline
    // (bases -> effects -> hitchhike -> leech -> trail mines) with the writes
    // captured and thrown away, then we overlay the numbers onto the in-memory
    // participant rows below. The trailing enqueueRaceResolution persists them
    // moments later, through the one owner that is allowed to.
    // (No-op for other powerup types.)
    let computedTotals = null;
    let race = null;
    if (powerup.type === "TRAIL_MINE") {
      const computed = await computeRaceState({ raceId, timeZone });
      computedTotals = computed.totalsByParticipantId;
      race = computed.result?.race || null;
    }

    if (!race) {
      race = typeof raceModel.findPowerupUseContext === "function"
        ? await raceModel.findPowerupUseContext(raceId)
        : await raceModel.findById(raceId);
    }
    if (!race || race.status !== "ACTIVE") {
      throw new PowerupUseError("Race is not active", 400);
    }

    // Overlay BEFORE myParticipant/acceptedParticipants are derived, so the
    // plant position and the last-place gate both read the computed values and
    // can never disagree with each other or use a staler snapshot.
    if (computedTotals && Array.isArray(race.participants)) {
      race.participants = overlayComputedTotals(race.participants, computedTotals);
    }

    // §3.7 hard gate: a race whose creator disabled powerups accepts NONE — not
    // earned, not store-redeemed. Rejected BEFORE consumption (the powerup stays
    // HELD; the redeemed-refund path is never reached because nothing is spent).
    if (race.powerupsEnabled === false) {
      throw new PowerupUseError(
        "Powerups are disabled in this race.",
        400,
        "POWERUPS_DISABLED"
      );
    }
    // End-time gate: between a race's endsAt and the raceExpiry cron settling it
    // (flipping status to COMPLETED), status is still ACTIVE. Without this guard
    // an opponent could fire an offensive powerup — and trigger an attack push —
    // on a race that has already ended. endsAt is null for open-ended target
    // races, which are unaffected.
    if (race.endsAt && now() >= new Date(race.endsAt)) {
      throw new PowerupUseError("Race has ended", 400);
    }

    // `let` (not const): on a Mirror reflect these are swapped so the offensive
    // switch below applies the effect to the original attacker instead.
    let myParticipant = race.participants.find((p) => p.userId === userId && p.status === "ACCEPTED");
    if (!myParticipant) {
      throw new PowerupUseError("You are not an active participant", 403);
    }
    // TR-602: a forfeited team-race member can no longer use powerups.
    if (myParticipant.forfeitedAt) {
      throw new PowerupUseError("You have forfeited this race", 400);
    }
    const casterParticipant = myParticipant;

    // Batch 2026-08-09 item 11 — is the CASTER stealthed?
    //
    // The caster's own stealth state was NOT loaded anywhere before the
    // POWERUP_USED emit (the existing read at the top of the targeting block is
    // the TARGET's stealth, and the caster's effects are only read much later,
    // AFTER the emit). So this is a genuinely new read rather than a value that
    // was lying around.
    //
    // Memoized: several emit sites are per-victim loops (Quicksand, Power
    // Outage), and one indexed lookup per cast is the budget, not one per
    // victim. Best-effort — a lookup failure resolves FALSE (visible name),
    // matching the handler's fail-safe default, because accidentally
    // anonymizing would be a gameplay change while failing to anonymize is the
    // status quo bug that tests catch.
    let casterStealthedMemo;
    const casterStealthed = async () => {
      if (casterStealthedMemo === undefined) {
        try {
          const effect = await effectModel.findActiveByTypeForParticipant?.(
            myParticipant.id,
            "STEALTH_MODE"
          );
          casterStealthedMemo = Boolean(
            effect && (!effect.expiresAt || new Date(effect.expiresAt) > now())
          );
        } catch {
          casterStealthedMemo = false;
        }
      }
      return casterStealthedMemo;
    };

    // Signal Jammer JAM GUARD (the feature's single choke point). If this
    // participant is currently jammed, they cannot USE any powerup — earned,
    // store-redeemed, or upgraded, INCLUDING another Signal Jammer (a jammed
    // player can't jam). This runs BEFORE any targeting/coin/defense/effect
    // logic and before the powerup is marked USED, so nothing is consumed on
    // rejection. Buying and redeeming go through separate commands and are
    // deliberately NOT gated here. A jam whose expiresAt has already passed (but
    // whose row is still ACTIVE because lazy expiry hasn't run) does not block.
    // §3.6: the jam lookup covers BOTH single-target Signal Jammer and the AoE
    // Power Outage — either one prevents the participant from firing a powerup.
    // Two typed lookups (rather than findActiveForParticipant) so injected fakes
    // that only implement findActiveByTypeForParticipant keep working.
    const isLiveJam = (e) => e && e.expiresAt && new Date(e.expiresAt) > now();
    const jammer = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "SIGNAL_JAMMER");
    let activeJam = isLiveJam(jammer) ? jammer : null;
    if (!activeJam) {
      const outage = await effectModel.findActiveByTypeForParticipant(myParticipant.id, "POWER_OUTAGE");
      if (isLiveJam(outage)) activeJam = outage;
    }
    if (activeJam && activeJam.expiresAt && new Date(activeJam.expiresAt) > now()) {
      const remainingMs = new Date(activeJam.expiresAt).getTime() - now().getTime();
      const remainingMin = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
      throw new PowerupUseError(
        `Your powerups are jammed for another ${remainingMin}m!`,
        409,
        undefined,
        { retainHeld: true } // transient jam — keep the powerup for later (item 12 scope)
      );
    }

    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    let myDisplayName = myParticipant.user.displayName || "A runner";
    // The user credited as the *source* of an effect. Same as userId normally;
    // on a Mirror reflect it becomes the original target (who reflects it).
    let actingUserId = userId;
    const type = powerup.type;

    if (type !== "QUICKSAND" && targetUserIds !== undefined) {
      throw new PowerupUseError("targetUserIds is only valid for Quicksand", 400, "INVALID_TARGETS");
    }

    // Imposter is DISABLED for now (Item 3). Reject the use with a friendly
    // message and — crucially — do NOT consume the item (this runs before coin
    // deduction and the mark-USED step, so the powerup stays HELD). Old clients
    // may still render a "use" affordance; this keeps them safe. Re-enabling is a
    // single env flip (IMPOSTER_ENABLED).
    if (type === "IMPOSTER" && !imposterEnabled()) {
      throw new PowerupUseError("Imposter is temporarily unavailable", 400);
    }

    // Wave 5 gate (§4.1): a wave-5 held item used from a client that does not
    // advertise `powerups5` is rejected with UPDATE_REQUIRED. This runs before
    // coin deduction and the mark-USED step, so the item stays HELD. A frozen
    // binary can only reach here if it somehow acquired one of these (it never
    // sees them in the catalog), so this is defense-in-depth.
    if (POWERUPS5_TYPES.includes(type) && !requestHasFeature(clientFeatures, "powerups5")) {
      throw new PowerupUseError(
        `Update required to use ${POWERUP_NAMES[type] || type}`,
        400,
        "UPDATE_REQUIRED"
      );
    }

    // Validate upgrade level (cheap, no DB writes)
    if (!isValidLevel(upgradeLevel)) {
      throw new PowerupUseError(`Invalid upgrade level: ${upgradeLevel}`, 400);
    }
    if (upgradeLevel > 0 && !isUpgradeable(type)) {
      throw new PowerupUseError(`${POWERUP_NAMES[type] || type} is not upgradeable`, 400);
    }
    const costCoins = upgradeLevel > 0 ? upgradeCost(type, upgradeLevel) : 0;

    // Validate targeting
    if (TARGETED_TYPES.includes(type)) {
      if (!targetUserId) {
        throw new PowerupUseError("This powerup requires a target", 400);
      }
      if (targetUserId === userId) {
        throw new PowerupUseError("You cannot target yourself", 400);
      }
    }

    // Self-only powerups reject if a target is provided
    if (SELF_ONLY_TYPES.includes(type) && targetUserId) {
      throw new PowerupUseError("This powerup cannot be used on another player", 400);
    }

    // §3.1 Drill Sergeant sleep blocker: a dare on a target whose LOCAL time is
    // inside their sleep window [22:00, 07:00) is rejected BEFORE consumption and
    // before any coin spend, so the held/redeemed powerup stays usable. Checked
    // against the ORIGINAL target, before any Mirror bounce (a reflected dare lands
    // on the caster, who is awake). Fallback: target tz -> race tz -> ALLOW
    // (fail-open when no timezone is known, owner-confirmed).
    if (type === "DRILL_SERGEANT") {
      const targetUser = await userModel.findById(targetUserId);
      let asleep = isDrillSergeantQuietHours(now(), targetUser && targetUser.timezone);
      if (asleep === null) {
        asleep = isDrillSergeantQuietHours(now(), race.timezone);
      }
      if (asleep === true) {
        throw new PowerupUseError(
          "That rival is likely asleep. Drill Sergeant is blocked from 10PM to 7AM their time.",
          400,
          "TARGET_ASLEEP"
        );
      }
    }

    // Team races (TR-651/652/653/657): offensive/AoE/auto-target powerups only
    // ever hit the ENEMY team, and forfeited members drop out of every pool.
    const isTeamRace = race.isTeamRace === true;
    const isEnemy = (p) =>
      !isTeamRace || (p.team != null && p.team !== myParticipant.team);
    const isAliveTarget = (p) => !p.finishedAt && !p.forfeitedAt;

    // Quicksand is a capability-gated multi-target command. Resolve and
    // validate the complete set before the first write so malformed or stale
    // submissions consume nothing.
    if (type === "QUICKSAND") {
      if (!requestHasFeature(clientFeatures, "powerups4")) {
        throw new PowerupUseError("Update required to use Quicksand", 400, "UPDATE_REQUIRED");
      }
      if (targetUserId !== undefined && targetUserId !== null) {
        throw new PowerupUseError("Quicksand requires targetUserIds", 400, "INVALID_TARGETS");
      }
      if (!Array.isArray(targetUserIds) || targetUserIds.length < 1 || targetUserIds.length > 3 ||
          targetUserIds.some((id) => typeof id !== "string" || id.trim() !== id || !id)) {
        throw new PowerupUseError("Quicksand requires 1 to 3 target user IDs", 400, "INVALID_TARGETS");
      }
      if (new Set(targetUserIds).size !== targetUserIds.length || targetUserIds.includes(userId)) {
        throw new PowerupUseError("Quicksand targets must be distinct rivals", 400, "INVALID_TARGETS");
      }
      const victims = targetUserIds.map((id) => acceptedParticipants.find((p) => p.userId === id));
      if (victims.some((p) => !p || !isAliveTarget(p) || (isTeamRace && !isEnemy(p)))) {
        throw new PowerupUseError("Every Quicksand target must be an active enemy", 400, "INVALID_TARGET");
      }
      for (const victim of victims) {
        const [cramp, quicksand] = await Promise.all([
          effectModel.findActiveByTypeForParticipant(victim.id, "LEG_CRAMP"),
          effectModel.findActiveByTypeForParticipant(victim.id, "QUICKSAND"),
        ]);
        if (cramp || quicksand) {
          throw new PowerupUseError("A selected target is already frozen", 400, "TARGET_ALREADY_FROZEN");
        }
      }

      const currentTime = now();
      // §3.4: Quicksand standardizes to a 1h freeze window (was 2h).
      const expiresAt = new Date(currentTime.getTime() + 1 * 60 * 60 * 1000);
      const targetResults = await db.$transaction(async (tx) => {
        // Serialize Quicksand submissions within a race. This closes both the
        // same-item double-submit race and two items racing to freeze one target.
        await tx.$queryRaw`SELECT id FROM races WHERE id = ${raceId} FOR UPDATE`;
        const lockedRace = await tx.race.findUnique({
          where: { id: raceId },
          include: { participants: true },
        });
        if (!lockedRace || lockedRace.status !== "ACTIVE" ||
            (lockedRace.endsAt && currentTime >= new Date(lockedRace.endsAt))) {
          throw new PowerupUseError("Race has ended", 409, "RACE_ENDED");
        }
        const lockedMe = lockedRace.participants.find((p) => p.userId === userId && p.status === "ACCEPTED");
        // Ascending-userId WRITE order (spec §5a item 7) — Quicksand is a
        // multi-target race_participants-adjacent writer inside one transaction,
        // so it obeys the same global lock order as the resolution worker,
        // forfeitRace's scan, and Rainstorm. The RESPONSE order is restored to
        // the caller's requested order below: `targetResults` is part of the
        // wire contract and reordering it would be an API change.
        const lockedVictims = [...targetUserIds]
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((id) => lockedRace.participants.find((p) => p.userId === id));
        if (!lockedMe || lockedVictims.some((p) => !p || p.status !== "ACCEPTED" || p.finishedAt || p.forfeitedAt ||
            (lockedRace.isTeamRace && (p.team == null || p.team === lockedMe.team)))) {
          throw new PowerupUseError("Every Quicksand target must be an active enemy", 400, "INVALID_TARGET");
        }
        const claimed = await tx.racePowerup.updateMany({
          where: { id: powerupId, userId, raceId, status: "HELD", type: "QUICKSAND" },
          data: { status: "USED", usedAt: currentTime, targetUserId: null, upgradeLevel: 0 },
        });
        if (claimed.count !== 1) {
          throw new PowerupUseError("This Quicksand has already been used", 409, "POWERUP_ALREADY_USED");
        }
        const results = [];
        for (const victim of lockedVictims) {
          const existingFreeze = await tx.raceActiveEffect.findFirst({
            where: { targetParticipantId: victim.id, type: { in: ["LEG_CRAMP", "QUICKSAND"] }, status: "ACTIVE" },
          });
          if (existingFreeze) {
            throw new PowerupUseError("A selected target is already frozen", 400, "TARGET_ALREADY_FROZEN");
          }
          const shield = await tx.raceActiveEffect.findFirst({
            where: { targetParticipantId: victim.id, type: "COMPRESSION_SOCKS", status: "ACTIVE" },
            orderBy: { createdAt: "asc" },
          });
          if (shield) {
            await tx.raceActiveEffect.update({ where: { id: shield.id }, data: { status: "BLOCKED" } });
            results.push({ targetUserId: victim.userId, outcome: "BLOCKED", expiresAt: null });
          } else {
            await tx.raceActiveEffect.create({ data: {
              raceId, targetParticipantId: victim.id, targetUserId: victim.userId,
              sourceUserId: userId, powerupId, type: "QUICKSAND", status: "ACTIVE",
              startsAt: currentTime, expiresAt,
              metadata: { stepsAtFreezeStart: victim.totalSteps || 0 },
            } });
            results.push({ targetUserId: victim.userId, outcome: "APPLIED", expiresAt });
          }
        }
        await tx.racePowerupEvent.create({ data: {
          raceId, actorUserId: userId, eventType: "POWERUP_USED", powerupType: "QUICKSAND",
          description: `${myDisplayName} used Quicksand on ${victims.length} rival${victims.length === 1 ? "" : "s"}!`,
          metadata: { targetResults: results.map((r) => ({ targetUserId: r.targetUserId, outcome: r.outcome })) },
        } });
        // Restore the caller's requested target order for the response.
        const byUser = new Map(results.map((r) => [r.targetUserId, r]));
        return targetUserIds.map((id) => byUser.get(id)).filter(Boolean);
      });
      for (const targetResult of targetResults) {
        events.emit(targetResult.outcome === "APPLIED" ? "POWERUP_USED" : "POWERUP_BLOCKED", targetResult.outcome === "APPLIED"
          ? { raceId, userId, powerupType: type, targetUserId: targetResult.targetUserId, upgradeLevel: 0, stealthed: await casterStealthed() }
          : { raceId, attackerUserId: userId, defenderUserId: targetResult.targetUserId, blockedType: type, upgradeLevel: 0 });
      }
      await invalidateRaceProgress(raceId);
      await enqueueRaceResolution({ raceId, userId, timeZone, reason: "POWERUP_MUTATION", powerupTypes: [type], priority: "IMMEDIATE" });
      if (inlineResolveInjected) await resolveRaceState({ raceId, timeZone });
      await repairRacePowerupInventory({ raceId, userId, refresh: true });
      const applied = targetResults.filter((r) => r.outcome === "APPLIED").length;
      return {
        blocked: applied === 0,
        outcome: applied === 0 ? "BLOCKED" : applied === targetResults.length ? "APPLIED" : "PARTIAL",
        durationMs: 1 * 60 * 60 * 1000,
        targetResults,
      };
    }

    // ── Wave 5 targetless fan-out powerups (§3.1/§3.6/§3.8) ─────────────────
    // These mirror the QUICKSAND/RAINSTORM early-return style: they create their
    // own effect rows, mark the item USED, and return without touching the
    // single-target Mirror/Socks switch below (they are buffs or AoE jams).
    const finalizeSelfContainedUse = async (resolvedTarget = null) => {
      await powerupModel.update(powerupId, {
        status: "USED",
        usedAt: now(),
        targetUserId: resolvedTarget,
        upgradeLevel: 0,
      });
      await invalidateRaceProgress(raceId);
      await enqueueRaceResolution({ raceId, userId, timeZone, reason: "POWERUP_MUTATION", powerupTypes: [type], priority: "IMMEDIATE" });
      if (inlineResolveInjected) await resolveRaceState({ raceId, timeZone });
      await repairRacePowerupInventory({ raceId, userId, refresh: true });
    };

    // Merge helper for per-beneficiary buff windows (§3.1/§3.8): if the
    // beneficiary already holds an ACTIVE row of this buff type, EXTEND it to the
    // later end (union) instead of creating a second row, so two casts never
    // exceed the single multiplier. Returns the created/updated row.
    // `startsAt` MUST come from the same clock read the caller derived
    // `expiresAt` from. Reading `now()` again below (after an awaited DB round
    // trip) made the stamped window 3599999ms instead of 3600000ms whenever the
    // read took ≥1ms — a latent off-by-one-millisecond that any latency change
    // on this path can surface. The anchor is threaded in instead.
    const upsertBuffWindow = async (
      participantId,
      beneficiaryUserId,
      effectType,
      expiresAt,
      metadata,
      startsAt
    ) => {
      const existing = await effectModel.findActiveByTypeForParticipant(participantId, effectType);
      if (existing) {
        const mergedEnd =
          new Date(existing.expiresAt || 0).getTime() > expiresAt.getTime()
            ? existing.expiresAt
            : expiresAt;
        return effectModel.update(existing.id, { expiresAt: mergedEnd });
      }
      return effectModel.create({
        raceId,
        targetParticipantId: participantId,
        targetUserId: beneficiaryUserId,
        sourceUserId: userId,
        powerupId,
        type: effectType,
        startsAt: startsAt || now(),
        expiresAt,
        metadata,
      });
    };

    if (type === "UPRISING" || type === "RALLY_FLAG" || type === "POWER_OUTAGE") {
      if (targetUserId) {
        throw new PowerupUseError(
          `${POWERUP_NAMES[type]} is not aimed at a single racer. Remove the target`,
          400
        );
      }
    }

    if (type === "UPRISING") {
      // Determine beneficiaries + enforce the bottom-half / losing-team gate.
      let beneficiaries;
      if (isTeamRace) {
        // 2026-07-25 §3 — the gate and the board must never disagree.
        //
        // The board (getRaceProgress) sums the EFFECTIVE per-participant totals
        // with buildTeamsBlock. This does the same two things, in the same
        // order, with the same helper: compute the effective totals first
        // (stored totals go stale between syncs, exactly like the Trail Mine
        // case above), then sum them. Summing the unresolved column by hand is
        // precisely how the gate came to contradict the screen.
        //
        // C0: the freshening is now a READ (computeRaceState) rather than a
        // resolve-and-persist. The parity argument is untouched — it is the same
        // scoring pipeline producing the same numbers, and under C3 the board
        // will read those numbers from the snapshot the worker publishes. What
        // changes is only that this request no longer bulk-writes
        // race_participants, so it cannot race the fenced worker.
        //
        // DELIBERATELY SCOPED TO THE TEAM BRANCH (D3). The solo bottom-half gate
        // below, Hitchhike FRONT/BEHIND, participantRank and adjacentParticipant
        // all keep their existing raw-column behaviour; widening this would
        // change targeting for a dozen powerups at once and is tracked as a
        // separate audit (spec §11). Do not hoist this computation out of here.
        const { totalsByParticipantId } = await computeRaceState({
          raceId,
          timeZone,
        });
        const board = buildTeamsBlockFromParticipants(
          race,
          overlayComputedTotals(race.participants, totalsByParticipantId)
        );
        const teamTotals = {
          TEAM_A: board.teamA.totalSteps,
          TEAM_B: board.teamB.totalSteps,
        };
        const myTeam = myParticipant.team;
        const otherTeam = myTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
        if (teamTotals[myTeam] >= teamTotals[otherTeam]) {
          throw new PowerupUseError(
            "Uprising can only be used by the losing team",
            400,
            "INVALID_TARGET"
          );
        }
        beneficiaries = acceptedParticipants.filter(
          (p) => p.team === myTeam && isAliveTarget(p)
        );
      } else {
        const alive = acceptedParticipants.filter((p) => isAliveTarget(p));
        const sorted = sortedActiveParticipants(alive);
        const n = sorted.length;
        const bottomStart = Math.ceil(n / 2); // 0-indexed start of the bottom half
        const myIndex = sorted.findIndex((p) => p.id === myParticipant.id);
        if (myIndex < bottomStart) {
          throw new PowerupUseError(
            "Uprising can only be used from the bottom half of the standings",
            400,
            "INVALID_TARGET"
          );
        }
        beneficiaries = sorted.slice(bottomStart);
      }

      const upStart = now();
      const upEnd = new Date(upStart.getTime() + UPRISING_DURATION_MS);
      let ownEffect = null;
      for (const b of beneficiaries) {
        const row = await upsertBuffWindow(
          b.id,
          b.userId,
          "UPRISING",
          upEnd,
          { multiplier: UPRISING_MULTIPLIER },
          upStart
        );
        if (b.userId === userId) ownEffect = row;
      }

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_USED",
        powerupType: type,
        description: `${myDisplayName} sparked an Uprising! ${beneficiaries.length} runner${beneficiaries.length === 1 ? "" : "s"} get 2x steps for 1 hour.`,
        metadata: { affected: beneficiaries.length },
      });
      events.emit("POWERUP_USED", { raceId, userId, powerupType: type, upgradeLevel: 0, stealthed: await casterStealthed() });
      await finalizeSelfContainedUse(null);
      return {
        blocked: false,
        upgradeLevel: 0,
        coinsSpent: 0,
        outcome: "APPLIED",
        affected: beneficiaries.length,
        effect: ownEffect,
        durationMs: UPRISING_DURATION_MS,
      };
    }

    if (type === "RALLY_FLAG") {
      if (!isTeamRace) {
        throw new PowerupUseError("Rally Flag needs a team race", 400, "INVALID_TARGET");
      }
      const beneficiaries = acceptedParticipants.filter(
        (p) => p.team === myParticipant.team && isAliveTarget(p)
      );
      const flagStart = now();
      const flagEnd = new Date(flagStart.getTime() + RALLY_FLAG_DURATION_MS);
      let ownEffect = null;
      for (const b of beneficiaries) {
        const row = await upsertBuffWindow(
          b.id,
          b.userId,
          "RALLY_FLAG",
          flagEnd,
          { multiplier: RALLY_FLAG_MULTIPLIER },
          flagStart
        );
        if (b.userId === userId) ownEffect = row;
      }
      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_USED",
        powerupType: type,
        description: `${myDisplayName} raised a Rally Flag! The whole team gets 1.25x steps for 1 hour.`,
        metadata: { affected: beneficiaries.length },
      });
      events.emit("POWERUP_USED", { raceId, userId, powerupType: type, upgradeLevel: 0, stealthed: await casterStealthed() });
      await finalizeSelfContainedUse(null);
      return {
        blocked: false,
        upgradeLevel: 0,
        coinsSpent: 0,
        outcome: "APPLIED",
        affected: beneficiaries.length,
        effect: ownEffect,
        durationMs: RALLY_FLAG_DURATION_MS,
      };
    }

    if (type === "POWER_OUTAGE") {
      // AoE jam: one POWER_OUTAGE row per alive enemy, 30 min. Umbrella holders
      // are skipped (immune, not consumed); Socks holders are skipped with the
      // shield consumed (blockedCount); already-jammed victims are skipped.
      const victims = acceptedParticipants.filter(
        (p) => p.userId !== userId && isAliveTarget(p) && isEnemy(p)
      );
      const outageEnd = new Date(now().getTime() + POWER_OUTAGE_DURATION_MS);
      const affected = [];
      let blockedCount = 0;
      for (const victim of victims) {
        const victimEffects = await effectModel.findActiveForParticipant(victim.id);
        const umbrella = victimEffects.find(
          (e) => e.type === "UMBRELLA" && e.expiresAt && new Date(e.expiresAt) > now()
        );
        if (umbrella) continue; // immune, shield not consumed
        const alreadyJammed = victimEffects.find(
          (e) => e.type === "POWER_OUTAGE" && e.expiresAt && new Date(e.expiresAt) > now()
        );
        if (alreadyJammed) continue;
        const socks = victimEffects.find((e) => e.type === "COMPRESSION_SOCKS");
        if (socks) {
          await effectModel.update(socks.id, { status: "BLOCKED" });
          blockedCount += 1;
          await eventModel.create({
            raceId,
            actorUserId: victim.userId,
            eventType: "POWERUP_BLOCKED",
            powerupType: type,
            targetUserId: userId,
            description: `${victim.user?.displayName || "A runner"}'s Compression Socks kept the lights on through ${myDisplayName}'s Power Outage!`,
          });
          events.emit("POWERUP_BLOCKED", {
            raceId,
            attackerUserId: userId,
            defenderUserId: victim.userId,
            blockedType: type,
            upgradeLevel: 0,
          });
          continue;
        }
        await effectModel.create({
          raceId,
          targetParticipantId: victim.id,
          targetUserId: victim.userId,
          sourceUserId: userId,
          powerupId,
          type: "POWER_OUTAGE",
          startsAt: now(),
          expiresAt: outageEnd,
        });
        affected.push(victim.userId);
      }
      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_USED",
        powerupType: type,
        description: `${myDisplayName} triggered a Power Outage! ${affected.length} rival${affected.length === 1 ? "" : "s"} can't use powerups for 30 minutes.`,
        metadata: { affected: affected.length, blockedCount },
      });
      for (const uid of affected) {
        events.emit("POWERUP_USED", { raceId, userId, powerupType: type, targetUserId: uid, upgradeLevel: 0, stealthed: await casterStealthed() });
      }
      await finalizeSelfContainedUse(null);
      return {
        blocked: affected.length === 0,
        upgradeLevel: 0,
        coinsSpent: 0,
        outcome: affected.length === 0 ? "BLOCKED" : "APPLIED",
        affected: affected.length,
        blockedCount,
        durationMs: POWER_OUTAGE_DURATION_MS,
      };
    }

    if (type === "MYSTERY_POTION") {
      return await applyMysteryPotion({
        // Resolved HERE, where the memo is in scope, and handed over as a plain
        // boolean — applyMysteryPotion is module-scope and can't reach it.
        casterStealthed: await casterStealthed(),
        userId,
        raceId,
        powerupId,
        myParticipant,
        myDisplayName,
        acceptedParticipants,
        isEnemy,
        isAliveTarget,
        effectModel,
        participantModel,
        eventModel,
        events,
        powerupModel,
        awardCoins,
        random,
        now,
        currentTime: now(),
        finalize: finalizeSelfContainedUse,
      });
    }

    // Rainstorm is untargeted (hits every other racer) and never stacks: while
    // any rainstorm is active in the race, another cannot be started. In a team
    // race the fan-out is ENEMY-ONLY (teammates stay dry — TR-652).
    if (type === "RAINSTORM") {
      if (targetUserId) {
        throw new PowerupUseError("Rainstorm hits every racer. You cannot specify a target", 400);
      }
      // B4: PER-CASTER limit. Each user may have one active storm at a time;
      // different users' storms may overlap (a victim under two storms is
      // clamped at a single 0.5x in scoring). A caster's own storm does not
      // exempt them from being a normal victim of someone else's storm.
      const raceEffects = await effectModel.findActiveForRace(raceId);
      const activeStorm = raceEffects.find(
        (e) => e.type === "RAINSTORM" && e.sourceUserId === userId
      );
      if (activeStorm) {
        throw new PowerupUseError(
          "Your Rainstorm is already active in this race",
          400,
          undefined,
          { retainHeld: true } // transient self-limit — keep for later (item 12 scope)
        );
      }
      const otherRunners = acceptedParticipants.filter(
        (p) => p.userId !== userId && isAliveTarget(p) && isEnemy(p)
      );
      if (otherRunners.length === 0) {
        throw new PowerupUseError("No other active runners to rain on", 400);
      }
    }

    // Red Card auto-targets the leader — in a team race, the ENEMY team's top
    // stepper (TR-652), skipping forfeited members (TR-657).
    let resolvedTargetUserId = targetUserId;
    if (type === "RED_CARD") {
      if (targetUserId) {
        throw new PowerupUseError("Red Card auto-targets the leader. You cannot specify a target", 400);
      }
      const eligible = acceptedParticipants.filter(
        (p) => isAliveTarget(p) && isEnemy(p)
      );
      if (eligible.length === 0) {
        throw new PowerupUseError("No eligible runner to red-card", 400);
      }
      const sorted = [...eligible].sort((a, b) => b.totalSteps - a.totalSteps);
      const leader = sorted[0];
      if (leader.userId === userId) {
        throw new PowerupUseError("You cannot use Red Card while you are in the lead", 400);
      }
      if (sorted.length > 1 && leader.totalSteps === sorted[1].totalSteps) {
        throw new PowerupUseError("Leaders are tied. Wait until the tie is broken to use Red Card", 400);
      }
      resolvedTargetUserId = leader.userId;
    }

    // SECOND_WIND's leader rejection, moved here from inside the effect switch.
    // Every other rejection in this file deliberately runs before the coin
    // deduction / mark-USED preamble so a rejected player keeps their item;
    // this one was the exception, sitting after the coin deduct. It never cost
    // anyone an item in practice (mark-USED happens after the switch, and
    // SECOND_WIND is not upgradeable so costCoins is always 0), but it was one
    // upgrade-ladder edit away from charging coins for a refused action.
    // Message and status are byte-identical to the old throw — client-side error
    // handling is unchanged.
    if (type === "SECOND_WIND") {
      const swEligible = acceptedParticipants.filter((p) => !p.finishedAt);
      const swSorted = [...swEligible].sort((a, b) => b.totalSteps - a.totalSteps);
      const swLeader = swSorted[0];
      if (
        swLeader &&
        (swLeader.userId === userId || swLeader.totalSteps === myParticipant.totalSteps)
      ) {
        throw new PowerupUseError("You cannot use Second Wind while you are in the lead", 400);
      }
    }

    if (type === "PINECONE_TOSS") {
      if (targetUserId) {
        throw new PowerupUseError("Pinecone Toss targets by direction. Choose front or behind", 400);
      }
      if (!["FRONT", "BEHIND"].includes(targetDirection)) {
        throw new PowerupUseError("Pinecone Toss requires FRONT or BEHIND", 400);
      }
      // Team races: adjacency is evaluated among ENEMY members ranked by
      // individual steps (TR-653) — the tosser is kept in the pool purely as
      // the reference position; teammates are skipped over.
      const adjacencyPool = isTeamRace
        ? acceptedParticipants.filter(
            (p) => p.userId === userId || (isEnemy(p) && isAliveTarget(p))
          )
        : acceptedParticipants;
      const target = adjacentParticipant(adjacencyPool, myParticipant, targetDirection);
      if (!target) {
        throw new PowerupUseError(`No runner ${targetDirection === "FRONT" ? "ahead" : "behind"} of you`, 400);
      }
      resolvedTargetUserId = target.userId;
    }

    // Find target participant if offensive
    let targetParticipant = null;
    if (OFFENSIVE_TYPES.includes(type)) {
      targetParticipant = acceptedParticipants.find((p) => p.userId === resolvedTargetUserId);
      if (!targetParticipant) {
        throw new PowerupUseError("Target is not an active participant in this race", 400);
      }
      // TR-602/657: forfeited members can no longer be targeted.
      if (targetParticipant.forfeitedAt) {
        throw new PowerupUseError("Target has forfeited the race", 400);
      }
      // TR-651: no friendly fire — offensive powerups only hit the enemy team.
      if (isTeamRace && !isEnemy(targetParticipant)) {
        throw new PowerupUseError("You can't target a teammate", 400, "INVALID_TARGET");
      }
    }

    // IMPOSTER: targeted but not offensive. Validate the chosen rival is a real
    // active participant (the display swap stores their userId in metadata).
    let imposterTargetParticipant = null;
    if (type === "IMPOSTER") {
      imposterTargetParticipant = acceptedParticipants.find(
        (p) => p.userId === resolvedTargetUserId
      );
      if (!imposterTargetParticipant) {
        throw new PowerupUseError("Target is not an active participant in this race", 400);
      }
      // TR-602/657: forfeited members can no longer be targeted.
      if (imposterTargetParticipant.forfeitedAt) {
        throw new PowerupUseError("Target has forfeited the race", 400);
      }
      // TR-651: Imposter counts as an enemy-only targeted powerup too.
      if (isTeamRace && !isEnemy(imposterTargetParticipant)) {
        throw new PowerupUseError("You can't target a teammate", 400, "INVALID_TARGET");
      }
    }

    // BOUNTY (§3.11): TARGETED but NOT offensive — it creates no debuff on the
    // target (so it is never blockable/reflectable/decoy-able). Validate the
    // wager here, exactly like the Imposter targeting block above.
    let bountyTargetParticipant = null;
    if (type === "BOUNTY") {
      if (isTeamRace) {
        throw new PowerupUseError("Bounty is not available in team races", 400, "INVALID_TARGET");
      }
      // Time-based races only — a target-step race has no fixed end to settle at.
      if (!race.endsAt) {
        throw new PowerupUseError("Bounty needs a race with a fixed end time", 400, "INVALID_TARGET");
      }
      bountyTargetParticipant = acceptedParticipants.find(
        (p) => p.userId === resolvedTargetUserId
      );
      if (!bountyTargetParticipant || !isAliveTarget(bountyTargetParticipant)) {
        throw new PowerupUseError("Target is not an active participant in this race", 400);
      }
      // Must be strictly AHEAD of the caster (leader-guard style, like Red Card).
      if ((bountyTargetParticipant.totalSteps || 0) <= (myParticipant.totalSteps || 0)) {
        throw new PowerupUseError("Bounty must target a rival ahead of you", 400, "INVALID_TARGET");
      }
      // One active Bounty per caster per race.
      const existingBounty = (await effectModel.findActiveForRace(raceId)).find(
        (e) => e.type === "BOUNTY" && e.sourceUserId === userId &&
          e.expiresAt && new Date(e.expiresAt) > now()
      );
      if (existingBounty) {
        throw new PowerupUseError("You already have an active Bounty in this race", 409);
      }
    }

    // PIGGY_BANK (§3.10): ONE active per user GLOBALLY across all races. Query
    // any ACTIVE piggy for this user in ANY race and reject with the blocking
    // race named. Uses the raw client so the check spans races (the effect-model
    // helpers are all race/participant scoped).
    if (type === "PIGGY_BANK" && typeof db?.raceActiveEffect?.findFirst === "function") {
      const activePiggy = await db.raceActiveEffect.findFirst({
        where: { targetUserId: userId, type: "PIGGY_BANK", status: "ACTIVE", expiresAt: { gt: now() } },
      });
      if (activePiggy) {
        let blockingName = "another race";
        try {
          const blockingRace = await raceModel.findById(activePiggy.raceId);
          if (blockingRace?.name) blockingName = `"${blockingRace.name}"`;
        } catch { /* best-effort name */ }
        throw new PowerupUseError(
          `You already have a Piggy Bank saving in ${blockingName}`,
          409,
          "PIGGY_BANK_ALREADY_ACTIVE"
        );
      }
    }

    // Item 5 (BUG): a stealthed player must not be targetable by ANY
    // manually-aimed powerup. Generalizes the old SNEAKY_SWAP-only guard to the
    // whole TARGETED_TYPES set (the caller-supplies-targetUserId powerups). This
    // is the single server-side source of truth — it covers hand-crafted
    // requests and clients defeated by Detour (which forces stealthed:false on
    // the leaderboard). Runs BEFORE any coin deduction / mark-USED / effect
    // creation, so the item stays HELD on rejection (and is refunded to general
    // inventory by the item-12 unwind if it was a redeemed one). Auto-targeted
    // RED_CARD / PINECONE_TOSS are NOT in TARGETED_TYPES, so a stealthed leader
    // can still be red-carded (powerups-stealth-redcard.test.js stays green).
    if (TARGETED_TYPES.includes(type)) {
      const targetedParticipant =
        targetParticipant || imposterTargetParticipant || bountyTargetParticipant;
      if (targetedParticipant) {
        const targetStealth = await effectModel.findActiveByTypeForParticipant(
          targetedParticipant.id,
          "STEALTH_MODE"
        );
        if (targetStealth) {
          throw new PowerupUseError(
            "You cannot target a stealthed player",
            400,
            "TARGET_STEALTHED"
          );
        }
      }
    }

    let targetDisplayName =
      targetParticipant?.user?.displayName ||
      imposterTargetParticipant?.user?.displayName ||
      bountyTargetParticipant?.user?.displayName ||
      "a runner";

    // Reject Shortcut on a target with 0 steps — nothing to steal
    if (type === "SHORTCUT" && targetParticipant && Math.max(0, targetParticipant.totalSteps) === 0) {
      throw new PowerupUseError("Target has 0 steps. Nothing to steal", 400);
    }

    // Reject stacking Leg Cramp on a target that already has one active
    if (type === "LEG_CRAMP" && targetParticipant) {
      const existingCramp = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "LEG_CRAMP"
      );
      if (existingCramp) {
        throw new PowerupUseError("Target already has an active Leg Cramp", 400);
      }
    }

    // Leg Cramp × Wrong Turn mutual exclusion (owner decision 2026-07-29): a
    // target never carries a freeze and a reversal at once. DIRECT uses of
    // either type on a target with the other active are rejected here — BEFORE
    // coin deduction / shields / mark-USED, so the item stays HELD. This
    // replaces the old direct-use behavior where Wrong Turn silently cancelled
    // the target's Leg Cramp. INDIRECT landings (Mirror reflect / Decoy
    // redirect / potion rolls) can't be pre-checked without wasting the shield,
    // so their creation sites cancel the conflicting effect instead — the
    // invariant holds either way. Messages are user-facing: frozen clients
    // render them verbatim (powerupUseErrorCopy falls through for unknown
    // codes). retainHeld: transient target-state, usable once it expires.
    if (type === "LEG_CRAMP" && targetParticipant) {
      const conflictingWT = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "WRONG_TURN"
      );
      if (conflictingWT) {
        throw new PowerupUseError(
          "Target is already on a Wrong Turn. Wait for it to end",
          400,
          "TARGET_EFFECT_CONFLICT",
          { retainHeld: true }
        );
      }
    }
    if (type === "WRONG_TURN" && targetParticipant) {
      const conflictingCramp = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "LEG_CRAMP"
      );
      if (conflictingCramp) {
        throw new PowerupUseError(
          "Target is frozen by a Leg Cramp. Wait for it to end",
          400,
          "TARGET_EFFECT_CONFLICT",
          { retainHeld: true }
        );
      }
    }

    // Reject stacking Signal Jammer on a target that already has one active. This
    // runs BEFORE coin deduction, the Mirror/Socks pre-checks, and the mark-USED
    // step, so a rejected attacker keeps their jammer HELD (not consumed).
    if (type === "SIGNAL_JAMMER" && targetParticipant) {
      const existingJam = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "SIGNAL_JAMMER"
      );
      if (existingJam && existingJam.expiresAt && new Date(existingJam.expiresAt) > now()) {
        throw new PowerupUseError(
          "That player is already jammed",
          409,
          undefined,
          { retainHeld: true } // transient target-limit — keep for later (item 12 scope)
        );
      }
    }

    // LEECH stacking rules (run before coin deduction / mark-USED so a rejected
    // leecher keeps the powerup HELD):
    //   * at most ONE active leech per (leecher -> victim) pair, and
    //   * at most LEECH_MAX_PER_VICTIM concurrent leechers on any one victim
    //     (gang-stall guard). With the cap removed the worst case is no longer
    //     -2 * cap: it is the victim's window steps drained to zero, split
    //     deterministically between at most two leechers (zero-sum).
    if (type === "LEECH" && targetParticipant) {
      const activeOnVictim = (
        await effectModel.findActiveForParticipant(targetParticipant.id)
      ).filter((e) => e.type === "LEECH");
      if (activeOnVictim.some((e) => e.sourceUserId === userId)) {
        throw new PowerupUseError("You're already leeching this rival", 400);
      }
      if (activeOnVictim.length >= LEECH_MAX_PER_VICTIM) {
        throw new PowerupUseError(
          "This rival is already being leeched by two others",
          400
        );
      }
    }

    // HITCHHIKE stacking rules (§7.2). Both run BEFORE coin deduction and the
    // mark-USED step, so a rejected caster keeps the powerup HELD:
    //   * at most ONE active link per CASTER, and
    //   * at most HITCHHIKE_MAX_PER_TARGET (1) active link ON any one target.
    // The target cap is 1 — not 2 as for Leech — because Hitchhike MINTS steps
    // rather than transferring them, so concurrent links compound against a
    // player who cannot see the link coming.
    if (type === "HITCHHIKE" && targetParticipant) {
      const raceEffects = await effectModel.findActiveForRace(raceId);
      const liveLinks = (raceEffects || []).filter(
        (e) => e.type === "HITCHHIKE" && isLiveTimedEffect(e, now())
      );
      if (liveLinks.some((e) => e.sourceUserId === userId)) {
        throw new PowerupUseError(
          "You already have an active Hitchhike. Wait for it to expire",
          409,
          "HITCHHIKE_ALREADY_ACTIVE"
        );
      }
      const onTarget = liveLinks.filter(
        (e) => e.targetUserId === resolvedTargetUserId
      );
      if (onTarget.length >= HITCHHIKE_MAX_PER_TARGET) {
        throw new PowerupUseError(
          "Someone is already hitching a ride on that racer",
          409,
          "HITCHHIKE_TARGET_FULL"
        );
      }
    }

    // Reject stacking Runner's High when user already has one active
    if (type === "RUNNERS_HIGH") {
      const existingBuff = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "RUNNERS_HIGH"
      );
      if (existingBuff) {
        throw new PowerupUseError("You already have an active Runner's High", 400);
      }
    }

    // Reject stacking Ghost Pepper when the user already has one running.
    // Stacking is wrong in BOTH directions: two live peppers SUM to 6x
    // (effectMultiplier sums every active buff row), while a pepper eaten
    // during the previous one's burnout is destroyed outright (the freeze check
    // short-circuits to 0 before the buff sum). The check covers the whole
    // boost+burnout window because the effect row spans both phases.
    //
    // retainHeld: Ghost Pepper is a store-bought wave-5 item paid for in coins,
    // and this is a TRANSIENT limit — the pepper is perfectly usable in this
    // race once the current one ends, so it stays HELD instead of being eaten
    // by the rejection (same treatment as Rainstorm / Hitchhike / Piggy Bank).
    if (type === "GHOST_PEPPER") {
      const existingPepper = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "GHOST_PEPPER"
      );
      // isLiveTimedEffect (not just status ACTIVE) so a row the expireEffects
      // cron hasn't retired yet stops blocking the moment its window really
      // ends — the guard must not outlast the pepper.
      if (existingPepper && isLiveTimedEffect(existingPepper, now())) {
        throw new PowerupUseError(
          "You're still burning from a Ghost Pepper. Wait for it to wear off",
          400,
          "GHOST_PEPPER_ALREADY_ACTIVE",
          { retainHeld: true }
        );
      }
    }

    // Reject stacking Stealth Mode when user already has one active
    if (type === "STEALTH_MODE") {
      const existingStealth = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "STEALTH_MODE"
      );
      if (existingStealth) {
        throw new PowerupUseError("You already have an active Stealth Mode", 400);
      }
    }

    // Reject stacking Wrong Turn on a target that already has one active
    if (type === "WRONG_TURN" && targetParticipant) {
      const existingWT = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "WRONG_TURN"
      );
      if (existingWT) {
        throw new PowerupUseError("Target already has an active Wrong Turn", 400);
      }
    }

    // Reject stacking Detour Sign on target
    if (type === "DETOUR_SIGN" && targetParticipant) {
      const existingDetour = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "DETOUR_SIGN"
      );
      if (existingDetour) {
        throw new PowerupUseError("Target already has an active Detour Sign", 400);
      }
    }

    if (type === "LUCKY_HORSESHOE") {
      const existingLucky = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "LUCKY_HORSESHOE"
      );
      if (existingLucky) {
        throw new PowerupUseError("You already have an active Lucky Horseshoe", 400);
      }
    }

    if (type === "CAMPFIRE_REST") {
      const existingCampfire = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "CAMPFIRE_REST"
      );
      if (existingCampfire) {
        throw new PowerupUseError("You already have an active Campfire Rest", 400);
      }
    }

    // POCKET_WATCH (§6.1). Two modes on one endpoint, chosen by the presence of
    // `targetEffectId`. An absent targetEffectId keeps the legacy path EXACTLY as
    // it was, including this pre-check — a frozen client's no-parameter request
    // therefore retains its precise legacy meaning.
    let pocketWatchTargetEffect = null;
    if (type === "POCKET_WATCH" && !targetEffectId) {
      const activeTimedEffects = (await effectModel.findActiveForParticipant(myParticipant.id))
        .filter(isPocketWatchExtendable);
      if (activeTimedEffects.length === 0) {
        throw new PowerupUseError("Pocket Watch requires an active timed buff", 400);
      }
    }
    if (type === "POCKET_WATCH" && targetEffectId) {
      // Every check here runs BEFORE the coin deduction and the mark-USED step,
      // so a rejected request consumes nothing.
      const effect =
        typeof effectModel.findById === "function"
          ? await effectModel.findById(targetEffectId)
          : null;
      const invalid = (message) =>
        new PowerupUseError(message, 400, "INVALID_EFFECT");
      if (!effect) {
        throw invalid("That effect is no longer active");
      }
      // Ownership is checked before eligibility so a rival's effect always reads
      // as a permissions problem rather than a shape problem.
      if (effect.sourceUserId !== userId) {
        throw new PowerupUseError(
          "You can only extend effects you applied",
          403,
          "EFFECT_NOT_OWNED"
        );
      }
      if (effect.raceId && effect.raceId !== raceId) {
        throw invalid("That effect belongs to a different race");
      }
      if (!isLiveTimedEffect(effect, now())) {
        throw invalid("That effect is no longer active");
      }
      // Self-buffs belong to the legacy mode; harmful-effect extension is
      // rival-only. Rows missing either id are treated as self-applied (the same
      // defensive stance isOpponentInflicted takes).
      if (!effect.targetUserId || effect.targetUserId === effect.sourceUserId) {
        throw invalid("Pick a debuff you placed on a rival");
      }
      if (!POCKET_WATCH_TARGETABLE_TYPES.includes(effect.type)) {
        throw invalid("That effect cannot be extended");
      }
      pocketWatchTargetEffect = effect;
    }

    // QUICK_RINSE (§8). Validate BEFORE consumption: with nothing eligible we
    // reject 409 NO_TIMED_DEBUFFS and the item stays HELD. Note the Signal Jammer
    // guard at the top of this command already blocked a jammed user — that is
    // deliberate and matches shipped Cleanse behavior (§8.1); do not add a bypass.
    let quickRinseTargets = [];
    if (type === "QUICK_RINSE") {
      const activeEffects = await effectModel.findActiveForParticipant(myParticipant.id);
      quickRinseTargets = (activeEffects || []).filter(
        (e) => isCleansableDebuff(e, userId) && isLiveTimedEffect(e, now())
      );
      if (quickRinseTargets.length === 0) {
        throw new PowerupUseError(
          "No timed debuffs to rinse",
          409,
          "NO_TIMED_DEBUFFS"
        );
      }
    }

    if (type === "CLEANSE") {
      const activeEffects = await effectModel.findActiveForParticipant(myParticipant.id);
      const hasOpponentDebuff = activeEffects.some((e) => isCleansableDebuff(e, userId));
      if (!hasOpponentDebuff) {
        throw new PowerupUseError("No debuffs to cleanse", 400);
      }
    }

    if (type === "TRAIL_MINE") {
      const rank = participantRank(acceptedParticipants, myParticipant);
      if (rank === acceptedParticipants.filter((p) => !p.finishedAt).length - 1) {
        throw new PowerupUseError("You cannot use Trail Mine while you are in last place", 400);
      }
    }

    if (type === "SNEAKY_SWAP" && targetParticipant) {
      // Stealth-target rejection is handled by the generic TARGETED_TYPES guard
      // above (item 5), so it is intentionally not repeated here.
      // Steal semantics: take one RANDOM stealable powerup from the target;
      // the attacker gives up nothing. Old app versions still send
      // swapOfferedPowerupId/swapRequestedPowerupId from the retired
      // mutual-swap flow — both are deliberately ignored, so a legacy client
      // can never lose its own powerup here.
      const targetHeld = await powerupModel.findHeldByParticipant(targetParticipant.id);
      const stealable = targetHeld.filter((p) => !UNSTEALABLE_TYPES.includes(p.type));
      if (stealable.length === 0) {
        throw new PowerupUseError("Target has no powerup to steal", 400);
      }
    }

    // Reject stacking Compression Socks when user already has an active shield
    if (type === "COMPRESSION_SOCKS") {
      const existingShield = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "COMPRESSION_SOCKS"
      );
      if (existingShield) {
        throw new PowerupUseError("You already have an active Compression Socks shield", 400);
      }
    }

    // Reject stacking Mirror when user already has an active mirror
    if (type === "MIRROR") {
      const existingMirror = await effectModel.findActiveByTypeForParticipant(
        myParticipant.id,
        "MIRROR"
      );
      if (existingMirror) {
        throw new PowerupUseError("You already have an active Mirror", 400);
      }
    }

    // Reject Fanny Pack if user already has expanded slots
    if (type === "FANNY_PACK") {
      if (myParticipant.powerupSlots > 3) {
        throw new PowerupUseError("You already have an active Fanny Pack", 400);
      }
    }

    // All validation has passed. Deduct coins atomically (first DB write).
    // This must happen AFTER all rejection paths above, so that no coins are
    // lost on validation failure. The deduct is also atomic: concurrent calls
    // that would overdraw will fail here.
    if (costCoins > 0) {
      try {
        await deductCoinsAtomic({
          userId,
          amount: costCoins,
          reason: "powerup_upgrade",
          refId: powerupId,
        });
      } catch (err) {
        if (err instanceof InsufficientCoinsError) {
          throw new PowerupUseError("Not enough coins for this upgrade", 400);
        }
        throw err;
      }
    }

    // Mirror reflect pre-check. Precedence: MIRROR wins even when the target
    // also holds Compression Socks. The Mirror is checked FIRST and, if present,
    // reflects the attack — the TARGET's socks are then never consulted, so a
    // dual-shield holder gets two saves: reflect now, block next time. When the
    // target holds an active Mirror, the offensive powerup is REFLECTED back
    // onto the attacker: we swap roles so the effect lands on the original
    // attacker, consume the Mirror, and write/emit a POWERUP_REFLECTED event.
    // The bounce then goes through the Socks block below AGAINST THE ATTACKER
    // (post-swap targetParticipant): an attacker holding their own active
    // Compression Socks blocks the reflected hit — Mirror and socks are both
    // consumed and the effect lands on no one.
    // Shop-bought powerups (SHOP_POWERUP_TYPES) are NEVER reflectable, so they
    // skip this pre-check entirely and fall through to the Socks block below.
    let reflected = false;
    // Set when a Decoy redirected this single-target attack to a new victim.
    let decoyRedirectedToUserId = null;
    if (OFFENSIVE_TYPES.includes(type) && !SHOP_POWERUP_TYPES.includes(type) && targetParticipant) {
      const mirror = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "MIRROR"
      );
      if (mirror) {
        // Re-check Wrong Turn stacking against the actual POST-reflect
        // landing spot (the original attacker), not the pre-swap target.
        // The generic "already has an active Wrong Turn" guard above only
        // validated the target BEFORE the Mirror was known to fire, so a
        // reflected Wrong Turn could stack a second one onto an attacker who
        // already had one active. Checked before the Mirror is consumed so a
        // rejected bounce leaves the Mirror intact and the item HELD. Skipped
        // when the attacker holds active socks: the bounce is blocked before
        // it could stack, so socks precedence wins over the stacking 400.
        if (type === "WRONG_TURN") {
          const attackerSocks = await effectModel.findActiveByTypeForParticipant(
            myParticipant.id,
            "COMPRESSION_SOCKS"
          );
          if (!attackerSocks) {
            const existingWT = await effectModel.findActiveByTypeForParticipant(
              myParticipant.id,
              "WRONG_TURN"
            );
            if (existingWT) {
              throw new PowerupUseError("Target already has an active Wrong Turn", 400);
            }
          }
        }

        reflected = true;
        // Consume/expire the Mirror.
        await effectModel.update(mirror.id, { status: "EXPIRED" });

        const originalAttacker = myParticipant;
        const originalTarget = targetParticipant;
        const originalAttackerUserId = userId;
        const originalTargetUserId = resolvedTargetUserId;
        const originalAttackerName = myDisplayName;
        const originalTargetName = targetDisplayName;

        // Swap roles: the effect now applies to the original attacker, sourced
        // by the original target. Re-bind the variables the switch reads below.
        myParticipant = originalTarget;
        targetParticipant = originalAttacker;
        resolvedTargetUserId = originalAttackerUserId;
        myDisplayName = originalTargetName;
        targetDisplayName = originalAttackerName;
        // The acting user (for source attribution) becomes the original target.
        actingUserId = originalTargetUserId;

        await eventModel.create({
          raceId,
          actorUserId: originalTargetUserId,
          eventType: "POWERUP_REFLECTED",
          powerupType: type,
          targetUserId: originalAttackerUserId,
          description: `${originalTargetName}'s Mirror reflected ${originalAttackerName}'s ${levelPrefix(upgradeLevel)}${POWERUP_NAMES[type]} back at them!`,
        });

        events.emit("POWERUP_REFLECTED", {
          raceId,
          attackerUserId: originalAttackerUserId,
          defenderUserId: originalTargetUserId,
          reflectedType: type,
          upgradeLevel,
        });
      }
    }

    // Decoy shield block (§3.5). Shield-chain order: Mirror → Decoy → Socks. Runs
    // only when the attack was NOT reflected (Mirror takes precedence). A Decoy on
    // the target redirects the next SINGLE-TARGET attack to a random third party;
    // the Decoy is consumed. If no eligible third party exists (2-player race),
    // the Decoy behaves as a block (attack fizzles, Decoy consumed). The redirected
    // victim then gets the full normal treatment INCLUDING their own Mirror/Socks
    // (one redirect max — a second Decoy on the new victim does not chain): their
    // Socks is caught by the block below (targetParticipant now points at them),
    // and their Mirror is handled here.
    if (!reflected && OFFENSIVE_TYPES.includes(type) && targetParticipant) {
      const decoy = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "DECOY"
      );
      if (decoy) {
        await effectModel.update(decoy.id, { status: "EXPIRED" });
        const holder = targetParticipant;
        const redirect = pickDecoyRedirectVictim({
          acceptedParticipants,
          isAliveTarget,
          attackerUserId: userId,
          holderParticipant: holder,
          isTeamRace,
          random,
        });
        if (!redirect) {
          // Fizzle as a block: consume the item, create no effect.
          await powerupModel.update(powerupId, {
            status: "USED",
            usedAt: now(),
            targetUserId: resolvedTargetUserId,
            upgradeLevel,
          });
          await eventModel.create({
            raceId,
            actorUserId: holder.userId,
            eventType: "POWERUP_BLOCKED",
            powerupType: type,
            targetUserId: userId,
            description: `${holder.user?.displayName || "A runner"}'s Decoy absorbed ${myDisplayName}'s ${POWERUP_NAMES[type]}!`,
          });
          events.emit("POWERUP_BLOCKED", {
            raceId,
            attackerUserId: userId,
            defenderUserId: holder.userId,
            blockedType: type,
            upgradeLevel,
          });
          await invalidateRaceProgress(raceId);
          await enqueueRaceResolution({ raceId, userId, timeZone, reason: "POWERUP_MUTATION", powerupTypes: [type], priority: "IMMEDIATE" });
          if (inlineResolveInjected) await resolveRaceState({ raceId, timeZone });
          await repairRacePowerupInventory({ raceId, userId, refresh: true });
          return {
            blocked: true,
            blockedBy: "DECOY",
            outcome: "BLOCKED",
            upgradeLevel,
            coinsSpent: costCoins,
          };
        }
        // Redirect the attack onto the new victim.
        targetParticipant = redirect;
        resolvedTargetUserId = redirect.userId;
        targetDisplayName = redirect.user?.displayName || "a runner";
        decoyRedirectedToUserId = redirect.userId;

        // The redirected victim's OWN Mirror still reflects (one redirect max, so
        // no further Decoy is consulted). SHOP_POWERUP_TYPES are never reflected.
        if (!SHOP_POWERUP_TYPES.includes(type)) {
          const newMirror = await effectModel.findActiveByTypeForParticipant(
            redirect.id,
            "MIRROR"
          );
          if (newMirror) {
            // Same post-swap Wrong Turn re-check as the primary Mirror block
            // above, applied to the redirected victim's Mirror bounce — and the
            // same socks-precedence skip: an attacker holding active socks has
            // the bounce blocked below, so stacking can never happen.
            if (type === "WRONG_TURN") {
              const attackerSocks = await effectModel.findActiveByTypeForParticipant(
                myParticipant.id,
                "COMPRESSION_SOCKS"
              );
              if (!attackerSocks) {
                const existingWT = await effectModel.findActiveByTypeForParticipant(
                  myParticipant.id,
                  "WRONG_TURN"
                );
                if (existingWT) {
                  throw new PowerupUseError("Target already has an active Wrong Turn", 400);
                }
              }
            }

            reflected = true;
            await effectModel.update(newMirror.id, { status: "EXPIRED" });
            const originalAttacker = myParticipant;
            const originalTarget = redirect;
            const originalAttackerUserId = userId;
            const originalAttackerName = myDisplayName;
            const originalTargetName = redirect.user?.displayName || "a runner";
            myParticipant = originalTarget;
            targetParticipant = originalAttacker;
            resolvedTargetUserId = originalAttackerUserId;
            myDisplayName = originalTargetName;
            targetDisplayName = originalAttackerName;
            actingUserId = redirect.userId;
            await eventModel.create({
              raceId,
              actorUserId: redirect.userId,
              eventType: "POWERUP_REFLECTED",
              powerupType: type,
              targetUserId: originalAttackerUserId,
              description: `${originalTargetName}'s Mirror reflected the redirected ${POWERUP_NAMES[type]} back at ${originalAttackerName}!`,
            });
            events.emit("POWERUP_REFLECTED", {
              raceId,
              attackerUserId: originalAttackerUserId,
              defenderUserId: redirect.userId,
              reflectedType: type,
              upgradeLevel,
            });
          }
        }
      }
    }

    // Compression Socks shield on the current landing target. On the direct
    // path this is the (possibly Decoy-redirected) victim. After a Mirror
    // reflect, targetParticipant has been swapped to the ORIGINAL ATTACKER —
    // so this same check is what lets an attacker's own active socks block
    // the bounced attack (Mirror consumed above, socks consumed here, effect
    // lands on no one).
    if (OFFENSIVE_TYPES.includes(type) && targetParticipant) {
      const shield = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "COMPRESSION_SOCKS"
      );

      if (shield) {
        // Shield blocks the attack. Coins (if any) are already deducted —
        // per design, upgrade cost is forfeit on a blocked attack.
        await effectModel.update(shield.id, { status: "BLOCKED" });
        await powerupModel.update(powerupId, {
          status: "USED",
          usedAt: now(),
          targetUserId: resolvedTargetUserId,
          upgradeLevel,
        });

        // Post-reflect, the "attacker" of the bounced hit is the Mirror holder
        // (actingUserId) and the blocker is the original caster — attribute the
        // feed event and emit accordingly. actingUserId === userId when no
        // reflect happened, so the direct path is unchanged.
        await eventModel.create({
          raceId,
          actorUserId: resolvedTargetUserId,
          eventType: "POWERUP_BLOCKED",
          powerupType: type,
          targetUserId: actingUserId,
          description: reflected
            ? `${targetDisplayName}'s Compression Socks blocked the reflected ${levelPrefix(upgradeLevel)}${POWERUP_NAMES[type]}!`
            : `${targetDisplayName}'s Compression Socks blocked ${myDisplayName}'s ${levelPrefix(upgradeLevel)}${POWERUP_NAMES[type]}!`,
        });

        if (upgradeLevel > 0) {
          await upgradeEventModel.create({
            raceId,
            userId,
            powerupId,
            powerupType: type,
            tier: upgradeLevel,
            costCoins,
            status: "BLOCKED",
            targetUserId: resolvedTargetUserId,
          });
        }

        events.emit("POWERUP_BLOCKED", {
          raceId,
          attackerUserId: actingUserId,
          defenderUserId: resolvedTargetUserId,
          blockedType: type,
          upgradeLevel,
        });

        // `outcome` is an additive discriminator for clients (a later feature
        // builds a reveal modal off it). Old clients keep reading `blocked`.
        // On a reflected-then-blocked hit both discriminators are set: new
        // clients render the combined "bounced but blocked" modal; frozen old
        // clients switch on outcome and show the plain blocked modal.
        return {
          blocked: true,
          blockedBy: "COMPRESSION_SOCKS",
          outcome: "BLOCKED",
          ...(reflected ? { reflected: true, reflectedBy: "MIRROR" } : {}),
          ...(decoyRedirectedToUserId && !reflected
            ? { redirected: true, redirectedBy: "DECOY", redirectedToUserId: decoyRedirectedToUserId }
            : {}),
          upgradeLevel,
          coinsSpent: costCoins,
        };
      }
    }

    // IMPOSTER Compression Socks block. Imposter is not in OFFENSIVE_TYPES (it
    // never touches the target's steps and applies onSelf), so it bypasses the
    // block above — but the product rule is that Compression Socks DOES defend
    // against it: swapping leaderboard slots with a shielded rival is refused.
    // Imposter is never reflectable (it is in SHOP_POWERUP_TYPES and not
    // offensive), so there is no Mirror interaction here. Imposter is
    // non-upgradeable, so upgradeLevel is 0 and no coins were spent — nothing to
    // forfeit and no upgrade event to write.
    if (type === "IMPOSTER" && imposterTargetParticipant) {
      const shield = await effectModel.findActiveByTypeForParticipant(
        imposterTargetParticipant.id,
        "COMPRESSION_SOCKS"
      );
      if (shield) {
        await effectModel.update(shield.id, { status: "BLOCKED" });
        await powerupModel.update(powerupId, {
          status: "USED",
          usedAt: now(),
          targetUserId: resolvedTargetUserId,
          upgradeLevel,
        });

        await eventModel.create({
          raceId,
          actorUserId: resolvedTargetUserId,
          eventType: "POWERUP_BLOCKED",
          powerupType: type,
          targetUserId: userId,
          description: `${targetDisplayName}'s Compression Socks blocked ${myDisplayName}'s ${POWERUP_NAMES[type]}!`,
        });

        events.emit("POWERUP_BLOCKED", {
          raceId,
          attackerUserId: userId,
          defenderUserId: resolvedTargetUserId,
          blockedType: type,
          upgradeLevel,
        });

        return {
          blocked: true,
          blockedBy: "COMPRESSION_SOCKS",
          outcome: "BLOCKED",
          upgradeLevel,
          coinsSpent: costCoins,
        };
      }
    }

    // Apply the powerup effect
    const currentTime = now();
    let result = { blocked: false, upgradeLevel, coinsSpent: costCoins };
    if (reflected) {
      result.reflected = true;
      result.reflectedBy = "MIRROR";
      result.outcome = "REFLECTED";
    } else if (decoyRedirectedToUserId) {
      // §3.5: a single-target attack that hit a Decoy and was redirected (and NOT
      // then reflected by the new victim's Mirror, handled above).
      result.redirected = true;
      result.redirectedBy = "DECOY";
      result.redirectedToUserId = decoyRedirectedToUserId;
      result.outcome = "REDIRECTED";
    } else {
      result.outcome = "APPLIED";
    }

    switch (type) {
      case "LEG_CRAMP": {
        // Item 14 — reset, never stack. On a Mirror/Decoy reflect
        // targetParticipant has already been swapped to the original attacker,
        // who may well be cramped already; the top-of-function pre-check never
        // saw them.
        await clearActiveLegCramps(effectModel, targetParticipant.id);
        // LC×WT mutual exclusion for INDIRECT landings (direct uses were
        // rejected by the pre-check): a reflected/redirected cramp landing on
        // a wrong-turned racer cancels the reversal. Truncate expiresAt as
        // well as flipping status — scoring reads EXPIRED rows over
        // [startsAt, expiresAt].
        const conflictingWT = await effectModel.findActiveByTypeForParticipant(
          targetParticipant.id,
          "WRONG_TURN"
        );
        if (conflictingWT) {
          await effectModel.update(conflictingWT.id, {
            status: "EXPIRED",
            expiresAt: currentTime,
          });
        }
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "LEG_CRAMP",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("LEG_CRAMP", upgradeLevel)),
          metadata: { stepsAtFreezeStart: targetParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Leg Cramp on ${targetDisplayName}! Their steps are frozen for ${hoursText("LEG_CRAMP", upgradeLevel)}.`,
        });
        break;
      }

      case "SIGNAL_JAMMER": {
        // Park a 1h "can't use powerups" debuff on the target. On a Mirror
        // reflect, targetParticipant/resolvedTargetUserId/actingUserId were
        // swapped above, so the jam lands on the original attacker instead. The
        // jam guard at the top of usePowerup is what actually enforces it.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "SIGNAL_JAMMER",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + SIGNAL_JAMMER_DURATION_MS),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} jammed ${targetDisplayName}'s signal! They can't use powerups for 1 hour.`,
        });
        break;
      }

      case "LEECH": {
        // Store-bought, leecher-driven ZERO-SUM transfer. Park a LEECH
        // effect on the victim, sourced by the leecher. The actual transfer is
        // computed in getRaceProgress from the LEECHER's (sourceUserId) in-window
        // steps as floor(steps / ratio), UNCAPPED (bounded only by the victim's
        // balance) — NOT here. Metadata carries `{ ratio, scoringVersion }`; the
        // scorer reads `ratio`, defaulting absent metadata to 2, so old rows adopt
        // the new rule immediately. As a shop powerup it can never be reflected
        // (SHOP_POWERUP_TYPES), and the OFFENSIVE Compression Socks block above
        // already protected a shielded victim (no effect created). NOT stealthy:
        // the effect targets the victim (renders on their row) and the POWERUP_USED
        // event below drives the victim's push notification.
        // §7.5: the window length is chosen from the REQUEST's capabilities, so a
        // frozen binary keeps creating (and describing) the 30-minute effect it
        // knows about while a powerups3 build gets the 60-minute product.
        const leechDurationMs = requestHasFeature(clientFeatures, "powerups3")
          ? LEECH_DURATION_MS
          : LEGACY_LEECH_DURATION_MS;
        const leechMinutes = Math.round(leechDurationMs / (60 * 1000));
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "LEECH",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + leechDurationMs),
          metadata: { ratio: LEECH_RATIO, scoringVersion: LEECH_SCORING_VERSION },
        });
        result.effect = effect;
        result.durationMs = leechDurationMs;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} is leeching ${targetDisplayName}! Every 2 steps ${myDisplayName} takes steals 1 from ${targetDisplayName} for ${leechMinutes} minutes.`,
        });
        break;
      }

      case "HITCHHIKE": {
        // Store-bought, TARGET-driven ADDITIVE copy (§7). Park a 60-minute link on
        // the walked-on racer, sourced by the hitchhiker. The copy itself is
        // computed in src/utils/hitchhikeCopies.js from the TARGET's in-window
        // steps as floor(steps * copyRatio) — NOT here — and is inserted into the
        // caster's preLeechTotal at every scoring-assembly site. The target's own
        // steps are never touched. As a shop powerup it can never be reflected
        // (SHOP_POWERUP_TYPES), and the OFFENSIVE Compression Socks block above
        // already protected a shielded target (no effect created). NOT stealthy:
        // the effect targets the walked-on racer (renders on their row) and the
        // POWERUP_USED event below drives their push.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "HITCHHIKE",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + HITCHHIKE_DURATION_MS),
          metadata: {
            copyRatio: HITCHHIKE_COPY_RATIO,
            scoringVersion: requestHasFeature(clientFeatures, "hitchhike_effective_steps")
              ? HITCHHIKE_EFFECTIVE_SCORING_VERSION
              : HITCHHIKE_LEGACY_SCORING_VERSION,
          },
        });
        result.effect = effect;
        result.durationMs = HITCHHIKE_DURATION_MS;
        result.copyRatio = HITCHHIKE_COPY_RATIO;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} hitched a ride on ${targetDisplayName}! Every step ${targetDisplayName} takes for the next hour is copied to ${myDisplayName}. ${targetDisplayName} loses nothing.`,
        });
        break;
      }

      case "QUICK_RINSE": {
        // Self-only, instantaneous: HALVE the remaining duration of every active
        // timed opponent-inflicted effect on the user (§8.1). Eligibility was
        // resolved (and an empty set rejected) before consumption.
        //
        // Rows stay ACTIVE with a nearer expiry rather than being expired
        // outright — normal expiry processing ends them at the new instant. The
        // new expiresAt is ALWAYS > now, so this is strictly non-retroactive: no
        // already-closed scoring bucket (a Hitchhike copy, a Leech transfer) is
        // ever clawed back.
        const affectedEffects = [];
        for (const effect of quickRinseTargets) {
          const remainingMs =
            new Date(effect.expiresAt).getTime() - currentTime.getTime();
          const newExpiresAt = new Date(
            currentTime.getTime() +
              Math.floor(remainingMs * QUICK_RINSE_REDUCTION_FRACTION)
          );
          await effectModel.update(effect.id, { expiresAt: newExpiresAt });
          affectedEffects.push({
            id: effect.id,
            type: effect.type,
            expiresAt: newExpiresAt,
          });
        }
        result.shortened = affectedEffects.length;
        result.reductionFraction = QUICK_RINSE_REDUCTION_FRACTION;
        result.affectedEffects = affectedEffects;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used Quick Rinse! ${affectedEffects.length} debuff${affectedEffects.length === 1 ? "" : "s"} cut in half.`,
          metadata: { shortened: affectedEffects.length },
        });
        break;
      }

      case "DEFENSE_SCAN": {
        // X-Ray: an instantaneous intel read. Creates NO effect and writes NO
        // feed event (silent recon). It consumes one scanner (marked USED below)
        // and returns a snapshot of every opponent's active defenses in the
        // response. In team races "opponents" means the enemy team only.
        const scanTargets = acceptedParticipants.filter(
          (p) => p.userId !== userId && isEnemy(p)
        );
        const opponents = [];
        for (const opp of scanTargets) {
          const oppEffects = await effectModel.findActiveForParticipant(opp.id);
          const defenses = oppEffects
            .filter(
              (e) =>
                e.type === "COMPRESSION_SOCKS" ||
                e.type === "MIRROR" ||
                e.type === "DECOY"
            )
            .map((e) => ({ type: e.type, expiresAt: e.expiresAt }));
          opponents.push({
            userId: opp.userId,
            displayName: opp.user?.displayName || "A runner",
            defenses,
          });
        }
        result.scan = {
          expiresAtSnapshot: currentTime.toISOString(),
          opponents,
        };
        break;
      }

      case "RED_CARD": {
        const leaderSteps = targetParticipant.totalSteps;
        const penalty = Math.round(leaderSteps * RED_CARD_PERCENT);

        await participantModel.subtractBonusSteps(targetParticipant.id, penalty);

        result.penalty = penalty;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} used Red Card on ${targetDisplayName}! They lost ${penalty.toLocaleString()} steps.`,
          metadata: { penalty },
        });
        break;
      }

      case "SHORTCUT": {
        const targetEffective = Math.max(0, targetParticipant.totalSteps);
        const stealCap = upgradedMagnitude("SHORTCUT", upgradeLevel);
        const stolen = Math.min(stealCap, targetEffective);

        if (stolen > 0) {
          await participantModel.subtractBonusSteps(targetParticipant.id, stolen);
          await participantModel.addBonusSteps(myParticipant.id, stolen);
        }

        result.stolen = stolen;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} stole ${stolen.toLocaleString()} steps from ${targetDisplayName} with ${levelPrefix(upgradeLevel)}Shortcut!`,
          metadata: { stolen },
        });
        break;
      }

      case "COMPRESSION_SOCKS": {
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "COMPRESSION_SOCKS",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("COMPRESSION_SOCKS", upgradeLevel)),
        });
        result.effect = effect;

        // Socks activation is intentionally SILENT, exactly like MIRROR below:
        // no POWERUP_USED feed event, so rivals aren't tipped off that a shield
        // is armed. Announcing it just told everyone to hold their attack (or to
        // burn a cheap one to strip the shield), which defeats the item. The
        // shield lives entirely on the RacePowerupEffect row above; the
        // after-the-fact POWERUP_BLOCKED event still fires when an attack is
        // actually blocked, and by then both players already know. No push is
        // sent for socks either (the POWERUP_USED handler allowlists offensive
        // types and requires a target), so notificationHandlers needs no change.
        break;
      }

      case "MIRROR": {
        // Modeled on Compression Socks: a self-applied, held shield-like buff
        // with the same active-shield duration (24h). When active, the reflect
        // pre-check above bounces an incoming offensive powerup back at the
        // attacker. Non-upgradeable, so duration is a fixed constant.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "MIRROR",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + MIRROR_DURATION_MS),
        });
        result.effect = effect;

        // Mirror activation is intentionally SILENT (mirrors the IMPOSTER case):
        // no POWERUP_USED feed event is written, so other participants aren't
        // tipped off that a reflect is armed. The shield lives entirely on the
        // RacePowerupEffect row above; the separate POWERUP_REFLECTED event
        // (written when an attack is actually bounced) is unaffected. No push is
        // sent for Mirror, so notificationHandlers needs no change.
        break;
      }

      case "CLEANSE": {
        // Self-only: clear ALL opponent-inflicted debuffs currently active on
        // the user. An opponent-inflicted debuff is an ACTIVE effect on the
        // user's participant whose sourceUserId !== targetUserId (someone else
        // applied it) — this covers timed debuffs (LEG_CRAMP, WRONG_TURN,
        // DETOUR_SIGN) and a TRAIL_MINE penalty placed on the user. The user's
        // OWN self-buffs (sourceUserId === targetUserId, e.g. COMPRESSION_SOCKS,
        // RUNNERS_HIGH, STEALTH_MODE, MIRROR) are NEVER touched.
        const activeEffects = await effectModel.findActiveForParticipant(myParticipant.id);
        const opponentDebuffs = activeEffects.filter(
          (e) => isCleansableDebuff(e, userId)
        );
        for (const debuff of opponentDebuffs) {
          // Truncate expiresAt to NOW as well as flipping status. Step
          // resolution computes a timed debuff's freeze window from
          // [startsAt, expiresAt] and reads EXPIRED rows too, so leaving the
          // original (future) expiresAt would keep freezing/reversing steps for
          // the full original duration even after Cleanse. Ending the window
          // here stops the effect at the cleanse moment.
          await effectModel.update(debuff.id, {
            status: "EXPIRED",
            expiresAt: currentTime,
          });
        }
        result.cleared = opponentDebuffs.length;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_CLEANSE",
          powerupType: type,
          description: opponentDebuffs.length > 0
            ? `${myDisplayName} used Cleanse! Cleared ${opponentDebuffs.length} debuff${opponentDebuffs.length === 1 ? "" : "s"}.`
            : `${myDisplayName} used Cleanse! No debuffs to clear.`,
          metadata: { cleared: opponentDebuffs.length },
        });
        break;
      }

      case "IMPOSTER": {
        // Purely COSMETIC: create a self-applied (onSelf) effect on the acting
        // user's participant that records, in metadata.swapWithUserId, the rival
        // whose leaderboard DISPLAY slot they swap with for 1 hour. No steps
        // change. The swap is applied ONLY in the getRaceProgress display path
        // (NOT in settlement), and reverts when this effect expires.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "IMPOSTER",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + IMPOSTER_DURATION_MS),
          metadata: { swapWithUserId: resolvedTargetUserId },
        });
        result.effect = effect;
        result.swapWithUserId = resolvedTargetUserId;

        // Imposter is intentionally STEALTHY: do NOT write an activity-log event,
        // so other participants are not notified that a position swap happened.
        // The swap itself lives on the RacePowerupEffect row above (applied only
        // in the getRaceProgress display path), so omitting the event is safe.
        break;
      }

      case "RAINSTORM": {
        // Untargeted AoE debuff: every OTHER active (unfinished) participant's
        // step accrual counts for RAINSTORM_MULTIPLIER (0.5x) for 1 hour. The
        // caster is never affected by their own storm. Rainstorm is a shop-only
        // powerup, so per the shop-powerup rule it can NEVER be reflected by a
        // Mirror — a victim's Mirror does not protect them from the rain and is
        // NOT consumed. The only per-victim defense is:
        //   * COMPRESSION_SOCKS: consumed (BLOCKED); that victim is protected.
        // Coins/upgrades don't apply (purchase-only, non-upgradeable).
        const stormEnd = new Date(currentTime.getTime() + RAINSTORM_DURATION_MS);
        // Team races: rain falls on the ENEMY team only (TR-652); forfeited
        // members stay out of the fan-out (TR-657).
        // Ascending-userId fan-out (spec §5a item 7). Rainstorm is the
        // multi-target powerup path: it touches one row per victim, so it takes
        // the SAME global lock order as every other multi-row writer.
        const victims = acceptedParticipants
          .filter((p) => p.userId !== userId && isAliveTarget(p) && isEnemy(p))
          .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
        const affected = [];
        const blockedNames = [];

        for (const victim of victims) {
          const victimName = victim.user?.displayName || "A runner";

          // §3.7: an Umbrella holder is immune to the AoE rain — skipped before
          // the Socks check, and the Umbrella (a timed aura) is NOT consumed.
          const victimUmbrella = await effectModel.findActiveByTypeForParticipant(
            victim.id,
            "UMBRELLA"
          );
          if (victimUmbrella && victimUmbrella.expiresAt && new Date(victimUmbrella.expiresAt) > now()) {
            continue;
          }

          const victimShield = await effectModel.findActiveByTypeForParticipant(
            victim.id,
            "COMPRESSION_SOCKS"
          );
          if (victimShield) {
            await effectModel.update(victimShield.id, { status: "BLOCKED" });
            blockedNames.push(victimName);
            await eventModel.create({
              raceId,
              actorUserId: victim.userId,
              eventType: "POWERUP_BLOCKED",
              powerupType: type,
              targetUserId: userId,
              description: `${victimName}'s Compression Socks kept them dry through ${myDisplayName}'s Rainstorm!`,
            });
            events.emit("POWERUP_BLOCKED", {
              raceId,
              attackerUserId: userId,
              defenderUserId: victim.userId,
              blockedType: type,
              upgradeLevel,
            });
            continue;
          }

          await effectModel.create({
            raceId,
            targetParticipantId: victim.id,
            targetUserId: victim.userId,
            sourceUserId: userId,
            powerupId,
            type: "RAINSTORM",
            startsAt: currentTime,
            expiresAt: stormEnd,
            metadata: {
              multiplier: RAINSTORM_MULTIPLIER,
              stepsAtStart: victim.totalSteps,
            },
          });
          affected.push(victim.userId);
        }

        result.affected = affected.length;
        result.blockedCount = blockedNames.length;
        // Kept for wire-shape compatibility with clients that read this field;
        // Rainstorm can no longer be reflected, so it is always false now.
        result.reflectedOntoCaster = false;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} summoned a Rainstorm! Everyone else's steps count for half for 1 hour.`,
          metadata: {
            affectedCount: affected.length,
            blockedCount: blockedNames.length,
            reflectedOntoCaster: false,
          },
        });
        break;
      }

      case "PROTEIN_SHAKE": {
        const bonus = upgradedMagnitude("PROTEIN_SHAKE", upgradeLevel);
        await participantModel.addBonusSteps(myParticipant.id, bonus);
        result.bonus = bonus;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used a ${levelPrefix(upgradeLevel)}Protein Shake! +${bonus.toLocaleString()} steps.`,
          metadata: { bonus },
        });
        break;
      }

      case "RUNNERS_HIGH": {
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "RUNNERS_HIGH",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("RUNNERS_HIGH", upgradeLevel)),
          metadata: { stepsAtBuffStart: myParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated ${levelPrefix(upgradeLevel)}Runner's High! 2x steps for ${hoursText("RUNNERS_HIGH", upgradeLevel)}.`,
        });
        break;
      }

      case "SECOND_WIND": {
        // The leader rejection now runs pre-flight (see the SECOND_WIND block
        // above, beside RED_CARD's) so a rejected player provably keeps their
        // item. Reaching here means the check already passed.
        const eligible = acceptedParticipants.filter((p) => !p.finishedAt);
        const sorted = [...eligible].sort((a, b) => b.totalSteps - a.totalSteps);
        const leader = sorted[0];
        const gap = Math.max(0, leader.totalSteps - myParticipant.totalSteps);
        const bonus = Math.min(SECOND_WIND_MAX, Math.max(SECOND_WIND_MIN, Math.round(gap * SECOND_WIND_FACTOR)));

        await participantModel.addBonusSteps(myParticipant.id, bonus);
        result.bonus = bonus;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} caught a Second Wind! +${bonus.toLocaleString()} steps.`,
          metadata: { bonus, gap },
        });
        break;
      }

      case "STEALTH_MODE": {
        // Item 7: BOTH client cohorts now use the STEALTH_MODE ladder
        // (60/75/90/120 min). Modern clients (`stealth_runner_duration`) used to
        // borrow the RUNNERS_HIGH ladder for a longer stealth — that substitution
        // is removed so the nerf is uniform across every app version.
        const stealthDurationMs = upgradedDuration("STEALTH_MODE", upgradeLevel);
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "STEALTH_MODE",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + stealthDurationMs),
        });
        result.effect = effect;
        result.durationMs = stealthDurationMs;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated ${levelPrefix(upgradeLevel)}Stealth Mode! Their progress is hidden for ${durationText(stealthDurationMs)}.`,
        });
        break;
      }

      case "WRONG_TURN": {
        // Cancel active Leg Cramp on target if present. Only INDIRECT landings
        // (Mirror reflect / Decoy redirect) reach here with a cramped target —
        // direct uses are rejected by the LC×WT mutual-exclusion pre-check.
        const existingCramp = await effectModel.findActiveByTypeForParticipant(
          targetParticipant.id,
          "LEG_CRAMP"
        );
        if (existingCramp) {
          // Truncate expiresAt as well as flipping status (same as CLEANSE):
          // step resolution reads EXPIRED rows and freezes over
          // [startsAt, expiresAt], so a future expiresAt would keep freezing
          // the target for the cramp's full original duration.
          await effectModel.update(existingCramp.id, {
            status: "EXPIRED",
            expiresAt: currentTime,
          });
        }

        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "WRONG_TURN",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("WRONG_TURN", upgradeLevel)),
          metadata: { stepsAtStart: targetParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} sent ${targetDisplayName} on a ${levelPrefix(upgradeLevel)}Wrong Turn! Their steps are reversed for ${hoursText("WRONG_TURN", upgradeLevel)}.`,
          metadata: {},
        });
        break;
      }

      case "FANNY_PACK": {
        await participantModel.updatePowerupSlots(myParticipant.id, myParticipant.powerupSlots + 1);

        await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "FANNY_PACK",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + FANNY_PACK_DURATION_MS),
        });

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} equipped a Fanny Pack! Extra powerup slot unlocked for 24 hours.`,
        });
        break;
      }

      case "TRAIL_MIX": {
        const usedTypes = new Set(await powerupModel.findUsedTypesByParticipant(myParticipant.id));
        usedTypes.add("TRAIL_MIX"); // will be marked USED after switch
        const perType = upgradedMagnitude("TRAIL_MIX", upgradeLevel);
        const bonus = usedTypes.size * perType;

        await participantModel.addBonusSteps(myParticipant.id, bonus);
        result.bonus = bonus;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Trail Mix! +${bonus.toLocaleString()} steps (${usedTypes.size} unique powerups).`,
          metadata: { bonus, uniqueTypes: usedTypes.size, perType },
        });
        break;
      }

      case "DETOUR_SIGN": {
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "DETOUR_SIGN",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("DETOUR_SIGN", upgradeLevel)),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} sent ${targetDisplayName} on a ${levelPrefix(upgradeLevel)}Detour! Their leaderboard is hidden for ${hoursText("DETOUR_SIGN", upgradeLevel)}.`,
        });
        break;
      }

      case "LUCKY_HORSESHOE": {
        const minRarity = luckyMinRarity(upgradeLevel);
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "LUCKY_HORSESHOE",
          startsAt: currentTime,
          expiresAt: null,
          metadata: { minRarity, consumedOnNextBox: true },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Lucky Horseshoe! Their next mystery box is guaranteed ${minRarity.toLowerCase()} or better.`,
        });
        break;
      }

      case "CAMPFIRE_REST": {
        const multiplier = upgradedMagnitude("CAMPFIRE_REST", upgradeLevel);
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "CAMPFIRE_REST",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + CAMPFIRE_FREEZE_MS + upgradedDuration("CAMPFIRE_REST", upgradeLevel)),
          metadata: {
            freezeMs: CAMPFIRE_FREEZE_MS,
            multiplier,
            boostMs: CAMPFIRE_BOOST_MS,
            stepsAtRestStart: myParticipant.totalSteps,
          },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} settled into a ${levelPrefix(upgradeLevel)}Campfire Rest! They'll pause briefly, then get a ${multiplier}x boost.`,
        });
        break;
      }

      case "TRAIL_MAGNET": {
        const reduction = upgradedMagnitude("TRAIL_MAGNET", upgradeLevel);
        const currentThreshold = myParticipant.nextBoxAtSteps || 0;
        const nextBoxAtSteps = Math.max(0, currentThreshold - reduction);
        await participantModel.updateNextBoxAtSteps(myParticipant.id, nextBoxAtSteps);
        result.reduction = reduction;
        result.nextBoxAtSteps = nextBoxAtSteps;
        result.grantedBox = myParticipant.totalSteps >= nextBoxAtSteps;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Trail Magnet! Their next mystery box moved ${reduction.toLocaleString()} steps closer.`,
          metadata: { reduction, nextBoxAtSteps },
        });
        break;
      }

      case "POCKET_WATCH": {
        const extensionMs = upgradedDuration("POCKET_WATCH", upgradeLevel);

        // TARGETED mode (§6.1): extend EXACTLY ONE already-validated harmful
        // effect this user applied. The extension modifies an effect that already
        // passed the target's defenses, so it triggers neither Compression Socks
        // nor a Mirror. RAINSTORM writes one row per rival, so extending it
        // prolongs exactly one rival's row — the same single-effect rule as every
        // other type.
        if (pocketWatchTargetEffect) {
          const extended = new Date(
            new Date(pocketWatchTargetEffect.expiresAt).getTime() + extensionMs
          );
          await effectModel.update(pocketWatchTargetEffect.id, {
            expiresAt: extended,
          });
          result.extendedEffects = 1;
          result.extensionMs = extensionMs;
          result.extensionMode = "OWN_DEBUFF";
          result.extendedEffect = {
            id: pocketWatchTargetEffect.id,
            type: pocketWatchTargetEffect.type,
            targetUserId: pocketWatchTargetEffect.targetUserId,
            expiresAt: extended,
          };

          const rival = acceptedParticipants.find(
            (p) => p.userId === pocketWatchTargetEffect.targetUserId
          );
          const rivalName = rival?.user?.displayName || "a rival";
          await eventModel.create({
            raceId,
            actorUserId: userId,
            eventType: "POWERUP_USED",
            powerupType: type,
            targetUserId: pocketWatchTargetEffect.targetUserId,
            description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Pocket Watch! ${POWERUP_NAMES[pocketWatchTargetEffect.type] || pocketWatchTargetEffect.type} on ${rivalName} lasts longer.`,
            metadata: {
              extendedEffects: 1,
              extensionMs,
              extensionMode: "OWN_DEBUFF",
              extendedEffectId: pocketWatchTargetEffect.id,
            },
          });
          break;
        }

        // LEGACY mode — unchanged, bit for bit.
        const activeTimedEffects = (await effectModel.findActiveForParticipant(myParticipant.id))
          .filter(isPocketWatchExtendable);
        for (const effect of activeTimedEffects) {
          await effectModel.update(effect.id, {
            expiresAt: new Date(new Date(effect.expiresAt).getTime() + extensionMs),
          });
        }
        result.extendedEffects = activeTimedEffects.length;
        result.extensionMs = extensionMs;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used ${levelPrefix(upgradeLevel)}Pocket Watch! ${activeTimedEffects.length} active buff${activeTimedEffects.length === 1 ? "" : "s"} extended.`,
          metadata: { extendedEffects: activeTimedEffects.length, extensionMs },
        });
        break;
      }

      case "TRAIL_MINE": {
        const penaltyPercent = upgradedMagnitude("TRAIL_MINE", upgradeLevel);
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "TRAIL_MINE",
          startsAt: currentTime,
          expiresAt: null,
          metadata: {
            ownerParticipantId: myParticipant.id,
            positionSteps: myParticipant.totalSteps,
            penaltyPercent,
            // Runners already past the plant point, captured from the SAME
            // computed totals that produced `positionSteps` (see the read-only
            // computeRaceState call at the top of this command).
            // triggerTrailMines excludes them, so "already ahead never trips it"
            // is recorded as a fact at plant time rather than re-inferred later
            // from a stored column that other writers also advance.
            aheadParticipantIds: acceptedParticipants
              .filter(
                (p) =>
                  p.id !== myParticipant.id &&
                  (p.totalSteps || 0) >= (myParticipant.totalSteps || 0)
              )
              .map((p) => p.id),
          },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} planted a ${levelPrefix(upgradeLevel)}Trail Mine at ${myParticipant.totalSteps.toLocaleString()} steps.`,
          metadata: effect.metadata,
        });
        break;
      }

      case "PINECONE_TOSS": {
        const penalty = upgradedMagnitude("PINECONE_TOSS", upgradeLevel);
        await participantModel.subtractBonusSteps(targetParticipant.id, penalty);
        result.penalty = penalty;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} hit ${targetDisplayName} with a ${levelPrefix(upgradeLevel)}Pinecone Toss! They lost ${penalty.toLocaleString()} steps.`,
          metadata: { penalty, direction: targetDirection },
        });
        break;
      }

      case "SNEAKY_SWAP": {
        // On a Mirror reflect the roles were swapped above, so this steals
        // FROM the original attacker TO the reflecting target. The candidate
        // set is re-read (and the row conditionally claimed) inside the
        // model's transaction, so concurrent steals can't double-take a row.
        // A reflected steal can come up empty (the original attacker may hold
        // nothing stealable) — the sneaky swap is still consumed.
        const stolen = await powerupModel.stealRandomHeldPowerup({
          fromParticipantId: targetParticipant.id,
          toParticipantId: myParticipant.id,
          toUserId: myParticipant.userId,
          excludeTypes: UNSTEALABLE_TYPES,
          random,
        });
        result.swapped = true; // legacy field — old clients key success off it
        result.stolenPowerup = stolen
          ? { id: stolen.id, type: stolen.type, rarity: stolen.rarity }
          : null;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: stolen
            ? `${myDisplayName} used Sneaky Swap on ${targetDisplayName} and stole a ${POWERUP_NAMES[stolen.type] || stolen.type}!`
            : `${myDisplayName} used Sneaky Swap on ${targetDisplayName}, but found nothing to steal!`,
          metadata: stolen
            ? { stolenPowerupId: stolen.id, stolenType: stolen.type }
            : {},
        });
        break;
      }

      case "DRILL_SERGEANT": {
        // §3.9: a dare parked on the target for 2h, evaluated at EXPIRY. On a
        // Mirror reflect the roles were swapped above so it lands on the original
        // attacker. Metadata snapshots the target's steps at start; the expiry
        // branch sums their window steps and applies the penalty (or void).
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: actingUserId,
          powerupId,
          type: "DRILL_SERGEANT",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + DRILL_SERGEANT_DURATION_MS),
          metadata: {
            goalSteps: DRILL_SERGEANT_GOAL_STEPS,
            penaltySteps: DRILL_SERGEANT_PENALTY_STEPS,
            stepsAtStart: targetParticipant.totalSteps || 0,
          },
        });
        result.effect = effect;
        result.durationMs = DRILL_SERGEANT_DURATION_MS;
        result.goalSteps = DRILL_SERGEANT_GOAL_STEPS;
        result.penaltySteps = DRILL_SERGEANT_PENALTY_STEPS;
        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} dared ${targetDisplayName} with a Drill Sergeant! Hit ${DRILL_SERGEANT_GOAL_STEPS.toLocaleString()} steps in 1 hour or lose ${DRILL_SERGEANT_PENALTY_STEPS.toLocaleString()}.`,
        });
        break;
      }

      case "GHOST_PEPPER": {
        // §3.2: two-phase self buff — boost then freeze (Campfire inverted).
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "GHOST_PEPPER",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + GHOST_PEPPER_BOOST_MS + GHOST_PEPPER_FREEZE_MS),
          metadata: {
            boostMs: GHOST_PEPPER_BOOST_MS,
            multiplier: GHOST_PEPPER_MULTIPLIER,
            freezeMs: GHOST_PEPPER_FREEZE_MS,
            stepsAtBoostStart: myParticipant.totalSteps || 0,
          },
        });
        result.effect = effect;
        result.durationMs = GHOST_PEPPER_BOOST_MS + GHOST_PEPPER_FREEZE_MS;
        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} ate a Ghost Pepper! 3x steps for 30 minutes, then a 30-minute burnout.`,
        });
        break;
      }

      case "COIN_FLIP": {
        // §3.3: server rolls 50/50 → 2x (win) or 0.5x (lose), 1h.
        const win = random() < 0.5;
        const flipMultiplier = win ? 2 : 0.5;
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "COIN_FLIP",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + COIN_FLIP_DURATION_MS),
          metadata: { multiplier: flipMultiplier, stepsAtStart: myParticipant.totalSteps || 0 },
        });
        result.effect = effect;
        result.durationMs = COIN_FLIP_DURATION_MS;
        result.flip = win ? "WIN" : "LOSE";
        result.multiplier = flipMultiplier;
        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: win
            ? `${myDisplayName} flipped a coin and won! 2x steps for 1 hour.`
            : `${myDisplayName} flipped a coin and lost! Half steps for 1 hour.`,
          metadata: { flip: result.flip, multiplier: flipMultiplier },
        });
        break;
      }

      case "DECOY": {
        // §3.5: a held shield hidden from opponents; redirects the next
        // single-target attack. 24h or until consumed.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "DECOY",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + DECOY_DURATION_MS),
        });
        result.effect = effect;
        result.durationMs = DECOY_DURATION_MS;
        // Silent, like Mirror — don't tip opponents that a redirect is armed.
        break;
      }

      case "UMBRELLA": {
        // §3.7: a self timed aura granting AoE-debuff immunity, 12h.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "UMBRELLA",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + UMBRELLA_DURATION_MS),
        });
        result.effect = effect;
        result.durationMs = UMBRELLA_DURATION_MS;
        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} opened an Umbrella! Immune to area attacks for 12 hours.`,
        });
        break;
      }

      case "PIGGY_BANK": {
        // §3.10: a self 24h saver; coins are minted at the earlier of expiry or
        // settlement (env-tunable rate/cap frozen into metadata at use-time).
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "PIGGY_BANK",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + PIGGY_BANK_DURATION_MS),
          metadata: {
            stepsPerCoin: PIGGY_BANK_STEPS_PER_COIN,
            coinCap: PIGGY_BANK_COIN_CAP,
            stepsAtStart: myParticipant.totalSteps || 0,
          },
        });
        result.effect = effect;
        result.durationMs = PIGGY_BANK_DURATION_MS;
        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} cracked open a Piggy Bank! Banking coins for the next 24 hours.`,
        });
        break;
      }

      case "BOUNTY": {
        // §3.11: a placement wager on a rival ahead of the caster, settled at
        // race end. Publicly visible; creates no debuff. Row lives until race end.
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: bountyTargetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: userId,
          powerupId,
          type: "BOUNTY",
          startsAt: currentTime,
          expiresAt: race.endsAt ? new Date(race.endsAt) : null,
          metadata: {
            payoutCoins: BOUNTY_PAYOUT_COINS,
            targetUserId: resolvedTargetUserId,
          },
        });
        result.effect = effect;
        result.payoutCoins = BOUNTY_PAYOUT_COINS;
        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} placed a Bounty on ${targetDisplayName}! Out-place them by race end to collect ${BOUNTY_PAYOUT_COINS} coins.`,
        });
        break;
      }

    }

    // Mark powerup as used
    await powerupModel.update(powerupId, {
      status: "USED",
      usedAt: currentTime,
      targetUserId: resolvedTargetUserId || null,
      upgradeLevel,
    });

    if (upgradeLevel > 0) {
      await upgradeEventModel.create({
        raceId,
        userId,
        powerupId,
        powerupType: type,
        tier: upgradeLevel,
        costCoins,
        status: "APPLIED",
        targetUserId: resolvedTargetUserId || null,
      });
    }

    events.emit("POWERUP_USED", {
      raceId,
      userId,
      powerupType: type,
      targetUserId: resolvedTargetUserId,
      upgradeLevel,
      stealthed: await casterStealthed(),
    });

    await invalidateRaceProgress(raceId);

    await enqueueRaceResolution({ raceId, userId, timeZone, reason: "POWERUP_MUTATION", powerupTypes: [type], priority: "IMMEDIATE" });
    if (inlineResolveInjected) await resolveRaceState({ raceId, timeZone });
    await repairRacePowerupInventory({ raceId, userId, refresh: true });

    // §6b — a self-buff is the common cause of a high-multiplier spike. Recompute
    // the CASTER's current (buff-only) multiplier and run the shared evaluator so
    // the "🔥 stacked at Nx" push fires immediately on the cast (the progress
    // recompute path additionally folds in global events and handles re-arm).
    // Best-effort: a push-eval failure must never fail the powerup use.
    try {
      if (race.powerupsEnabled) {
        // The cast and its resolution enqueue can overlap race expiry/forfeit
        // or another evaluator. Re-read the minimal current caster row at the
        // call site: cached finish/forfeit/dedup state would incorrectly emit
        // or re-arm from the pre-cast snapshot.
        const freshCaster =
          typeof participantModel.findHighMultiplierContext === "function"
            ? await participantModel.findHighMultiplierContext(raceId, userId)
            : typeof participantModel.findByRaceAndUser === "function"
              ? await participantModel.findByRaceAndUser(raceId, userId)
              : casterParticipant;
        if (freshCaster && !freshCaster.finishedAt && !freshCaster.forfeitedAt) {
          const casterEffects = await effectModel.findActiveForParticipant(freshCaster.id);
          const casterMult = signedMultiplierForEffects(casterEffects, now().getTime());
          const others = acceptedParticipants.filter((p) => p.userId !== userId);
          await evaluateHighMultiplierAlert({
            participant: freshCaster,
            currentMultiplier: casterMult,
            race,
            otherParticipants: others,
            now,
          });
        }
      }
    } catch (err) {
      console.error("high-multiplier alert (usePowerup) failed:", err);
    }

    return result;
  };

  // Item 12 wrapper: on a rejected use, hand a REDEEMED powerup back to the
  // general inventory (see refundRedeemedOnRejection). The core always throws
  // before mark-USED, so the row is still HELD and safe to refund. Best-effort —
  // never let a refund error replace the original PowerupUseError.
  return async function usePowerup(args) {
    try {
      return await usePowerupCore(args);
    } catch (err) {
      if (err instanceof PowerupUseError && !err.retainHeld) {
        try {
          await refundRedeemedOnRejection({
            db,
            powerupModel,
            userId: args.userId,
            raceId: args.raceId,
            powerupId: args.powerupId,
          });
        } catch (refundErr) {
          console.error("usePowerup redeemed-refund failed:", refundErr);
        }
      }
      throw err;
    }
  };
}

const usePowerup = buildUsePowerup();

module.exports = { buildUsePowerup, usePowerup, PowerupUseError, luckyMinRarity };
