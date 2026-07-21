// Shared baseline-snapshot logic for the moment a race (or tournament matchup)
// goes live. Extracted from startRace.js so the tournament engine's round
// creation and the ordinary race start share ONE definition of "snapshot the
// participant's pre-race steps + anchor joinedAt + seed the first powerup box".
//
// Returns the RaceParticipant update fields; the caller applies them (and any
// buy-in COMMITTED transition, which differs per caller) via its own update.
async function snapshotBaselineFields({ participant, race, startedAt, stepsModel }) {
  const today = startedAt.toISOString().slice(0, 10);
  const todaySteps = await stepsModel.findByUserIdAndDate(participant.userId, today);
  const updateFields = {
    baselineSteps: todaySteps?.steps ?? 0,
    joinedAt: startedAt,
  };
  // Initialize the first powerup-box threshold if powerups are enabled.
  if (race.powerupsEnabled && race.powerupStepInterval) {
    updateFields.nextBoxAtSteps = race.powerupStepInterval;
  }
  return updateFields;
}

module.exports = { snapshotBaselineFields };
