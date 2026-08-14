const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { computeBoxEffectiveSteps } = require("../../powerups/boxSteps");

async function buildRaceResolutionStepSyncScope(job, dependencies = {}) {
  if (
    !job ||
    !Array.isArray(job.processingDirtyReasons) ||
    job.processingDirtyReasons.length !== 1 ||
    job.processingDirtyReasons[0] !== "STEP_SYNC" ||
    !Array.isArray(job.processingDirtyParticipantIds) ||
    job.processingDirtyParticipantIds.length === 0 ||
    job.processingDirtyParticipantIds.length > 1000 ||
    !Array.isArray(job.processingTriggeredByUserIds)
  ) return null;
  const claimStartedAt = new Date(job.startedAt || 0);
  if (Number.isNaN(claimStartedAt.getTime())) return null;
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  try {
    const [race, activeEffects] = await Promise.all([
      raceModel.findById(job.raceId),
      effectModel.findActiveForRace(job.raceId),
    ]);
    if (!race || race.status !== "ACTIVE" || (activeEffects || []).length > 0) {
      return null;
    }
    const byId = new Map((race.participants || []).map((row) => [row.id, row]));
    const triggeringUsers = new Set(job.processingTriggeredByUserIds);
    const participantTokens = {};
    const participantUserIds = {};
    const boxEffectiveStepsByUser = {};
    const baseAdjustedByParticipantId = {};
    for (const participantId of job.processingDirtyParticipantIds) {
      const participant = byId.get(participantId);
      const token = new Date(participant?.totalsUpdatedAt || 0);
      if (
        !participant ||
        participant.status !== "ACCEPTED" ||
        !triggeringUsers.has(participant.userId) ||
        Number.isNaN(token.getTime()) ||
        token.getTime() > claimStartedAt.getTime() ||
        !Number.isFinite(participant.rawSteps)
      ) return null;
      participantTokens[participant.id] = token.toISOString();
      participantUserIds[participant.id] = participant.userId;
      baseAdjustedByParticipantId[participant.id] = participant.rawSteps;
      boxEffectiveStepsByUser[participant.userId] = computeBoxEffectiveSteps({
        baseAdjusted: participant.rawSteps,
        bonusSteps: participant.bonusSteps || 0,
        maxBonusSteps: participant.maxBonusSteps || 0,
      });
    }
    return {
      plan: "STEP_SYNC_COMMITTED",
      participantTokens,
      participantUserIds,
      result: {
        raceId: race.id,
        race,
        baseAdjustedByParticipantId,
        boxEffectiveStepsByUser,
      },
    };
  } catch {
    return null;
  }
}

async function stepSyncScopeMatchesFence(scope, tx, raceId) {
  const ids = Object.keys(scope?.participantTokens || {}).sort();
  if (ids.length === 0 || !tx?.$queryRawUnsafe) return false;
  const rows = await tx.$queryRawUnsafe(
    `SELECT participant.id,
            participant.user_id AS "userId",
            UPPER(participant.status::text) AS status,
            participant.totals_updated_at AS "totalsUpdatedAt",
            UPPER(race.status::text) AS "raceStatus"
     FROM race_participants participant
     JOIN races race ON race.id = participant.race_id
     WHERE participant.race_id = $2
       AND participant.id = ANY($1::text[])
     ORDER BY participant.id ASC
     FOR SHARE OF participant, race`,
    ids,
    raceId
  );
  if (rows.length !== ids.length) return false;
  return rows.every((row, index) => {
    const token = row.totalsUpdatedAt && new Date(row.totalsUpdatedAt);
    return row.id === ids[index] &&
      row.userId === scope.participantUserIds[row.id] &&
      row.status === "ACCEPTED" &&
      row.raceStatus === "ACTIVE" &&
      token && !Number.isNaN(token.getTime()) &&
      token.toISOString() === scope.participantTokens[row.id];
  });
}

module.exports = {
  buildRaceResolutionStepSyncScope,
  stepSyncScopeMatchesFence,
};
