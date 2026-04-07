const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { eventBus } = require("../events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../services/raceStateResolution");

const OFFENSIVE_TYPES = ["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN"];
const TARGETED_TYPES = ["LEG_CRAMP", "SHORTCUT", "WRONG_TURN", "DETOUR_SIGN"];
const SELF_ONLY_TYPES = ["COMPRESSION_SOCKS", "PROTEIN_SHAKE", "RUNNERS_HIGH", "SECOND_WIND", "STEALTH_MODE", "FANNY_PACK", "TRAIL_MIX"];

const EFFECT_DURATIONS = {
  LEG_CRAMP: 2 * 60 * 60 * 1000,      // 2 hours
  RUNNERS_HIGH: 3 * 60 * 60 * 1000,    // 3 hours
  STEALTH_MODE: 4 * 60 * 60 * 1000,    // 4 hours
  WRONG_TURN: 1 * 60 * 60 * 1000,      // 1 hour
  DETOUR_SIGN: 3 * 60 * 60 * 1000,    // 3 hours
  COMPRESSION_SOCKS: 24 * 60 * 60 * 1000, // 24 hours
  FANNY_PACK: 24 * 60 * 60 * 1000,        // 24 hours
};

const PROTEIN_SHAKE_BONUS = 1500;
const SHORTCUT_STEAL = 1000;
const RED_CARD_PERCENT = 0.10;
const SECOND_WIND_MIN = 500;
const SECOND_WIND_MAX = 5000;
const SECOND_WIND_FACTOR = 0.25;
const TRAIL_MIX_PER_TYPE = 500;

class PowerupUseError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "PowerupUseError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildUsePowerup(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;
  const resolveRaceState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  )
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const now = dependencies.now || (() => new Date());

  return async function usePowerup({
    userId,
    raceId,
    powerupId,
    targetUserId,
    timeZone,
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

    const myParticipant = race.participants.find((p) => p.userId === userId && p.status === "ACCEPTED");
    if (!myParticipant) {
      throw new PowerupUseError("You are not an active participant", 403);
    }
    if (myParticipant.finishedAt) {
      throw new PowerupUseError("You have already finished the race", 400);
    }

    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    const myDisplayName = myParticipant.user.displayName || "A runner";
    const type = powerup.type;

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

    const targetDisplayName = targetParticipant?.user?.displayName || "a runner";

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

    // Reject Fanny Pack if user already has expanded slots
    if (type === "FANNY_PACK") {
      if (myParticipant.powerupSlots > 3) {
        throw new PowerupUseError("You already have an active Fanny Pack", 400);
      }
    }

    // Check Compression Socks shield on target
    if (OFFENSIVE_TYPES.includes(type) && targetParticipant) {
      const shield = await effectModel.findActiveByTypeForParticipant(
        targetParticipant.id,
        "COMPRESSION_SOCKS"
      );

      if (shield) {
        // Shield blocks the attack
        await effectModel.update(shield.id, { status: "BLOCKED" });
        await powerupModel.update(powerupId, {
          status: "USED",
          usedAt: now(),
          targetUserId: resolvedTargetUserId,
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
        });

        return { blocked: true, blockedBy: "COMPRESSION_SOCKS" };
      }
    }

    // Apply the powerup effect
    const currentTime = now();
    let result = { blocked: false };

    switch (type) {
      case "LEG_CRAMP": {
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: userId,
          powerupId,
          type: "LEG_CRAMP",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.LEG_CRAMP),
          metadata: { stepsAtFreezeStart: targetParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} used Leg Cramp on ${targetDisplayName}! Their steps are frozen for 2 hours.`,
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
          actorUserId: userId,
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
        const stolen = Math.min(SHORTCUT_STEAL, targetEffective);

        if (stolen > 0) {
          await participantModel.subtractBonusSteps(targetParticipant.id, stolen);
          await participantModel.addBonusSteps(myParticipant.id, stolen);
        }

        result.stolen = stolen;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} stole ${stolen.toLocaleString()} steps from ${targetDisplayName} with Shortcut!`,
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
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.COMPRESSION_SOCKS),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated Compression Socks! They're shielded from the next attack.`,
        });
        break;
      }

      case "PROTEIN_SHAKE": {
        await participantModel.addBonusSteps(myParticipant.id, PROTEIN_SHAKE_BONUS);
        result.bonus = PROTEIN_SHAKE_BONUS;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used a Protein Shake! +${PROTEIN_SHAKE_BONUS.toLocaleString()} steps.`,
          metadata: { bonus: PROTEIN_SHAKE_BONUS },
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
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.RUNNERS_HIGH),
          metadata: { stepsAtBuffStart: myParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated Runner's High! 2x steps for 3 hours.`,
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
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.STEALTH_MODE),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} activated Stealth Mode! Their progress is hidden for 4 hours.`,
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
          sourceUserId: userId,
          powerupId,
          type: "WRONG_TURN",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.WRONG_TURN),
          metadata: { stepsAtStart: targetParticipant.totalSteps },
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} sent ${targetDisplayName} on a Wrong Turn! Their steps are reversed for 1 hour.`,
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
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.FANNY_PACK),
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
        const bonus = usedTypes.size * TRAIL_MIX_PER_TYPE;

        await participantModel.addBonusSteps(myParticipant.id, bonus);
        result.bonus = bonus;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          description: `${myDisplayName} used Trail Mix! +${bonus.toLocaleString()} steps (${usedTypes.size} unique powerups).`,
          metadata: { bonus, uniqueTypes: usedTypes.size },
        });
        break;
      }

      case "DETOUR_SIGN": {
        const effect = await effectModel.create({
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: resolvedTargetUserId,
          sourceUserId: userId,
          powerupId,
          type: "DETOUR_SIGN",
          startsAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + EFFECT_DURATIONS.DETOUR_SIGN),
        });
        result.effect = effect;

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_USED",
          powerupType: type,
          targetUserId: resolvedTargetUserId,
          description: `${myDisplayName} sent ${targetDisplayName} on a Detour! Their leaderboard is hidden for 3 hours.`,
        });
        break;
      }

    }

    // Mark powerup as used
    await powerupModel.update(powerupId, {
      status: "USED",
      usedAt: currentTime,
      targetUserId: resolvedTargetUserId || null,
    });

    events.emit("POWERUP_USED", {
      raceId,
      userId,
      powerupType: type,
      targetUserId: resolvedTargetUserId,
    });

    await resolveRaceState({ raceId, timeZone });

    return result;
  };
}

const usePowerup = buildUsePowerup();

module.exports = { buildUsePowerup, usePowerup, PowerupUseError };
