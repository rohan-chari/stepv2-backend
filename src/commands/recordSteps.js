const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");
const { resolveRaceState: defaultResolveRaceState } = require("../services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");

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
            })
          )
        );
      }
    }

    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps };
