// One shared, fail-closed predicate owns referral qualification at both the
// settlement fact seam and the reward compatibility seam.
function qualifyingParticipants(race) {
  if (!race || !Array.isArray(race.participants)) return [];
  return race.participants.filter((participant) =>
    participant.status === "ACCEPTED" &&
    typeof participant.rawSteps === "number" &&
    participant.rawSteps >= 2000
  );
}

function isReferralQualifyingRace(race) {
  if (!race ||
      !Object.prototype.hasOwnProperty.call(race, "seedId") ||
      !Object.prototype.hasOwnProperty.call(race, "tournamentId")) {
    return false;
  }
  return race.seedId == null &&
    race.tournamentId == null &&
    qualifyingParticipants(race).length >= 2;
}

async function acquireReferralQualificationFence(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('giveaway-referral-qualification-v1'))`;
}

module.exports = {
  acquireReferralQualificationFence,
  isReferralQualifyingRace,
  qualifyingParticipants,
};
