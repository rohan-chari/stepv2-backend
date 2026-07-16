const { buildJoinTournamentCore } = require("./joinTournamentCore");

// Share-link join (POST /tournaments/share/:token/join). Possession of the token
// IS the invite, so it bypasses isPublic (mode "share").
function buildJoinTournamentByShareToken(dependencies = {}) {
  const core = dependencies.joinTournamentCore || buildJoinTournamentCore(dependencies);
  return async function joinTournamentByShareToken({ userId, token, clientFeatures, supportsCharacters }) {
    return core({
      userId,
      shareToken: token,
      mode: "share",
      clientFeatures,
      supportsCharacters,
    });
  };
}

const joinTournamentByShareToken = buildJoinTournamentByShareToken();

module.exports = { buildJoinTournamentByShareToken, joinTournamentByShareToken };
