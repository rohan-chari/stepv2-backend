const {
  calculateCurrentTotal,
} = require("./raceStateResolution");
const {
  applyLeechTransfers,
} = require("../../powerups/leechTransfers");
const {
  applyHitchhikeCopies,
  collectRaceHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const {
  eventsForUser,
} = require("../../steps/services/globalStepEventEntitlement");

function chronologicalAttributionRows(rows = []) {
  return [...rows].sort((a, b) => {
    const at = new Date(a.startsAt || a.createdAt || 0).getTime();
    const bt = new Date(b.startsAt || b.createdAt || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
}

// Shared whole-race phase ordering for explanatory settlement attribution and
// immutable boundary attribution. Callers own only input capture/base-step
// construction; modifier evaluation, Hitchhike-before-Leech ordering, floors,
// and frozen participant handling remain one canonical orchestration.
async function scoreWholeRaceTotals({
  raceId,
  raceEndsAt,
  raceTimezone = "UTC",
  racePowerupsEnabled,
  participants = [],
  entries = [],
  raceActiveEffectModel,
  stepSampleModel,
  attributionCaptureModel,
  globalEvents = [],
  eventsByUserId = null,
  now,
  isFrozen = (participant) => Boolean(participant.finishedAt || participant.forfeitedAt),
  frozenTotals = new Map(),
  prepareSampleUsers = null,
  releaseSampleUsers = null,
}) {
  const evaluated = [];
  for (const entry of entries) {
    const participant = entry.participant;
    const leechesByType = racePowerupsEnabled
      ? await raceActiveEffectModel.findEffectsForRaceByTypes(
          raceId,
          participant.id,
          ["LEECH"],
        )
      : null;
    const scoringUserIds = [...new Set([
      participant.userId,
      ...(leechesByType?.LEECH || []).map((effect) => effect.sourceUserId),
    ].filter(Boolean))];
    if (prepareSampleUsers) await prepareSampleUsers(scoringUserIds);
    let current;
    try {
      current = await calculateCurrentTotal({
        raceId,
        racePowerupsEnabled,
        participant,
        baseAdjusted: entry.baseAdjusted,
        hasSampleData: entry.hasSampleData,
        raceActiveEffectModel,
        stepSampleModel,
        globalEvents: eventsByUserId
          ? eventsForUser(eventsByUserId, participant.userId)
          : globalEvents,
        now: entry.now || now,
      });
    } finally {
      if (releaseSampleUsers) releaseSampleUsers(scoringUserIds);
    }
    evaluated.push({
      participant,
      participantId: participant.id,
      userId: participant.userId,
      preLeechTotal: current.total,
      leechTransfers: current.leechTransfers,
      frozen: isFrozen(participant),
    });
  }

  const copies = racePowerupsEnabled
    ? await collectRaceHitchhikeCopies({
        raceId,
        raceEndsAt,
        participants,
        raceActiveEffectModel,
        stepSampleModel,
        now,
        attributionCaptureModel,
        raceTimezone,
        globalEvents,
        eventsByUserId,
        prepareSampleUsers,
        releaseSampleUsers,
      })
    : [];
  const active = evaluated.filter((entry) => !entry.frozen);
  const activeTotals = applyLeechTransfers(applyHitchhikeCopies(active, copies));
  const totals = new Map(evaluated.map((entry) => [entry.participantId, entry.preLeechTotal]));
  for (const [participantId, total] of activeTotals) totals.set(participantId, total);
  for (const [participantId, total] of frozenTotals) totals.set(participantId, total);
  return totals;
}

module.exports = { chronologicalAttributionRows, scoreWholeRaceTotals };
