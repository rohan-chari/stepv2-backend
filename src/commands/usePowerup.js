const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { eventBus } = require("../events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");

const OFFENSIVE_TYPES = ["LEG_CRAMP", "RED_CARD", "BANANA_PEEL"];
const TARGETED_TYPES = ["LEG_CRAMP", "BANANA_PEEL"];
const SELF_ONLY_TYPES = ["COMPRESSION_SOCKS", "PROTEIN_SHAKE", "RUNNERS_HIGH", "SECOND_WIND", "STEALTH_MODE"];

const EFFECT_DURATIONS = {
  LEG_CRAMP: 2 * 60 * 60 * 1000,      // 2 hours
  RUNNERS_HIGH: 3 * 60 * 60 * 1000,    // 3 hours
  STEALTH_MODE: 4 * 60 * 60 * 1000,    // 4 hours
};

const PROTEIN_SHAKE_BONUS = 1500;
const BANANA_PEEL_STEAL = 1000;
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

function buildUsePowerup(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function usePowerup({ userId, raceId, powerupId, targetUserId }) {
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

    // Red Card auto-targets leader
    let resolvedTargetUserId = targetUserId;
    if (type === "RED_CARD") {
      const sorted = [...acceptedParticipants].sort((a, b) => b.totalSteps - a.totalSteps);
      const leader = sorted[0];
      if (leader.userId === userId) {
        throw new PowerupUseError("You cannot use Red Card while you are in the lead", 400);
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
    }

    const targetDisplayName = targetParticipant?.user?.displayName || "a runner";

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
        const sorted = [...acceptedParticipants].sort((a, b) => b.totalSteps - a.totalSteps);
        const leaderSteps = sorted[0].totalSteps;
        const penalty = Math.floor(leaderSteps * RED_CARD_PERCENT);

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

      case "BANANA_PEEL": {
        const targetEffective = Math.max(0, targetParticipant.totalSteps);
        const stolen = Math.min(BANANA_PEEL_STEAL, targetEffective);

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
          description: `${myDisplayName} stole ${stolen.toLocaleString()} steps from ${targetDisplayName} with Banana Peel!`,
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
          expiresAt: null,
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
        const sorted = [...acceptedParticipants].sort((a, b) => b.totalSteps - a.totalSteps);
        const leaderSteps = sorted[0].totalSteps;
        const gap = Math.max(0, leaderSteps - myParticipant.totalSteps);
        const bonus = Math.min(SECOND_WIND_MAX, Math.max(SECOND_WIND_MIN, Math.floor(gap * SECOND_WIND_FACTOR)));

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
      type,
      targetUserId: resolvedTargetUserId,
    });

    return result;
  };
}

const usePowerup = buildUsePowerup();

module.exports = { buildUsePowerup, usePowerup, PowerupUseError };
