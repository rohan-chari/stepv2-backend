const { ActiveRaceImpact: defaultModel } = require("../models/activeRaceImpact");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
const { NotFoundError, ForbiddenError } = require("../../../shared/errors/AppError");

function isValidNotice(row) {
  return Boolean(
    row &&
      typeof row.id === "string" &&
      typeof row.powerupType === "string" &&
      Number.isInteger(row.deltaSteps) &&
      row.deltaSteps !== 0 &&
      row.valueStatus === "SYNCED_SNAPSHOT" &&
      row.resolvedAt instanceof Date &&
      Number.isFinite(row.resolvedAt.getTime())
  );
}

function buildGetActiveRaceImpactNotices(dependencies = {}) {
  const model = dependencies.ActiveRaceImpact || defaultModel;
  const enqueueRaceResolution =
    dependencies.enqueueRaceResolution || defaultEnqueueRaceResolution;

  return async function getActiveRaceImpactNotices({ raceId, userId }) {
    const race = await model.getRaceAccess({ raceId, userId });
    if (!race) throw new NotFoundError("Race not found", "RACE_NOT_FOUND");
    if (!Array.isArray(race.participants) || race.participants.length === 0) {
      throw new ForbiddenError(
        "You are not a participant in this race",
        "NOT_RACE_PARTICIPANT"
      );
    }
    if (race.status !== "ACTIVE") {
      await model.suppressPendingForTerminalRace(raceId);
      return { notices: [] };
    }

    const [rows, pending] = await Promise.all([
      model.listUnacknowledged({ raceId, userId, limit: 20 }),
      model.countPending({ raceId, userId }),
    ]);
    if (pending > 0) {
      const job = await enqueueRaceResolution({
        raceId,
        userId,
        reason: "ACTIVE_IMPACT_PENDING",
        priority: "IMMEDIATE",
      });
      if (job?.id && Number.isInteger(Number(job.generation))) {
        return {
          pending: true,
          notices: [],
          resolution: {
            state: "PENDING",
            jobId: job.id,
            generation: Number(job.generation),
            retryAfterMs: 500,
          },
        };
      }
    }

    return {
      notices: (rows || []).filter(isValidNotice).map((row) => ({
        id: row.id,
        powerupType: row.powerupType,
        deltaSteps: row.deltaSteps,
        valueStatus: row.valueStatus,
        resolvedAt: row.resolvedAt,
      })),
    };
  };
}

const getActiveRaceImpactNotices = buildGetActiveRaceImpactNotices();

module.exports = {
  isValidNotice,
  buildGetActiveRaceImpactNotices,
  getActiveRaceImpactNotices,
};
