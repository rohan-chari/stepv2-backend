const {
  getPublicRaceCount: defaultGetPublicRaceCount,
} = require("./getPublicRaceCount");
const {
  getFeaturedRaces: defaultGetFeaturedRaces,
} = require("./getFeaturedRaces");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("./getPublicTournaments");

// GET /races/discovery-summary (§6.2): one compact request replacing the Races
// screen's three background calls (public count, featured races, featured
// tournaments). The three computations run CONCURRENTLY and INDEPENDENTLY: a
// failed optional branch logs, returns its safe default (0 or []), and marks
// only its own `resolved` key false while the endpoint stays 200. The frontend
// commits a field only when its value has the right type AND its resolved bit is
// true; otherwise it keeps the last known value.
//
// Feature gating: featuredTournaments is [] (and resolved:true) for clients
// without the `tournaments` token — the answer is known to be empty, not failed.
// publicRaceCount and featuredRaces honor the team_races token via getPublicRaces/
// getFeaturedRaces' existing rules.
function buildGetRaceDiscoverySummary(dependencies = {}) {
  const getPublicRaceCount =
    dependencies.getPublicRaceCount || defaultGetPublicRaceCount;
  const getFeaturedRaces =
    dependencies.getFeaturedRaces || defaultGetFeaturedRaces;
  const getPublicTournaments =
    dependencies.getPublicTournaments || defaultGetPublicTournaments;
  const logger = dependencies.logger || console;

  return async function getRaceDiscoverySummary({
    userId,
    supportsTeamRaces = false,
    supportsTournaments = false,
  }) {
    const resolved = {
      publicRaceCount: true,
      featuredRaces: true,
      featuredTournaments: true,
    };

    const [countResult, featuredResult, tournamentsResult] = await Promise.allSettled([
      getPublicRaceCount({ userId, supportsTeamRaces }),
      getFeaturedRaces({ userId }),
      supportsTournaments
        ? getPublicTournaments({ userId })
        : Promise.resolve({ featured: [] }),
    ]);

    let publicRaceCount = 0;
    if (countResult.status === "fulfilled" && typeof countResult.value === "number") {
      publicRaceCount = countResult.value;
    } else {
      resolved.publicRaceCount = false;
      if (countResult.status === "rejected") {
        logger.error("discovery-summary publicRaceCount error:", countResult.reason);
      }
    }

    let featuredRaces = [];
    if (featuredResult.status === "fulfilled" && Array.isArray(featuredResult.value)) {
      featuredRaces = featuredResult.value;
    } else {
      resolved.featuredRaces = false;
      if (featuredResult.status === "rejected") {
        logger.error("discovery-summary featuredRaces error:", featuredResult.reason);
      }
    }

    let featuredTournaments = [];
    if (
      tournamentsResult.status === "fulfilled" &&
      tournamentsResult.value &&
      Array.isArray(tournamentsResult.value.featured)
    ) {
      featuredTournaments = tournamentsResult.value.featured;
    } else {
      resolved.featuredTournaments = false;
      if (tournamentsResult.status === "rejected") {
        logger.error("discovery-summary featuredTournaments error:", tournamentsResult.reason);
      }
    }

    return {
      publicRaceCount,
      featuredRaces,
      featuredTournaments,
      resolved,
    };
  };
}

const getRaceDiscoverySummary = buildGetRaceDiscoverySummary();

module.exports = { buildGetRaceDiscoverySummary, getRaceDiscoverySummary };
