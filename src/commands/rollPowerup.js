const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../db");
const { eventBus } = require("../events/eventBus");

const DEFAULT_POWERUP_SLOTS = 3;
const MAX_QUEUED_BOXES = 1;

// Cap how many box thresholds a SINGLE rollPowerup call may cross. nextBoxAtSteps
// ratchets up by powerupStepInterval per crossing; a transient step-spike (later
// corrected) could otherwise mint a pile of free boxes and rocket nextBoxAtSteps
// far above the player's real steps in one sync. 50 is deliberately generous for
// a legitimate sparse-sync walk — at the common 2000-step interval that is
// 100,000 steps crossed in one sync (e.g. opening the app after a multi-day gap),
// which comfortably covers any real walker — while still bounding a runaway spike:
// nothing legitimate crosses >50 intervals between two syncs. When the cap is hit
// we break, leaving the remaining thresholds (and nextBoxAtSteps advancement) for
// subsequent syncs, so no progress is lost and idempotency is preserved.
const MAX_BOXES_PER_ROLL = 50;

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
  // RAINSTORM is purchase-only (coin store), never rolled from a mystery box,
  // so it is intentionally absent from RARITY_TIERS. Named here for feed/display.
  RAINSTORM: "Rainstorm",
  // SIGNAL_JAMMER is store-only (coin store), never rolled from a mystery box.
  // Named here so the EFFECT_EXPIRED feed text reads "Signal Jammer wore off."
  SIGNAL_JAMMER: "Signal Jammer",
  // LEECH + DEFENSE_SCAN (X-Ray) are store-only (coin store), never rolled from
  // a mystery box. Named here for feed/display (e.g. a Compression-Socks block
  // message on a Leech, or an EFFECT_EXPIRED "Leech wore off").
  LEECH: "Leech",
  DEFENSE_SCAN: "X-Ray",
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

      // Per-sync cap: count thresholds crossed in THIS call. Each loop iteration
      // advances currentThreshold (and thus nextBoxAtSteps) by one interval —
      // whether it grants, forfeits, or skips an already-earned box — so counting
      // iterations bounds exactly how far nextBoxAtSteps can move in one sync.
      let crossedThisRoll = 0;
      // Coalesce forfeits: a single big sync can cross many thresholds while the
      // inventory + queue stay full (nothing frees a slot mid-loop), which used to
      // write one identical "forfeited a mystery box" feed row per crossing —
      // flooding the activity feed. Count them here and emit ONE summary row after
      // the loop instead.
      let forfeitedCount = 0;

      while (stepsForThreshold >= currentThreshold && currentThreshold > 0) {
        if (crossedThisRoll >= MAX_BOXES_PER_ROLL) {
          // Cap reached: leave the remaining thresholds (and further nextBoxAtSteps
          // advancement) for subsequent syncs. Do NOT advance nextBoxAtSteps here.
          break;
        }
        crossedThisRoll += 1;
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
          forfeitedCount += 1;
          results.push({
            forfeited: true,
            threshold: currentThreshold,
          });
        } else {
          // Pre-check for an existing box at this threshold BEFORE inserting. A
          // duplicate insert raises a unique-constraint (P2002) error which, in
          // Postgres, ABORTS the surrounding transaction — after that every
          // further statement fails with "current transaction is aborted", so
          // the catch-and-continue below cannot recover and the whole request
          // 500s. This happens whenever nextBoxAtSteps sits at/below an
          // already-earned threshold (e.g. a remediated/reset nextBox, or a
          // legacy orphan row). The advisory lock above serializes rolls for
          // this participant, so this read has no race with a concurrent insert.
          // Skipping here advances past already-claimed thresholds WITHOUT
          // re-granting a box (no double-grant) and without crashing.
          const existing =
            typeof tx.racePowerup.findUnique === "function"
              ? await tx.racePowerup.findUnique({
                  where: {
                    participantId_earnedAtSteps: {
                      participantId,
                      earnedAtSteps: currentThreshold,
                    },
                  },
                  select: { id: true },
                })
              : null;
          if (existing) {
            currentThreshold += powerupStepInterval;
            await tx.raceParticipant.update({
              where: { id: participantId },
              data: { nextBoxAtSteps: currentThreshold },
            });
            continue;
          }

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
            // Belt-and-suspenders: the pre-check above should prevent this, but
            // if a duplicate still slips through, do NOT keep using the aborted
            // transaction (that throws 25P02). Re-throw so the whole roll rolls
            // back cleanly rather than 500-ing on a poisoned transaction.
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

      // One summary feed row for all boxes forfeited this sync (see forfeitedCount).
      if (forfeitedCount > 0) {
        const boxWord = forfeitedCount === 1 ? "mystery box" : "mystery boxes";
        await tx.racePowerupEvent.create({
          data: {
            raceId,
            actorUserId: userId,
            eventType: "POWERUP_FORFEITED",
            powerupType: "MYSTERY_BOX",
            description: `${displayName || "A runner"} forfeited ${forfeitedCount} ${boxWord} — open your queued box first!`,
          },
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

module.exports = { buildRollPowerup, rollPowerup, POWERUP_NAMES, DEFAULT_POWERUP_SLOTS, MAX_QUEUED_BOXES, MAX_BOXES_PER_ROLL };
