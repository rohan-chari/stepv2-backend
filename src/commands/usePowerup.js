const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { User } = require("../models/user");
const { PowerupUpgradeEvent } = require("../models/powerupUpgradeEvent");
const { eventBus } = require("../events/eventBus");
const { balanceConfig } = require("../services/balanceConfig");
const { POWERUP_NAMES } = require("./rollPowerup");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const {
  isUpgradeable,
  isValidLevel,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
} = require("../utils/powerupUpgrades");
const {
  deductCoinsAtomic: defaultDeductCoinsAtomic,
  InsufficientCoinsError,
} = require("./deductCoinsAtomic");
const {
  imposterEnabled: defaultImposterEnabled,
} = require("../constants/powerupGating");

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
const OFFENSIVE_TYPES = ["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "PINECONE_TOSS", "SNEAKY_SWAP", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE"];
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
const TARGETED_TYPES = ["LEG_CRAMP", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "SNEAKY_SWAP", "IMPOSTER", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE"];
// Types Sneaky Swap can never steal: another Sneaky Swap (no steal chains) and
// unopened Mystery Boxes. Mirrors the isStealable helper in routes/races.js.
const UNSTEALABLE_TYPES = ["SNEAKY_SWAP", "MYSTERY_BOX"];
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
const HITCHHIKE_SCORING_VERSION = 1;
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

// Red Card removes 5% of the leader's steps (nerfed from 10% — heavy-player
// complaints). Server-side effect, so old clients apply the new value too.
const RED_CARD_PERCENT = 0.05;
const SECOND_WIND_MIN = 500;
const SECOND_WIND_MAX = 5000;
const SECOND_WIND_FACTOR = 0.25;

class PowerupUseError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "PowerupUseError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (INVALID_TARGET). Additive.
    if (code) this.code = code;
  }
}

function levelPrefix(upgradeLevel) {
  return upgradeLevel > 0 ? `Lvl ${upgradeLevel} ` : "";
}

