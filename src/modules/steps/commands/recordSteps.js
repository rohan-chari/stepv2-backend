const { User } = require("../../users");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { eventBus } = require("../../../shared/events/eventBus");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const { stepInputIntake: defaultStepInputIntake } = require("../services/stepInputIntake");

// Worker-owned, best-effort rival nudge computation. Step intake never calls
// this helper; the queue worker invokes it only after its fenced commit.
async function nudgeOvertakenRivals({
  raceResults,
  userId,
  userIds = null,
  participantWrites = null,
  preferHydratedRoster = false,
  participantModel,
  requestStepSyncForUsers,
  recordPhaseTiming = null,
}) {
  if (!Array.isArray(raceResults) || raceResults.length === 0) return;
  async function measure(name, operation) {
    if (typeof recordPhaseTiming !== "function") return operation();
    const startedAt = process.hrtime.bigint();
    try { return await operation(); } finally {
      try { recordPhaseTiming(name, Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)); } catch {}
    }
  }
  function measureSync(name, operation) {
    if (typeof recordPhaseTiming !== "function") return operation();
    const startedAt = process.hrtime.bigint();
    try { return operation(); } finally {
      try { recordPhaseTiming(name, Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)); } catch {}
    }
  }
  const rivalIds = new Set();
  const triggerUserIds = [...new Set(
    (Array.isArray(userIds) ? userIds : [userId]).filter(Boolean)
  )].sort();
  for (const result of raceResults) {
    if (!result?.raceId) continue;
    let participants = null;
    if (preferHydratedRoster) {
      const hydrated = result?.race?.participants;
      const projectionComplete = Array.isArray(hydrated) && hydrated.every((row) =>
        row && row.id && row.userId && row.status && row.joinedAt != null &&
        Object.prototype.hasOwnProperty.call(row, "totalSteps") &&
        Object.prototype.hasOwnProperty.call(row, "bonusSteps") &&
        Object.prototype.hasOwnProperty.call(row, "lastNotifiedPlacement")
      );
      if (projectionComplete) {
        participants = hydrated.filter((row) => row.status === "ACCEPTED")
          .map((row) => ({ ...row }));
        const byId = new Map(participants.map((row) => [row.id, row]));
        let replayUnambiguous = Array.isArray(participantWrites);
        if (replayUnambiguous) {
          for (const write of participantWrites) {
            const row = byId.get(write?.participantId);
            if (!row || !["participantTotal", "participantBonus"].includes(write.kind)) {
              replayUnambiguous = false;
              break;
            }
            if (write.kind === "participantTotal" && Number.isFinite(write.totalSteps)) {
              row.totalSteps = write.totalSteps;
            } else if (write.kind === "participantBonus" && Number.isFinite(write.amount)) {
              row.bonusSteps = Math.max(0, Number(row.bonusSteps || 0) - write.amount);
            } else {
              replayUnambiguous = false;
              break;
            }
          }
        }
        if (!replayUnambiguous) participants = null;
      }
    }
    if (!participants) {
      participants = await measure("participantLoad", () =>
        participantModel.findAcceptedByRace(result.raceId)
      );
    }
    if (!participants?.length) continue;
    measureSync("ranking", () => {
      const ranked = [...participants].sort(
        (a, b) => (b.totalSteps ?? 0) - (a.totalSteps ?? 0) ||
          new Date(a.joinedAt || 0).getTime() - new Date(b.joinedAt || 0).getTime()
      );
      const indexByUserId = new Map(ranked.map((row, index) => [row.userId, index]));
      for (const triggerUserId of triggerUserIds) {
        const userIndex = indexByUserId.get(triggerUserId);
        if (userIndex == null) continue;
        const beforeRank = ranked[userIndex].lastNotifiedPlacement;
        const afterRank = userIndex + 1;
        if (beforeRank == null || afterRank >= beforeRank) continue;
        for (let index = userIndex + 1; index < ranked.length; index += 1) {
          const rival = ranked[index];
          if (rival.userId === triggerUserId || rival.finishedAt ||
              rival.lastNotifiedPlacement == null) continue;
          if (rival.lastNotifiedPlacement < beforeRank) rivalIds.add(rival.userId);
        }
      }
    });
  }
  if (rivalIds.size > 0) {
    await measure("intentHandoff", () => requestStepSyncForUsers([...rivalIds].sort()));
  }
}

function buildRecordSteps(dependencies = {}) {
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const settings = dependencies.appSettings || defaultAppSettings;
  const stepInputIntake = dependencies.stepInputIntake || defaultStepInputIntake;

  return async function recordSteps({
    userId,
    steps,
    date,
    timeZone,
    // Frozen clients may continue sending this. Queue scheduling is permanent,
    // so the value is intentionally a compatibility no-op.
    skipRaceResolution = false,
  }) {
    void skipRaceResolution;
    const [burstCoalescing, queuedGenerationMerge] = await Promise.all([
      isStrictFlagEnabled(settings, "raceResolutionBurstCoalescingV1Enabled"),
      isStrictFlagEnabled(settings, "raceResolutionQueuedGenerationMergeV1Enabled"),
    ]);
    const result = await stepInputIntake({
      userId,
      daily: { date, steps },
      samples: null,
      timeZone,
      requestTimestamp: now(),
      endpoint: "steps",
      burstCoalescing,
      queuedGenerationMerge,
    });

    // Bookkeeping and projections intentionally remain outside the durability
    // transaction. Their failure cannot turn committed source+queue into 5xx.
    try {
      await userModel.update(userId, { lastStepSyncAt: now() });
    } catch (error) {
      console.error("steps lastStepSyncAt update failed:", error);
    }
    try {
      await require("../services/dailyStepsCache").invalidateSafe(userId, date);
    } catch (error) {
      console.error("steps daily cache invalidation failed:", error);
    }
    events.emit(result.dailyExisted ? "STEPS_UPDATED" : "STEPS_RECORDED", {
      userId,
      steps,
      date,
    });
    return {
      ...result.record,
      stepGoal: result.record.stepGoal ?? 5000,
    };
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps, nudgeOvertakenRivals };
