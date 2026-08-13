const { Race } = require("../models/race");
const {
  RaceResolutionJobV2,
} = require("../models/raceResolutionJobV2");

// The single seam every enqueue site in the codebase goes through (spec §5a
// item 4). Keeping it in one place means "who marks a race dirty" is greppable,
// and the race-keyed upsert semantics can never drift between call sites.
//
// Two flavours:
//   enqueueRaceResolution      — one known race (powerup use, join/leave/kick,
//                                forfeit, edit/cancel, progress poll)
//   enqueueRaceResolutionForUser — every ACTIVE race a user is in (the step-sync
//                                paths, which know a user and not a race)
//
// Both are BEST-EFFORT when called outside a transaction: a queue write must
// never fail a user's request. placementRecompute retains a bounded recovery
// backstop for missing/failed/hour-old rows instead of replaying every race.
// Inside a caller-supplied `tx` (sync-v2 Transaction B) errors DO propagate —
// there the enqueue is part of the atomic unit the caller is building.

async function enqueueRaceResolution(
  { raceId, userId = null, timeZone = null, now = new Date() },
  tx = null
) {
  if (!raceId) return null;
  if (tx) {
    return RaceResolutionJobV2.enqueue(
      { raceId, userId, resolutionTimeZone: timeZone, now },
      tx
    );
  }
  try {
    return await RaceResolutionJobV2.enqueue({
      raceId,
      userId,
      resolutionTimeZone: timeZone,
      now,
    });
  } catch (error) {
    console.error(`[RACE_RESOLUTION_V2] enqueue failed (race ${raceId}):`, error);
    return null;
  }
}

async function enqueueRaceResolutionForUser(
  { userId, timeZone = null, now = new Date(), raceModel = Race },
  tx = null
) {
  if (!userId) return [];
  const load = async () => {
    const races = await raceModel.findActiveForUser(userId);
    return (races || []).map((race) => race.id);
  };

  if (tx) {
    const raceIds = await load();
    return RaceResolutionJobV2.enqueueMany(
      { raceIds, userId, resolutionTimeZone: timeZone, now },
      tx
    );
  }
  try {
    const raceIds = await load();
    return await RaceResolutionJobV2.enqueueMany({
      raceIds,
      userId,
      resolutionTimeZone: timeZone,
      now,
    });
  } catch (error) {
    console.error(`[RACE_RESOLUTION_V2] enqueue failed (user ${userId}):`, error);
    return [];
  }
}

module.exports = { enqueueRaceResolution, enqueueRaceResolutionForUser };