function hoursText(type, upgradeLevel) {
  const hours = upgradedDuration(type, upgradeLevel) / (60 * 60 * 1000);
  return hours === 1 ? "1 hour" : `${hours} hours`;
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

function buildUsePowerup(dependencies = {}) {
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
  const resolveRaceState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  )
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;
  const now = dependencies.now || (() => new Date());
  const random = dependencies.random || Math.random;
  // Imposter kill switch (Item 3). Injectable for tests; defaults to the env
  // reader (enabled unless IMPOSTER_ENABLED="false").
  const imposterEnabled = dependencies.imposterEnabled || defaultImposterEnabled;

  return async function usePowerup({
    userId,
    raceId,
    powerupId,
    targetUserId,
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

    // Trail Mine plants at the owner's CURRENT step total, but stored totals go
    // stale between syncs. Resolve race state BEFORE reading them so the mine
    // lands at the owner's real position — off a stale total it lands behind
    // them, and the trailing resolveRaceState below could detonate it instantly
    // on a runner far behind the owner. Resolving first also freshens the
    // last-place rank check. (No-op for other powerup types.)
    if (powerup.type === "TRAIL_MINE") {
      await resolveRaceState({ raceId, timeZone });
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new PowerupUseError("Race is not active", 400);
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

    // Signal Jammer JAM GUARD (the feature's single choke point). If this
    // participant is currently jammed, they cannot USE any powerup — earned,
    // store-redeemed, or upgraded, INCLUDING another Signal Jammer (a jammed
    // player can't jam). This runs BEFORE any targeting/coin/defense/effect
    // logic and before the powerup is marked USED, so nothing is consumed on
    // rejection. Buying and redeeming go through separate commands and are
    // deliberately NOT gated here. A jam whose expiresAt has already passed (but
    // whose row is still ACTIVE because lazy expiry hasn't run) does not block.
    const activeJam = await effectModel.findActiveByTypeForParticipant(
      myParticipant.id,
      "SIGNAL_JAMMER"
    );
    if (activeJam && activeJam.expiresAt && new Date(activeJam.expiresAt) > now()) {
      const remainingMs = new Date(activeJam.expiresAt).getTime() - now().getTime();
      const remainingMin = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
      throw new PowerupUseError(
        `Your powerups are jammed for another ${remainingMin}m!`,
        409
      );
    }

    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    let myDisplayName = myParticipant.user.displayName || "A runner";
    // The user credited as the *source* of an effect. Same as userId normally;
    // on a Mirror reflect it becomes the original target (who reflects it).
    let actingUserId = userId;
    const type = powerup.type;

    // Imposter is DISABLED for now (Item 3). Reject the use with a friendly
    // message and — crucially — do NOT consume the item (this runs before coin
    // deduction and the mark-USED step, so the powerup stays HELD). Old clients
    // may still render a "use" affordance; this keeps them safe. Re-enabling is a
    // single env flip (IMPOSTER_ENABLED).
    if (type === "IMPOSTER" && !imposterEnabled()) {
      throw new PowerupUseError("Imposter is temporarily unavailable", 400);
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

    // Team races (TR-651/652/653/657): offensive/AoE/auto-target powerups only
    // ever hit the ENEMY team, and forfeited members drop out of every pool.
    const isTeamRace = race.isTeamRace === true;
    const isEnemy = (p) =>
      !isTeamRace || (p.team != null && p.team !== myParticipant.team);
    const isAliveTarget = (p) => !p.finishedAt && !p.forfeitedAt;

    // Rainstorm is untargeted (hits every other racer) and never stacks: while
    // any rainstorm is active in the race, another cannot be started. In a team
    // race the fan-out is ENEMY-ONLY (teammates stay dry — TR-652).
    if (type === "RAINSTORM") {
      if (targetUserId) {
        throw new PowerupUseError("Rainstorm hits every racer — you cannot specify a target", 400);
      }
      const raceEffects = await effectModel.findActiveForRace(raceId);
      const activeStorm = raceEffects.find((e) => e.type === "RAINSTORM");
      if (activeStorm) {
        throw new PowerupUseError("A Rainstorm is already active in this race", 400);
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
        throw new PowerupUseError("Red Card auto-targets the leader — you cannot specify a target", 400);
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
        throw new PowerupUseError("Leaders are tied — wait until the tie is broken to use Red Card", 400);
      }
      resolvedTargetUserId = leader.userId;
    }

    if (type === "PINECONE_TOSS") {
      if (targetUserId) {
        throw new PowerupUseError("Pinecone Toss targets by direction — choose front or behind", 400);
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

    let targetDisplayName =
      targetParticipant?.user?.displayName ||
      imposterTargetParticipant?.user?.displayName ||
      "a runner";

    // Reject Shortcut on a target with 0 steps — nothing to steal
    if (type === "SHORTCUT" && targetParticipant && Math.max(0, targetParticipant.totalSteps) === 0) {
      throw new PowerupUseError("Target has 0 steps — nothing to steal", 400);
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

    // Reject stacking Signal Jammer on a target that already has one active. This
    // runs BEFORE coin deduction, the Mirror/Socks pre-checks, and the mark-USED
    // step, so a rejected attacker keeps their jammer HELD (not consumed).
    if (type === "SIGNAL_JAMMER" && targetParticipant) {
      const existingJam = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "SIGNAL_JAMMER"
      );
      if (existingJam && existingJam.expiresAt && new Date(existingJam.expiresAt) > now()) {
        throw new PowerupUseError("That player is already jammed", 409);
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
          "You already have an active Hitchhike — wait for it to expire",
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
        (e) => isOpponentInflicted(e, userId) && isLiveTimedEffect(e, now())
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
      const hasOpponentDebuff = activeEffects.some((e) => isOpponentInflicted(e, userId));
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
      const targetStealth = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "STEALTH_MODE"
      );
      if (targetStealth) {
        throw new PowerupUseError("You cannot target a stealthed player", 400);
      }
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
    // reflects the attack — the socks block below is then skipped, so the socks
    // shield is NOT consumed and stays banked for a later attack (a dual-shield
    // holder gets two saves: reflect now, block next time). When the target
    // holds an active Mirror, the offensive powerup is REFLECTED back onto the
    // attacker: we swap roles so the effect lands on the original attacker,
    // consume the Mirror, and write/emit a POWERUP_REFLECTED event.
    // Shop-bought powerups (SHOP_POWERUP_TYPES) are NEVER reflectable, so they
    // skip this pre-check entirely and fall through to the Socks block below.
    let reflected = false;
    if (OFFENSIVE_TYPES.includes(type) && !SHOP_POWERUP_TYPES.includes(type) && targetParticipant) {
      const mirror = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "MIRROR"
      );
      if (mirror) {
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

    // Compression Socks shield on target. Only consulted when the attack was NOT
    // already reflected by a Mirror (Mirror takes precedence, above): a target
    // holding both reflects this hit and keeps the socks for next time. After a
    // reflect, targetParticipant has been swapped to the original attacker, so
    // the `!reflected` guard is also what keeps us from checking the attacker's
    // own shields here.
    if (!reflected && OFFENSIVE_TYPES.includes(type) && targetParticipant) {
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

        await eventModel.create({
          raceId,
          actorUserId: resolvedTargetUserId,
          eventType: "POWERUP_BLOCKED",
          powerupType: type,
          targetUserId: userId,
          description: `${targetDisplayName}'s Compression Socks blocked ${myDisplayName}'s ${levelPrefix(upgradeLevel)}${POWERUP_NAMES[type]}!`,
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
          attackerUserId: userId,
          defenderUserId: resolvedTargetUserId,
          blockedType: type,
          upgradeLevel,
        });

        // `outcome` is an additive discriminator for clients (a later feature
        // builds a reveal modal off it). Old clients keep reading `blocked`.
        return {
          blocked: true,
          blockedBy: "COMPRESSION_SOCKS",
          outcome: "BLOCKED",
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
    } else {
      result.outcome = "APPLIED";
    }

    switch (type) {
      case "LEG_CRAMP": {
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
            scoringVersion: HITCHHIKE_SCORING_VERSION,
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
          description: `${myDisplayName} hitched a ride on ${targetDisplayName}! Every step ${targetDisplayName} takes for the next hour is copied to ${myDisplayName} — ${targetDisplayName} loses nothing.`,
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
              (e) => e.type === "COMPRESSION_SOCKS" || e.type === "MIRROR"
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

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated ${levelPrefix(upgradeLevel)}Compression Socks! They're shielded from the next attack.`,
        });
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
          (e) => isOpponentInflicted(e, userId)
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
        const victims = acceptedParticipants.filter(
          (p) => p.userId !== userId && isAliveTarget(p) && isEnemy(p)
        );
        const affected = [];
        const blockedNames = [];

        for (const victim of victims) {
          const victimName = victim.user?.displayName || "A runner";

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
        const eligible = acceptedParticipants.filter((p) => !p.finishedAt);
        const sorted = [...eligible].sort((a, b) => b.totalSteps - a.totalSteps);
        const leader = sorted[0];
        if (leader.userId === userId || leader.totalSteps === myParticipant.totalSteps) {
          throw new PowerupUseError("You cannot use Second Wind while you are in the lead", 400);
        }
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
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: myParticipant.id,
          targetUserId: userId,
          sourceUserId: userId,
          powerupId,
          type: "STEALTH_MODE",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + upgradedDuration("STEALTH_MODE", upgradeLevel)),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated ${levelPrefix(upgradeLevel)}Stealth Mode! Their progress is hidden for ${hoursText("STEALTH_MODE", upgradeLevel)}.`,
        });
        break;
      }

      case "WRONG_TURN": {
        // Cancel active Leg Cramp on target if present
        const existingCramp = await effectModel.findActiveByTypeForParticipant(
          targetParticipant.id,
          "LEG_CRAMP"
        );
        if (existingCramp) {
          await effectModel.update(existingCramp.id, { status: "EXPIRED" });
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
    });

    await resolveRaceState({ raceId, timeZone });
    await syncRacePowerupState({ raceId, userId });

    return result;
  };
}

const usePowerup = buildUsePowerup();

module.exports = { buildUsePowerup, usePowerup, PowerupUseError, luckyMinRarity };
