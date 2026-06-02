const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../db");
const { eventBus } = require("../events/eventBus");

const DEFAULT_POWERUP_SLOTS = 3;
const MAX_QUEUED_BOXES = 1;

const POWERUP_NAMES = {
  LEG_CRAMP: "Leg Cramp",
  RED_CARD: "Red Card",
  SHORTCUT: "Shortcut",
  COMPRESSION_SOCKS: "Compression Socks",
  PROTEIN_SHAKE: "Protein Shake",
  RUNNERS_HIGH: "Runner's High",
  SECOND_WIND: "Second Wind",
  STEALTH_MODE: "Stealth Mode",
  WRONG_TURN: "Wrong Turn",
  FANNY_PACK: "Fanny Pack",
  TRAIL_MIX: "Trail Mix",
  DETOUR_SIGN: "Detour Sign",
  LUCKY_HORSESHOE: "Lucky Horseshoe",
  CAMPFIRE_REST: "Campfire Rest",
  TRAIL_MAGNET: "Trail Magnet",
  POCKET_WATCH: "Pocket Watch",
  TRAIL_MINE: "Trail Mine",
  PINECONE_TOSS: "Pinecone Toss",
  SNEAKY_SWAP: "Sneaky Swap",
  MIRROR: "Mirror",
  CLEANSE: "Cleanse",
  // IMPOSTER is purchase-only (coin store), never rolled from a mystery box, so
  // it is intentionally absent from RARITY_TIERS. Named here for feed/display.
  IMPOSTER: "Imposter",
};

function buildRollPowerup(dependencies = {}) {
  const events = dependencies.eventBus || eventBus;
  const db = dependencies.prisma || defaultPrisma;

  return async function rollPowerup({
    raceId,
    participantId,
    userId,
    currentSteps,
    effectiveSteps,
    nextBoxAtSteps, // kept for signature compatibility; re-read inside lock
    powerupStepInterval,
    displayName,
    powerupSlots,
  }) {
    const maxSlots = powerupSlots || DEFAULT_POWERUP_SLOTS;
    const stepsForThreshold = effectiveSteps != null ? effectiveSteps : currentSteps;
    const results = [];
    const pendingEvents = [];

    await db.$transaction(async (tx) => {
      // Serialize concurrent rolls for the same participant. Released at COMMIT/ROLLBACK.
      // Doesn't block other participants or other writers of race_participants.
      // Use $executeRaw — pg_advisory_xact_lock returns Postgres `void` and the
      // pg driver adapter can't deserialize that via $queryRaw (P2010).
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${participantId})::bigint)`
      );

      // Re-read threshold inside the lock — caller's value is stale under contention.
      const fresh = await tx.raceParticipant.findUnique({
        where: { id: participantId },
        select: { nextBoxAtSteps: true },
      });
      if (!fresh) return;

      let currentThreshold = fresh.nextBoxAtSteps;

      while (stepsForThreshold >= currentThreshold && currentThreshold > 0) {
        const occupied = await tx.racePowerup.count({
          where: { participantId, status: { in: ["HELD", "MYSTERY_BOX"] } },
        });
        const queued = occupied >= maxSlots;
        const queuedCount = queued
          ? await tx.racePowerup.count({
              where: { participantId, status: "QUEUED" },
            })
          : 0;
        const forfeit = queued && queuedCount >= MAX_QUEUED_BOXES;

        if (forfeit) {
          await tx.racePowerupEvent.create({
            data: {
              raceId,
              actorUserId: userId,
              eventType: "POWERUP_FORFEITED",
              powerupType: "MYSTERY_BOX",
              description: `${displayName || "A runner"} forfeited a mystery box — open your queued box first!`,
            },
          });

          results.push({
            forfeited: true,
            threshold: currentThreshold,
          });
        } else {
          let powerup;
          try {
            powerup = await tx.racePowerup.create({
              data: {
                raceId,
                participantId,
                userId,
                type: null,
                rarity: null,
                status: queued ? "QUEUED" : "MYSTERY_BOX",
                earnedAtSteps: currentThreshold,
              },
            });
          } catch (e) {
            // Belt-and-suspenders: if a pre-existing orphan row exists for
            // (participantId, earnedAtSteps), advance the threshold instead of
            // wedging the loop. With the advisory lock above this shouldn't
            // happen for new contention, but guards against legacy bad rows.
            if (e && e.code === "P2002") {
              currentThreshold += powerupStepInterval;
              await tx.raceParticipant.update({
                where: { id: participantId },
                data: { nextBoxAtSteps: currentThreshold },
              });
              continue;
            }
            throw e;
          }

          await tx.racePowerupEvent.create({
            data: {
              raceId,
              actorUserId: userId,
              eventType: "POWERUP_EARNED",
              powerupType: "MYSTERY_BOX",
              description: queued
                ? `${displayName || "A runner"} earned a mystery box! (queued — inventory full)`
                : `${displayName || "A runner"} earned a mystery box!`,
            },
          });

          // Defer emit until after commit so subscribers see settled DB state.
          pendingEvents.push({ raceId, userId, powerupId: powerup.id });

          results.push({
            mysteryBox: { id: powerup.id },
            threshold: currentThreshold,
            queued,
          });
        }

        currentThreshold += powerupStepInterval;
        await tx.raceParticipant.update({
          where: { id: participantId },
          data: { nextBoxAtSteps: currentThreshold },
        });
      }
    });

    for (const payload of pendingEvents) {
      events.emit("POWERUP_EARNED", payload);
    }

    return results;
  };
}

const rollPowerup = buildRollPowerup();

module.exports = { buildRollPowerup, rollPowerup, POWERUP_NAMES, DEFAULT_POWERUP_SLOTS, MAX_QUEUED_BOXES };
