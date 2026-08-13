const { buildJoinTournamentCore } = require("./joinTournamentCore");

// Invite accept/decline (PUT /tournaments/:id/respond). Accept flows through the
// shared join core in "invite" mode (holds the buy-in, capacity-checked); a
// decline soft-updates the row to DECLINED.
function buildRespondToTournamentInvite(dependencies = {}) {
  const core = dependencies.joinTournamentCore || buildJoinTournamentCore(dependencies);
  return async function respondToTournamentInvite({
    userId,
    tournamentId,
    accept,
    clientFeatures,
    supportsCharacters,
    supportsRemoteAssets = false,
  }) {
    return core({
      userId,
      tournamentId,
      mode: "invite",
      accept: accept !== false,
      clientFeatures,
      supportsCharacters,
      supportsRemoteAssets,
    });
  };
}

const respondToTournamentInvite = buildRespondToTournamentInvite();

module.exports = { buildRespondToTournamentInvite, respondToTournamentInvite };
