const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { User } = require("../models/user");
const { PowerupUpgradeEvent } = require("../models/powerupUpgradeEvent");
const { eventBus } = require("../events/eventBus");
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

const OFFENSIVE_TYPES = ["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "PINECONE_TOSS", "SNEAKY_SWAP"];
// IMPOSTER is TARGETED (it needs a rival to swap leaderboard display with) but
// it is deliberately NOT in OFFENSIVE_TYPES: it never touches the target's
// participant/steps, applies onSelf (target stored in metadata), and is purely
// cosmetic — so it is not subject to Compression Socks / Mirror interception.
const TARGETED_TYPES = ["LEG_CRAMP", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN", "SNEAKY_SWAP", "IMPOSTER"];
const IMPOSTER_DURATION_MS = 60 * 60 * 1000;
const SELF_ONLY_TYPES = [
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

const RED_CARD_PERCENT = 0.10;
const SECOND_WIND_MIN = 500;
const SECOND_WIND_MAX = 5000;
const SECOND_WIND_FACTOR = 0.25;

class PowerupUseError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "PowerupUseError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function levelPrefix(upgradeLevel) {
  return upgradeLevel > 0 ? `Lvl ${upgradeLevel} ` : "";
}

function hoursText(type, upgradeLevel) {
  const hours = upgradedDuration(type, upgradeLevel) / (60 * 60 * 1000);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function sortedActiveParticipants(participants) {
  return participants
    .filter((p) => !p.finishedAt)
    .sort((a, b) => b.totalSteps - a.totalSteps);
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

function luckyMinRarity(upgradeLevel) {
  return upgradeLevel >= 3 ? "RARE" : "UNCOMMON";
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

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new PowerupUseError("Race is not active", 400);
    }

    // `let` (not const): on a Mirror reflect these are swapped so the offensive
    // switch below applies the effect to the original attacker instead.
    let myParticipant = race.participants.find((p) => p.userId === userId && p.status === "ACCEPTED");
    if (!myParticipant) {
      throw new PowerupUseError("You are not an active participant", 403);
    }
    if (myParticipant.finishedAt) {
      throw new PowerupUseError("You have already finished the race", 400);
    }

    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    let myDisplayName = myParticipant.user.displayName || "A runner";
    // The user credited as the *source* of an effect. Same as userId normally;
    // on a Mirror reflect it becomes the original target (who reflects it).
    let actingUserId = userId;
    const type = powerup.type;

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

    // Red Card auto-targets leader
    let resolvedTargetUserId = targetUserId;
    if (type === "RED_CARD") {
      if (targetUserId) {
        throw new PowerupUseError("Red Card auto-targets the leader — you cannot specify a target", 400);
      }
      const eligible = acceptedParticipants.filter((p) => !p.finishedAt);
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
      const target = adjacentParticipant(acceptedParticipants, myParticipant, targetDirection);
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
      if (targetParticipant.finishedAt) {
        throw new PowerupUseError("Target has already finished the race", 400);
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
      if (imposterTargetParticipant.finishedAt) {
        throw new PowerupUseError("Target has already finished the race", 400);
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

    if (type === "POCKET_WATCH") {
      const activeTimedEffects = (await effectModel.findActiveForParticipant(myParticipant.id))
        .filter(isPocketWatchExtendable);
      if (activeTimedEffects.length === 0) {
        throw new PowerupUseError("Pocket Watch requires an active timed buff", 400);
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
      if (!swapOfferedPowerupId || !swapRequestedPowerupId) {
        throw new PowerupUseError("Sneaky Swap requires both powerups to swap", 400);
      }
      if (swapOfferedPowerupId === powerupId || swapRequestedPowerupId === powerupId) {
        throw new PowerupUseError("Sneaky Swap cannot swap itself", 400);
      }
      const myHeld = await powerupModel.findHeldByParticipant(myParticipant.id);
      const targetHeld = await powerupModel.findHeldByParticipant(targetParticipant.id);
      const offered = myHeld.find((p) => p.id === swapOfferedPowerupId);
      const requested = targetHeld.find((p) => p.id === swapRequestedPowerupId);
      if (!offered || !requested) {
        throw new PowerupUseError("Sneaky Swap cannot swap empty slots", 400);
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

    // Check Compression Socks shield on target
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

    // Mirror reflect pre-check. Precedence: Compression Socks (above) wins even
    // if the target also holds a Mirror — and in that case the Mirror is NOT
    // consumed (the socks-block path above returned already). If we reach here
    // and the target holds an active Mirror, the offensive powerup is REFLECTED
    // back onto the attacker: we swap roles so the effect lands on the original
    // attacker, consume the Mirror, and write/emit a POWERUP_REFLECTED event.
    let reflected = false;
    if (OFFENSIVE_TYPES.includes(type) && targetParticipant) {
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

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated Mirror! The next attack against them will be reflected back.`,
        });
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
          await effectModel.update(debuff.id, { status: "EXPIRED" });
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

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_IMPOSTER",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} pulled an Imposter on ${targetDisplayName}! Their leaderboard positions are swapped for 1 hour.`,
          metadata: { swapWithUserId: resolvedTargetUserId },
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
        await powerupModel.swapHeldPowerups(swapOfferedPowerupId, swapRequestedPowerupId);
        result.swapped = true;
        result.offeredPowerupId = swapOfferedPowerupId;
        result.requestedPowerupId = swapRequestedPowerupId;

        await eventModel.create({
          raceId,
          actorUserId: actingUserId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} used Sneaky Swap on ${targetDisplayName}!`,
          metadata: { offeredPowerupId: swapOfferedPowerupId, requestedPowerupId: swapRequestedPowerupId },
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

module.exports = { buildUsePowerup, usePowerup, PowerupUseError };
