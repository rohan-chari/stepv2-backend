const {
  getPublicRaceCount: defaultGetPublicRaceCount,
} = require("./getPublicRaceCount");
const {
  getFeaturedRaces: defaultGetFeaturedRaces,
} = require("./getFeaturedRaces");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("../../tournaments/queries/getPublicTournaments");

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

    // Item 2 (2026-07-24): "PUBLIC RACES (X)" should count the featured seeded
    // daily/weekly races AND the featured Daily Dash brackets the viewer is NOT
    // already in.
    //
    // The featured seeded RACES are ALREADY in getPublicRaceCount: they are ACTIVE
    // public individual races (no tournamentId, not team), and getPublicRaceCount
    // already excludes the ones the viewer has joined or that are full. Re-adding
    // them here would DOUBLE-COUNT. So the only genuinely-missing featured content
    // is the Daily Dash BRACKETS — Tournament rows, never part of the race count.
    //
    // We add only the featured brackets the viewer could ACTUALLY join, which
    // getPublicTournaments answers with the additive `joinable` flag: not already
    // enrolled, has an open slot, and the viewer isn't still alive in another
    // bracket of the same seed (joinTournamentCore rejects that with
    // ALREADY_IN_FEATURED). "Not enrolled in THIS lobby" alone was too loose —
    // it advertised "1 race available to join" for a bracket that answers 409.
    // The check is strict `=== true` so a branch that returned entries without
    // the flag contributes nothing rather than over-counting.
    //
    // /races/public and getPublicRaceCount stay unchanged (the old-client
    // fallback path). Only add when the base count resolved — otherwise the field
    // is marked unresolved and the client keeps its last known value regardless.
    if (resolved.publicRaceCount) {
      publicRaceCount += featuredTournaments.filter(
        (t) => t && t.joinable === true
      ).length;
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
