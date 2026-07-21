const { Steps } = require("../models/steps");
const { User } = require("../../users");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { eventBus } = require("../../../shared/events/eventBus");
const { resolveRaceState: defaultResolveRaceState } = require("../../races/services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");

// When a sync moves the syncing user ahead of rival(s) on an ACTIVE race's live
// leaderboard, those rivals' displayed counts are now stale (the standings just
// changed against them). Nudge their devices to upload fresh steps so the board
// self-corrects. Detection reuses the freshly-persisted participant rows that
// resolveRaceState just wrote (one extra read per active race, mirroring
// placementRecompute): AFTER rank = index in totalSteps-desc order, BEFORE rank =
// each row's lastNotifiedPlacement (the last live rank persisted by the placement
// cron). A rival is "passed" when it now sits below the user AND its before-rank
// was ahead of the user's before-rank. requestStepSyncForUsers self-throttles
// (skips anyone synced/pushed within the last hour), which also prevents two
// rivals trading places from ping-ponging pushes. Excludes the user, finished
// participants, and rows with no known before-rank. Best-effort: any missing/null
// field just yields no nudge for that race.
async function nudgeOvertakenRivals({
  raceResults,
  userId,
  participantModel,
  requestStepSyncForUsers,
}) {
  if (!Array.isArray(raceResults) || raceResults.length === 0) return;

  const rivalIds = new Set();

  for (const result of raceResults) {
    if (!result || !result.raceId) continue;

    const participants = await participantModel.findAcceptedByRace(result.raceId);
    if (!participants || participants.length === 0) continue;

    const ranked = [...participants].sort(
      (a, b) => (b.totalSteps ?? 0) - (a.totalSteps ?? 0)
    );

    const userIndex = ranked.findIndex((p) => p.userId === userId);
    if (userIndex < 0) continue;

    const beforeRank = ranked[userIndex].lastNotifiedPlacement;
    const afterRank = userIndex + 1;

    // No prior live rank (never seeded by the cron) or the user did not climb =>
    // nobody was overtaken by this sync.
    if (beforeRank == null || afterRank >= beforeRank) continue;

    for (let i = userIndex + 1; i < ranked.length; i++) {
      const rival = ranked[i];
      if (rival.userId === userId) continue;
      if (rival.finishedAt) continue;
      if (rival.lastNotifiedPlacement == null) continue;
      // Only rivals that were ahead of the user before this sync were passed.
      if (rival.lastNotifiedPlacement < beforeRank) {
        rivalIds.add(rival.userId);
      }
    }
  }

  if (rivalIds.size > 0) {
    await requestStepSyncForUsers([...rivalIds]);
  }
}

function buildRecordSteps(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
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
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const now = dependencies.now || (() => new Date());

  return async function recordSteps({ userId, steps, date, timeZone, skipRaceResolution = false }) {
    const existing = await stepsModel.findByUserIdAndDate(userId, date);

    let record;

    if (existing) {
      record = await stepsModel.update(existing.id, { steps });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_UPDATED", { userId, steps, date });
    } else {
      record = await stepsModel.create({ userId, steps, date, stepGoal: null });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_RECORDED", { userId, steps, date });
    }

    // Step-goal coin bonuses (daily_goal_1x / daily_goal_2x) are intentionally
    // gone — replaced by the tap-to-claim StepMilestone rewards on home.

    // When the client is going to immediately POST /steps/samples after this
    // call, race resolution will run again there with fresher sample data —
    // doing it here is duplicate work. The client opts in via
    // skipRaceResolution. Old clients keep the original behavior.
    if (!skipRaceResolution) {
      const raceResults = await resolveRaceState({ userId, timeZone });
      if (Array.isArray(raceResults)) {
        await Promise.all(
          raceResults.map((result) =>
            syncRacePowerupState({
              raceId: result.raceId,
              userId,
              race: result.race,
              // Leg Cramp + Wrong Turn immune box-progress total (computed in
              // resolveRaceState) so the roll gate ignores those debuffs.
              boxEffectiveSteps: result.boxEffectiveSteps,
            })
          )
        );

        // Fire-and-forget: never awaited in the response path and never allowed
        // to fail or slow the sync (pattern mirrors modules/social/routes/friends.js).
        Promise.resolve()
          .then(() =>
            nudgeOvertakenRivals({
              raceResults,
              userId,
              participantModel,
              requestStepSyncForUsers,
            })
          )
          .catch((error) => {
            console.error("Overtake step-sync nudge error:", error);
          });
      }
    }

    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps, nudgeOvertakenRivals };
