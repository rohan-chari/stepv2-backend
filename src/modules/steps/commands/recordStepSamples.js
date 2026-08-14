const { StepSample } = require("../models/stepSample");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../../races/services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const {
  enqueueRaceResolutionForUser: defaultEnqueueRaceResolutionForUser,
} = require("../../races/services/enqueueRaceResolution");
const {
  reconcileUploaderRaces: defaultReconcileUploaderRaces,
} = require("../../races/services/reconcileUploaderRaces");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { nudgeOvertakenRivals } = require("./recordSteps");

class StepSampleError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepSampleError";
    if (statusCode) this.statusCode = statusCode;
  }
}

const VALID_RECORDING_METHODS = new Set([
  "unknown",
  "active",
  "automatic",
  "manual",
]);

// Normalize + validate a raw samples array against the /steps/samples rules:
// trims/lowercases recordingMethod, rejects unknown methods and `manual`
// samples, and requires periodStart/periodEnd/steps on each. Throws
// StepSampleError (400). Shared with POST /steps/sync-v2 so both paths reject
// the same inputs. Returns the normalized (not yet overlap-cleaned) samples.
function normalizeSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new StepSampleError("samples must be an array", 400);
  }

  const normalizedSamples = samples.map((sample) => {
    const normalized = { ...sample };

    if (typeof normalized.recordingMethod === "string") {
      normalized.recordingMethod = normalized.recordingMethod.trim().toLowerCase();

      if (!VALID_RECORDING_METHODS.has(normalized.recordingMethod)) {
        throw new StepSampleError("recordingMethod must be one of unknown, active, automatic, or manual", 400);
      }

      if (normalized.recordingMethod === "manual") {
        throw new StepSampleError("manual step samples are not allowed", 400);
      }
    }

    return normalized;
  });

  for (const s of normalizedSamples) {
    if (!s.periodStart || !s.periodEnd || s.steps == null) {
      throw new StepSampleError("Each sample requires periodStart, periodEnd, and steps", 400);
    }
  }

  return normalizedSamples;
}

// Remove overlapping samples: if sample A fully contains sample B,
// keep the shorter (more granular) one and discard the broader one.
function removeOverlaps(samples) {
  if (samples.length <= 1) return samples;

  const parsed = samples.map((s) => ({
    ...s,
    _start: new Date(s.periodStart).getTime(),
    _end: new Date(s.periodEnd).getTime(),
  }));

  return parsed
    .filter((sample) => {
      // Drop this sample if any other shorter sample is fully contained within it
      const containsShorter = parsed.some(
        (other) =>
          other !== sample &&
          other._start >= sample._start &&
          other._end <= sample._end &&
          (other._end - other._start) < (sample._end - sample._start)
      );
      return !containsShorter;
    })
    .map(({ _start, _end, ...rest }) => rest);
}

function buildRecordStepSamples(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const inlineResolutionInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  const resolveRaceState = inlineResolutionInjected
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
  // C0 (spec §5a item 4): enqueue the uploader's active races instead of bulk-
  // writing them inline. See recordSteps.js for the lever semantics.
  const enqueueRaceResolutionForUser = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolutionForUser"
  )
    ? dependencies.enqueueRaceResolutionForUser
    : hasInjectedDeps
      ? async () => []
      : defaultEnqueueRaceResolutionForUser;
  const reconcileUploaderRaces = Object.prototype.hasOwnProperty.call(
    dependencies,
    "reconcileUploaderRaces"
  )
    ? dependencies.reconcileUploaderRaces
    : hasInjectedDeps
      ? async () => ({ resolvedRaceCount: 0 })
      : defaultReconcileUploaderRaces;
  const settings =
    dependencies.appSettings ||
    (hasInjectedDeps ? { getFlag: async () => false } : defaultAppSettings);

  return async function recordStepSamples({ userId, samples, timeZone }) {
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new StepSampleError("samples must be a non-empty array", 400);
    }

    const normalizedSamples = normalizeSamples(samples);
    const cleaned = removeOverlaps(normalizedSamples);
    // Granularity-aware overlap resolution (§3.3). Capability-detected so injected
    // test fakes that predate reconcileBatch still exercise their upsertBatch.
    if (typeof stepSampleModel.reconcileBatch === "function") {
      await stepSampleModel.reconcileBatch(userId, cleaned);
    } else {
      await stepSampleModel.upsertBatch(userId, cleaned);
    }
    let reasonAware = false;
    try {
      reasonAware =
        (await settings.getFlag("raceResolutionReasonAwareV1Enabled")) === true;
    } catch {
      reasonAware = false;
    }
    if (!reasonAware) {
      await enqueueRaceResolutionForUser({
        userId,
        timeZone,
        now: new Date(),
        reason: "STEP_SYNC",
        priority: "COALESCE",
      });
    }

    // C0: the bulk resolve is gone, but the UPLOADER-ONLY reconcile stays inline
    // — the same one sync-v2 runs in its Transaction B. It writes exactly ONE
    // row (the uploader's own participant) and syncs their box/powerup state, so
    // it is a residual single-row writer under §5a item 7, not a bulk writer.
    // Keeping it is what preserves same-request box minting for frozen legacy
    // clients; pure enqueue-only would defer their box to the next worker cycle.
    // Rival totals, trail mines, overtakes and placements are the worker's.
    let reconciliation = null;
    try {
      reconciliation = await reconcileUploaderRaces({
        userId,
        timeZone,
        includeReconciledRaces: reasonAware,
      });
    } catch (error) {
      console.error("Uploader race reconciliation failed:", error);
    }

    if (reasonAware) {
      const narrowReady =
        reconciliation && Array.isArray(reconciliation.reconciledRaces);
      await enqueueRaceResolutionForUser({
        userId,
        timeZone,
        now: new Date(),
        reason: narrowReady ? "STEP_SYNC" : null,
        priority: narrowReady ? "COALESCE" : "IMMEDIATE",
        reconciledRaces: narrowReady ? reconciliation.reconciledRaces : null,
      });
    }

    let inlineFallback = inlineResolutionInjected;
    if (!inlineFallback) {
      try {
        inlineFallback =
          (await settings.getFlag("inlineRaceResolutionFallback")) === true;
      } catch {
        inlineFallback = false;
      }
    }
    if (!inlineFallback) {
      return { count: cleaned.length };
    }

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

      // Parity with recordSteps: modern clients opt into skipRaceResolution on
      // /steps and resolve race state HERE instead, so this is where an overtake
      // materializes for them. Fire-and-forget; never blocks or fails the sync.
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

    return { count: cleaned.length };
  };
}

const recordStepSamples = buildRecordStepSamples();

module.exports = {
  buildRecordStepSamples,
  recordStepSamples,
  StepSampleError,
  normalizeSamples,
  removeOverlaps,
};
