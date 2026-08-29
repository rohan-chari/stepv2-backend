const { Race } = require("../models/race");
const {
  RaceResolutionJobV2,
} = require("../models/raceResolutionJobV2");
const { appSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");

function enqueueCounts(rows, at, { queuedGenerationMerge = false } = {}) {
  const values = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  let maxLagMs = 0;
  for (const row of values) {
    if (row.requestedAt) {
      maxLagMs = Math.max(
        maxLagMs,
        Math.max(0, at.getTime() - new Date(row.requestedAt).getTime()),
      );
    }
  }
  const counts = {
    jobs: values.length,
    maxLagMs,
  };
  if (queuedGenerationMerge) {
    // The public row shape does not carry the conflict branch taken. Never
    // mislabel a reused generation as a create/bump; exact outcome telemetry
    // requires a future SQL-returning contract and is intentionally absent.
    counts.generationOutcomeUnavailable = values.length;
  } else {
    counts.generationCreates = values.filter((row) => Number(row.generation) === 1).length;
    counts.generationBumps = values.filter((row) => Number(row.generation) > 1).length;
    counts.generationReuses = 0;
  }
  return counts;
}

async function rolloutOptions({
  reason = null,
  dirtyUserIds = [],
  dirtyParticipantIds = [],
  powerupTypes = [],
  priority = "IMMEDIATE",
  queuePriority = null,
} = {}) {
  const reasonAware = await isStrictFlagEnabled(
    appSettings,
    "raceResolutionReasonAwareV1Enabled"
  );
  const burstCoalescing = await isStrictFlagEnabled(
    appSettings,
    "raceResolutionBurstCoalescingV1Enabled"
  );
  const queuedGenerationMerge = await isStrictFlagEnabled(
    appSettings,
    "raceResolutionQueuedGenerationMergeV1Enabled"
  );
  return {
    dirtyEnvelope: reasonAware
      ? {
          reason,
          dirtyUserIds,
          dirtyParticipantIds,
          powerupTypes,
          priority,
        }
      : null,
    burstCoalescing,
    queuedGenerationMerge,
    queuePriority: queuePriority || (priority === "COALESCE" ? "MAINTENANCE" : "LIVE"),
  };
}

// The single seam every enqueue site in the codebase goes through (spec §5a
// item 4). Keeping it in one place means "who marks a race dirty" is greppable,
// and the race-keyed upsert semantics can never drift between call sites.
//
// Two flavours:
//   enqueueRaceResolution      — one known race (powerup use, join/leave,
//                                forfeit, edit/cancel, progress poll)
//   enqueueRaceResolutionForUser — every ACTIVE race a user is in (the step-sync
//                                paths, which know a user and not a race)
//
// Both are BEST-EFFORT when called outside a transaction: a queue write must
// never fail a user's request. placementRecompute retains a bounded recovery
// backstop for missing/failed/hour-old rows instead of replaying every race.
// Inside a caller-supplied canonical-intake transaction errors DO propagate —
// there the enqueue is part of the atomic unit the caller is building.

async function enqueueRaceResolution(
  {
    raceId,
    userId = null,
    timeZone = null,
    now = new Date(),
    reason = null,
    dirtyUserIds = userId ? [userId] : [],
    dirtyParticipantIds = [],
    powerupTypes = [],
    priority = "IMMEDIATE",
    queuePriority = null,
    displayArtifact = null,
  },
  tx = null
) {
  if (!raceId) return null;
  const capacity = startCapacityPhase("resolution_enqueue");
  let capacityOutcome = "error";
  let result = null;
  let queuedGenerationMerge = false;
  try {
  const rollout = await capacity.measurePhase("rolloutFlags", () =>
    rolloutOptions({
      reason,
      dirtyUserIds,
      dirtyParticipantIds,
      powerupTypes,
      priority,
      queuePriority,
    })
  );
  queuedGenerationMerge = rollout.queuedGenerationMerge;
  // Artifact reuse is independently rollable and must work with only its own
  // flag enabled. The opaque ref is safe only for a pure display generation,
  // so stamp that closed reason even while broader reason-aware scoping is off.
  if (displayArtifact && reason === "DISPLAY_REFRESH") {
    rollout.dirtyEnvelope = {
      reason: "DISPLAY_REFRESH",
      dirtyUserIds,
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "IMMEDIATE",
    };
  }
  // EFFECT_BOUNDARY is a correctness/source-consumption envelope, not a
  // reason-aware scoring optimization. It must survive with that identity even
  // when the optional reason-aware rollout is off, otherwise it degrades to
  // FULL and the worker cannot distinguish it from ordinary score generation.
  if (reason === "EFFECT_BOUNDARY") {
    rollout.dirtyEnvelope = {
      reason: "EFFECT_BOUNDARY",
      dirtyUserIds,
      dirtyParticipantIds,
      powerupTypes,
      priority: "IMMEDIATE",
    };
  }
  if (tx) {
    result = await capacity.measurePhase("persist", () =>
      RaceResolutionJobV2.enqueue(
        { raceId, userId, resolutionTimeZone: timeZone, now, displayArtifact, ...rollout },
        tx
      )
    );
    capacityOutcome = "success";
    return result;
  }
  try {
    result = await capacity.measurePhase("persist", () =>
      RaceResolutionJobV2.enqueue({
        raceId,
        userId,
        resolutionTimeZone: timeZone,
        now,
        displayArtifact,
        ...rollout,
      })
    );
    capacityOutcome = "success";
    return result;
  } catch (error) {
    console.error(`[RACE_RESOLUTION_V2] enqueue failed (race ${raceId}):`, error);
    capacityOutcome = "best-effort-error";
    return null;
  }
  } finally {
    capacity.setCounts(enqueueCounts(result, now, { queuedGenerationMerge }));
    capacity.setDimensions({ transactional: tx != null, batch: false, queuedGenerationMerge });
    capacity.finish(capacityOutcome);
  }
}

async function enqueueRaceResolutionForUser(
  {
    userId,
    timeZone = null,
    now = new Date(),
    raceModel = Race,
    reason = null,
    priority = "IMMEDIATE",
    queuePriority = null,
    reconciledRaces = null,
  },
  tx = null
) {
  if (!userId) return [];
  const capacity = startCapacityPhase("resolution_enqueue");
  let capacityOutcome = "error";
  let result = [];
  let queuedGenerationMerge = false;
  try {
  const load = async () => {
    if (Array.isArray(reconciledRaces)) {
      return reconciledRaces.map((row) => ({
        id: row.raceId,
        participants: row.participantId
          ? [{ id: row.participantId, userId, status: "ACCEPTED" }]
          : [],
      }));
    }
    const races = await raceModel.findActiveForUser(userId);
    return races || [];
  };

  const buildOptions = async (races) => {
    const rollout = await rolloutOptions({
      reason,
      dirtyUserIds: [userId],
      priority,
      queuePriority,
    });
    queuedGenerationMerge = rollout.queuedGenerationMerge;
    const dirtyEnvelopeByRaceId = new Map();
    if (rollout.dirtyEnvelope) {
      for (const race of races) {
        const participant = (race.participants || []).find(
          (row) => row.userId === userId && row.status === "ACCEPTED"
        );
        dirtyEnvelopeByRaceId.set(race.id, {
          ...rollout.dirtyEnvelope,
          dirtyParticipantIds: participant ? [participant.id] : [],
          priority: participant ? priority : "IMMEDIATE",
        });
      }
    }
    return {
      raceIds: races.map((race) => race.id),
      dirtyEnvelopeByRaceId,
      burstCoalescing: rollout.burstCoalescing,
      queuedGenerationMerge: rollout.queuedGenerationMerge,
      queuePriority: rollout.queuePriority,
    };
  };

  if (tx) {
    const races = await capacity.measurePhase("activeRaceLoad", load);
    const options = await capacity.measurePhase(
      "rolloutFlags",
      () => buildOptions(races),
    );
    result = await capacity.measurePhase("persist", () =>
      RaceResolutionJobV2.enqueueMany(
        { ...options, userId, resolutionTimeZone: timeZone, now },
        tx
      )
    );
    capacityOutcome = "success";
    return result;
  }
  try {
    const races = await capacity.measurePhase("activeRaceLoad", load);
    const options = await capacity.measurePhase(
      "rolloutFlags",
      () => buildOptions(races),
    );
    result = await capacity.measurePhase("persist", () =>
      RaceResolutionJobV2.enqueueMany({
        ...options,
        userId,
        resolutionTimeZone: timeZone,
        now,
      })
    );
    capacityOutcome = "success";
    return result;
  } catch (error) {
    console.error(`[RACE_RESOLUTION_V2] enqueue failed (user ${userId}):`, error);
    capacityOutcome = "best-effort-error";
    return [];
  }
  } finally {
    capacity.setCounts(enqueueCounts(result, now, { queuedGenerationMerge }));
    capacity.setDimensions({ transactional: tx != null, batch: true, queuedGenerationMerge });
    capacity.finish(capacityOutcome);
  }
}

module.exports = { enqueueRaceResolution, enqueueRaceResolutionForUser };
