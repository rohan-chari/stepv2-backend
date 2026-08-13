// Display-only capability resolver. Individual-race exits are the additive
// race_leave protocol and therefore require its token + row stamp. Team exits
// predate that protocol: team-capable clients must keep seeing their PENDING
// leave / ACTIVE forfeit controls even on pre-migration rows (which stamp false).
// Mutation commands repeat these checks authoritatively.
function getRaceLeaveAction({
  race,
  participant,
  supportsRaceLeave = false,
  supportsTeamRaces = false,
}) {
  if (
    race?.tournamentId != null ||
    !participant ||
    participant.status !== "ACCEPTED" ||
    participant.forfeitedAt != null ||
    race.creatorId === participant.userId
  ) {
    return null;
  }
  if (race.isTeamRace === true) {
    if (supportsTeamRaces !== true) return null;
    if (race.status === "PENDING") return "LEAVE";
    // This is display guidance only. Team clients keep mutating this action
    // through the long-standing POST /races/:id/forfeit endpoint.
    if (race.status === "ACTIVE") return "FORFEIT";
    return null;
  }
  if (supportsRaceLeave !== true || race?.exitActionsEnabled !== true) {
    return null;
  }
  if (race.status === "PENDING") return "LEAVE";
  if (race.status === "ACTIVE") return "FORFEIT";
  return null;
}

module.exports = { getRaceLeaveAction };
