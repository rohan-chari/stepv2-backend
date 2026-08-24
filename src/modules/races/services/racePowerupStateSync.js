const { Race } = require("../models/race");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { rollPowerup: defaultRollPowerup } = require("../../powerups/commands/rollPowerup");
const { prisma: defaultPrisma } = require("../../../db");

function getCurrentSteps(participant) {
  if (!participant) return 0;
  if (participant.finishedAt) {
    return participant.finishTotalSteps ?? participant.totalSteps ?? 0;
  }
  return participant.totalSteps ?? 0;
}

function getEffectiveBoxSteps(participant) {
  const currentSteps = getCurrentSteps(participant);
  const bonus = participant?.bonusSteps || 0;
  const maxBonus = participant?.maxBonusSteps || 0;
  // If bonusSteps was reduced below its peak (e.g., Banana Peel), keep box
  // progress anchored to the high-water mark so the player does not need to
  // re-walk the lost distance.
  const bonusAnchor = Math.max(bonus, maxBonus);
  return currentSteps + Math.max(0, bonusAnchor - bonus);
}

function buildSyncRacePowerupState(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const rollPowerup = dependencies.rollPowerup || defaultRollPowerup;
  const prisma = dependencies.prisma || defaultPrisma;

  return async function syncRacePowerupState({
    raceId,
    userId,
    race: providedRace,
    boxEffectiveSteps,
    tx = null,
    advisoryLockHeld = false,
    pendingEvents = null,
  }) {
    // Callers that already have a hydrated race (e.g. recordSteps after
    // resolveRaceState) can pass it in to avoid a duplicate findById round
    // trip. The lean Race.findActiveForUser shape happens to satisfy every
    // field this function reads (id/status/powerupsEnabled/
    // powerupStepInterval + participants.[fields]+user.displayName).
    const race = providedRace || (tx
      ? await tx.race.findUnique({
          where: { id: raceId },
          include: { participants: { include: { user: { select: { displayName: true } } } } },
        })
      : await raceModel.findById(raceId));
    if (
      !race ||
      race.status !== "ACTIVE" ||
      !race.powerupsEnabled ||
      !race.powerupStepInterval
    ) {
      return {
        enabled: false,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      };
    }

    let participant = race.participants.find((entry) => entry.userId === userId);
    if (!participant || participant.status !== "ACCEPTED") {
      return {
        enabled: true,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      };
    }

    let rollResults = [];
    const currentSteps = getCurrentSteps(participant);
    // Box progress tracks RAW walked steps (immune to every buff/debuff
    // multiplier). The step paths (getRaceProgress, recordSteps,
    // recordStepSamples) compute that raw box total and pass it as
    // boxEffectiveSteps; the gate rolls ONLY when it is provided. Inventory-action
    // callers (open/use/discard) add no steps and pass nothing, so they must NOT
    // roll — rolling off the effect-sensitive total would advance next_box on
    // buffed steps and strand it once the buff expires. Any newly-due box rolls on
    // the next step sync / race view, which always passes the raw override.
    const canRoll = typeof boxEffectiveSteps === "number";

    const bonus = participant.bonusSteps || 0;
    const maxBonus = participant.maxBonusSteps || 0;
    if (bonus > maxBonus && typeof participantModel.updateMaxBonusSteps === "function") {
      if (tx) {
        await tx.raceParticipant.update({
          where: { id: participant.id },
          data: { maxBonusSteps: bonus },
        });
      } else {
        await participantModel.updateMaxBonusSteps(participant.id, bonus);
      }
    }

    // Self-heal an UN-ARMED box gate. startRace and respondToRaceInvite
    // initialize nextBoxAtSteps at their entry points, but the public/featured
    // join path (joinPublicRace) historically did not — so every seeded
    // daily/weekly-challenge joiner was stranded at the schema default (0) and
    // the gate below (nextBoxAtSteps > 0) could never fire: no in-race mystery
    // boxes ever rolled for them, no matter how far they walked.
    //
    // Arm it lazily here, anchored to the NEXT interval boundary STRICTLY ABOVE
    // the player's current raw box-effective steps. Because the new threshold is
    // above where they already are, arming mints ZERO boxes right now (the roll
    // condition boxEffectiveSteps >= nextBoxAtSteps stays false this sync);
    // boxes are earned only by walking forward, exactly like a normally
    // initialized participant. This both fixes new joiners and repairs any
    // already-stranded participant on their next sync — with no retroactive
    // minting (the hazard the box-progress design exists to avoid).
    if (canRoll && !(participant.nextBoxAtSteps > 0)) {
      const interval = race.powerupStepInterval; // > 0 (guarded above)
      const armedThreshold =
        (Math.floor(boxEffectiveSteps / interval) + 1) * interval;
      // Invariant: strictly above current box-effective => 0 immediate mint.
      if (armedThreshold > boxEffectiveSteps) {
        if (tx) {
          await tx.raceParticipant.update({
            where: { id: participant.id },
            data: { nextBoxAtSteps: armedThreshold },
          });
        } else {
          await participantModel.updateNextBoxAtSteps(
            participant.id,
            armedThreshold
          );
        }
        participant.nextBoxAtSteps = armedThreshold;
      }
    }

    // Box progress is DEBUFF-SENSITIVE by design: getEffectiveBoxSteps protects
    // only bonusSteps pushbacks (Banana Peel/Red Card/Shortcut/Pinecone/Trail
    // Mine) via the maxBonusSteps high-water. Leg Cramp (frozenSteps) and Wrong
    // Turn (reversedSteps) DO slow box earning — they reduce effectiveSteps, so
    // the counter ticks up and the player must walk back. The maxBoxProgressSteps
    // anchor that previously masked this is deprecated (it froze the countdown
    // while a player sat below their pre-debuff peak); the column is retained but
    // intentionally no longer read here.
    if (
      canRoll &&
      participant.nextBoxAtSteps > 0 &&
      boxEffectiveSteps >= participant.nextBoxAtSteps
    ) {
      rollResults = await rollPowerup({
        raceId: race.id,
        participantId: participant.id,
        userId: participant.userId,
        currentSteps,
        effectiveSteps: boxEffectiveSteps,
        nextBoxAtSteps: participant.nextBoxAtSteps,
        powerupStepInterval: race.powerupStepInterval,
        displayName: participant.user?.displayName,
        powerupSlots: participant.powerupSlots || 3,
        tx,
        advisoryLockHeld,
        pendingEvents,
      });

      const refreshedRace = tx
        ? await tx.race.findUnique({
            where: { id: raceId },
            include: { participants: true },
          })
        : await raceModel.findById(raceId);
      participant = refreshedRace?.participants.find(
        (entry) => entry.userId === userId
      );
      if (!participant) {
        return {
          enabled: true,
          newMysteryBoxes: rollResults
            .filter((result) => result.mysteryBox && !result.queued)
            .map((result) => result.mysteryBox),
          newQueuedBoxes: rollResults.filter((result) => result.queued).length,
          queuedBoxCount: 0,
        };
      }
    }

    let queuedBoxCount;
    if (tx) {
      const inventory = await tx.racePowerup.findMany({
        where: {
          participantId: participant.id,
          status: { in: ["HELD", "MYSTERY_BOX", "QUEUED"] },
        },
        orderBy: { createdAt: "asc" },
      });
      const occupiedCount = inventory.filter(
        (box) => box.status === "HELD" || box.status === "MYSTERY_BOX"
      ).length;
      const queuedBoxes = inventory.filter((box) => box.status === "QUEUED");
      const openSlots = Math.max(0, (participant.powerupSlots || 3) - occupiedCount);
      const toPromote = queuedBoxes.slice(0, openSlots);
      if (toPromote.length > 0) {
        await tx.racePowerup.updateMany({
          where: { id: { in: toPromote.map((box) => box.id) } },
          data: { status: "MYSTERY_BOX" },
        });
      }
      queuedBoxCount = queuedBoxes.length - toPromote.length;
    } else if (typeof powerupModel.findInventoryForParticipants === "function") {
      // One current-state read replaces occupied-count + queued-list + final
      // queued-count. QUEUED inventory is capped and promotions are selected in
      // the same createdAt order as the legacy methods, so the observable box
      // result is unchanged while the hot sync path sheds two round trips.
      const inventory = await powerupModel.findInventoryForParticipants(
        [participant.id],
        ["HELD", "MYSTERY_BOX", "QUEUED"]
      );
      const occupiedCount = inventory.filter(
        (box) => box.status === "HELD" || box.status === "MYSTERY_BOX"
      ).length;
      const queuedBoxes = inventory.filter((box) => box.status === "QUEUED");
      const openSlots = Math.max(
        0,
        (participant.powerupSlots || 3) - occupiedCount
      );
      const toPromote = queuedBoxes.slice(0, openSlots);
      for (const box of toPromote) {
        await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
      }
      queuedBoxCount = queuedBoxes.length - toPromote.length;
    } else {
      // Compatibility seam for injected implementations that predate the bulk
      // inventory reader.
      const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);
      const openSlots = Math.max(0, (participant.powerupSlots || 3) - occupiedCount);
      if (openSlots > 0) {
        const queuedBoxes = await powerupModel.findQueuedByParticipant(participant.id);
        const toPromote = queuedBoxes.slice(0, openSlots);
        for (const box of toPromote) {
          await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
        }
      }
      queuedBoxCount = await powerupModel.countQueuedByParticipant(
        participant.id
      );
    }

    return {
      enabled: true,
      newMysteryBoxes: rollResults
        .filter((result) => result.mysteryBox && !result.queued)
        .map((result) => result.mysteryBox),
      newQueuedBoxes: rollResults.filter((result) => result.queued).length,
      queuedBoxCount,
    };
  };
}

const syncRacePowerupState = buildSyncRacePowerupState();

module.exports = {
  buildSyncRacePowerupState,
  syncRacePowerupState,
};
