const { buildJoinTournamentCore } = require("./joinTournamentCore");

// Public browse-join (POST /tournaments/:id/join). Delegates to the shared join
// core in "public" mode (requires isPublic).
function buildJoinTournament(dependencies = {}) {
  const core = dependencies.joinTournamentCore || buildJoinTournamentCore(dependencies);
  return async function joinTournament({ userId, tournamentId, clientFeatures, supportsCharacters }) {
    return core({
      userId,
      tournamentId,
      mode: "public",
      clientFeatures,
      supportsCharacters,
    });
  };
}

const joinTournament = buildJoinTournament();

module.exports = { buildJoinTournament, joinTournament };
