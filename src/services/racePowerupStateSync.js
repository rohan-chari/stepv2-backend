const { Race } = require("../models/race");
const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { rollPowerup: defaultRollPowerup } = require("../commands/rollPowerup");

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
  // boxDebuffOffsetSteps re-credits the steps Leg Cramp (freeze) and Wrong Turn
  // (reverse) shaved off totalSteps, so neither debuff pushes box progress
  // backward. It is recomputed every settlement (getRaceProgress /
  // raceStateResolution) from the same effect math the display uses, so the
  // gate here matches the displayed countdown. NULL/absent -> 0 -> the old
  // debuff-sensitive behavior, so older rows and lean reads are safe.
  const boxDebuffOffset = participant?.boxDebuffOffsetSteps || 0;
  return currentSteps + Math.max(0, bonusAnchor - bonus) + boxDebuffOffset;
}

function buildSyncRacePowerupState(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const rollPowerup = dependencies.rollPowerup || defaultRollPowerup;

  return async function syncRacePowerupState({ raceId, userId, race: providedRace }) {
    // Callers that already have a hydrated race (e.g. recordSteps after
    // resolveRaceState) can pass it in to avoid a duplicate findById round
    // trip. The lean Race.findActiveForUser shape happens to satisfy every
    // field this function reads (id/status/powerupsEnabled/
    // powerupStepInterval + participants.[fields]+user.displayName).
    const race = providedRace || (await raceModel.findById(raceId));
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
    const effectiveSteps = getEffectiveBoxSteps(participant);

    const bonus = participant.bonusSteps || 0;
    const maxBonus = participant.maxBonusSteps || 0;
    if (bonus > maxBonus && typeof participantModel.updateMaxBonusSteps === "function") {
      await participantModel.updateMaxBonusSteps(participant.id, bonus);
    }

    // getEffectiveBoxSteps shields box progress from EVERY backward-pushing
    // debuff: bonusSteps pushbacks (Red Card/Shortcut/Pinecone/Trail Mine) via
    // the maxBonusSteps high-water, plus Leg Cramp (freeze) and Wrong Turn
    // (reverse) via boxDebuffOffsetSteps. The countdown the client shows uses the
    // same offset, so the displayed "steps to next box" and the actual roll fire
    // together.
    if (
      participant.nextBoxAtSteps > 0 &&
      effectiveSteps >= participant.nextBoxAtSteps
    ) {
      rollResults = await rollPowerup({
        raceId: race.id,
        participantId: participant.id,
        userId: participant.userId,
        currentSteps,
        effectiveSteps,
        nextBoxAtSteps: participant.nextBoxAtSteps,
        powerupStepInterval: race.powerupStepInterval,
        displayName: participant.user?.displayName,
        powerupSlots: participant.powerupSlots || 3,
      });

      const refreshedRace = await raceModel.findById(raceId);
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

    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);
    const openSlots = Math.max(0, (participant.powerupSlots || 3) - occupiedCount);
    if (openSlots > 0) {
      const queuedBoxes = await powerupModel.findQueuedByParticipant(participant.id);
      const toPromote = queuedBoxes.slice(0, openSlots);
      for (const box of toPromote) {
        await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
      }
    }

    const queuedBoxCount = await powerupModel.countQueuedByParticipant(
      participant.id
    );

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
