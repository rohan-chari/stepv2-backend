const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { computeBoxEffectiveSteps } = require("../../powerups/boxSteps");

// The only reason sets this cheap plan may serve (dependency-closure spec
// rule 1, merged-reason carve-out). A coalesced STEP_SYNC + DISPLAY_REFRESH
// envelope is admitted because watched races enqueue DISPLAY_REFRESH on a ~15s
// snapshot cadence, so treating the merge as unknown demotes most big-race step
// syncs to FULL. Every other mix — including ["STEP_SYNC","BOX_OPEN"] — stays
// rejected. Deliberately a SET test: order is not significant.
const CLOSURE_ELIGIBLE_REASON_SETS = Object.freeze([
  Object.freeze(["STEP_SYNC"]),
  Object.freeze(["DISPLAY_REFRESH", "STEP_SYNC"]),
]);

// The dirty-row ceiling for a step-sync envelope. Exported because the
// dependency-closure planner gates on the SAME number: a second copy could
// drift and let the closure admit an envelope this scope would refuse.
const MAX_STEP_SYNC_DIRTY_PARTICIPANTS = 1000;

function isClosureEligibleReasonSet(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  const unique = [...new Set(reasons)].sort();
  return CLOSURE_ELIGIBLE_REASON_SETS.some(
    (candidate) =>
      candidate.length === unique.length &&
      candidate.every((reason, index) => reason === unique[index])
  );
}

async function buildRaceResolutionStepSyncScope(job, dependencies = {}) {
  if (
    !job ||
    !isClosureEligibleReasonSet(job.processingDirtyReasons) ||
    !Array.isArray(job.processingDirtyParticipantIds) ||
    job.processingDirtyParticipantIds.length === 0 ||
    job.processingDirtyParticipantIds.length > MAX_STEP_SYNC_DIRTY_PARTICIPANTS ||
    !Array.isArray(job.processingTriggeredByUserIds)
  ) return null;
  const claimStartedAt = new Date(job.startedAt || 0);
  if (Number.isNaN(claimStartedAt.getTime())) return null;
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  try {
    // SEQUENCED, not parallel — deliberately. This scope is admissible ONLY on
    // a race with zero active effects, and in prod ~79% of jobs have at least
    // one (7222 FULL vs 1709 STEP_SYNC_COMMITTED), so the parallel version
    // issued the race read and threw it away four times out of five.
    //
    // The effects read is the cheap one (a single indexed lookup) and it is the
    // one that short-circuits, so checking it FIRST costs the surviving 21% one
    // serialized round trip and saves the other 79% an entire race hydration.
    // Losing the parallelism is the intended trade.
    const activeEffects = await effectModel.findActiveForRace(job.raceId);
    if ((activeEffects || []).length > 0) return null;

    const race = await raceModel.findForStepSyncScope(job.raceId);
    if (!race || race.status !== "ACTIVE") {
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
  CLOSURE_ELIGIBLE_REASON_SETS,
  MAX_STEP_SYNC_DIRTY_PARTICIPANTS,
  isClosureEligibleReasonSet,
  buildRaceResolutionStepSyncScope,
  stepSyncScopeMatchesFence,
};
