const {
  getFeaturedRaces: defaultGetFeaturedRaces,
} = require("../../races/queries/getFeaturedRaces");
const {
  getPublicRaces: defaultGetPublicRaces,
} = require("../../races/queries/getPublicRaces");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("../../tournaments/queries/getPublicTournaments");

const FEATURED_RANK = { DAILY_10K: 0, WEEKLY_50K: 1 };

function dateMillis(value) {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function newestThenId(a, b) {
  const timeDifference = dateMillis(b.createdAt) - dateMillis(a.createdAt);
  return timeDifference || String(a.id).localeCompare(String(b.id));
}

function adaptFeaturedRace(race) {
  return {
    kind: "FEATURED_RACE",
    id: race.raceId,
    seedKind: race.seedKind,
    name: race.name,
    status: "ACTIVE",
    endsAt: race.endsAt,
    participantCount: race.participantCount,
    maxParticipants: race.maxParticipants,
    isFull: race.isFull,
    powerupsEnabled: race.powerupsEnabled,
    prizePool: race.prizePool ?? null,
    finishReward: race.finishReward ?? null,
    joinAction: "JOIN",
  };
}

function adaptPublicRace(race) {
  return {
    kind: "PUBLIC_RACE",
    id: race.id,
    name: race.name,
    status: race.status,
    maxDurationDays: race.maxDurationDays,
    endsAt: race.endsAt ?? null,
    startedAt: race.startedAt ?? null,
    participantCount: race.participantCount,
    maxParticipants: race.maxParticipants ?? null,
    buyInAmount: race.buyInAmount,
    payoutPreset: race.payoutPreset ?? null,
    powerupsEnabled: race.powerupsEnabled,
    prizePool: race.prizePool ?? null,
    isTeamRace: race.isTeamRace,
    teamSize: race.teamSize ?? null,
    teamAName: race.teamAName ?? null,
    teamBName: race.teamBName ?? null,
    teams: race.teams ?? null,
    joinAction: "JOIN",
  };
}

function adaptTournament(tournament) {
  return {
    kind: "TOURNAMENT",
    id: tournament.id,
    seedKind: tournament.seedKind ?? null,
    name: tournament.name,
    status: tournament.status,
    bracketSize: tournament.bracketSize,
    matchupDurationDays: tournament.matchupDurationDays,
    acceptedCount: tournament.acceptedCount,
    buyInAmount: tournament.buyInAmount,
    potCoins: tournament.potCoins,
    prizePool: tournament.prizePool ?? null,
    powerupsEnabled: tournament.powerupsEnabled,
    powerupStepInterval: tournament.powerupStepInterval ?? null,
    createdAt: tournament.createdAt,
    joinAction: "JOIN",
  };
}

function buildGetSuggestedRaces(dependencies = {}) {
  const getFeaturedRaces =
    dependencies.getFeaturedRaces || defaultGetFeaturedRaces;
  const getPublicRaces = dependencies.getPublicRaces || defaultGetPublicRaces;
  const getPublicTournaments =
    dependencies.getPublicTournaments || defaultGetPublicTournaments;
  const logger = dependencies.logger || console;

  return async function getSuggestedRaces({
    userId,
    supportsTeamRaces = false,
    supportsTournaments = false,
  }) {
    const [featuredResult, publicResult, tournamentResult] =
      await Promise.allSettled([
        getFeaturedRaces({ userId, suggestionMode: true }),
        getPublicRaces({
          userId,
          supportsTeamRaces,
          excludeSeeded: true,
          suggestionMode: true,
        }),
        supportsTournaments
          ? getPublicTournaments({ userId, suggestionMode: true })
          : Promise.resolve({ featured: [], tournaments: [] }),
      ]);

    const resolved = {
      featuredRaces: false,
      publicRaces: false,
      tournaments: false,
    };

    let featured = [];
    if (featuredResult.status === "fulfilled" && Array.isArray(featuredResult.value)) {
      resolved.featuredRaces = true;
      const seenKinds = new Set();
      featured = featuredResult.value
        .filter(
          (race) =>
            race &&
            FEATURED_RANK[race.seedKind] != null &&
            race.myStatus !== "ACCEPTED" &&
            race.myStatus !== "INVITED" &&
            race.isFull !== true
        )
        .sort(
          (a, b) =>
            FEATURED_RANK[a.seedKind] - FEATURED_RANK[b.seedKind]
        )
        .filter((race) => {
          if (seenKinds.has(race.seedKind)) return false;
          seenKinds.add(race.seedKind);
          return true;
        })
        .slice(0, 2)
        .map(adaptFeaturedRace);
    } else if (featuredResult.status === "rejected") {
      logger.error("home suggested-races featuredRaces error:", featuredResult.reason);
    }

    let publicRaces = [];
    if (publicResult.status === "fulfilled" && Array.isArray(publicResult.value)) {
      resolved.publicRaces = true;
      publicRaces = [...publicResult.value]
        .sort(newestThenId)
        .slice(0, 4)
        .map(adaptPublicRace);
    } else if (publicResult.status === "rejected") {
      logger.error("home suggested-races publicRaces error:", publicResult.reason);
    }

    let tournaments = [];
    if (
      tournamentResult.status === "fulfilled" &&
      tournamentResult.value &&
      Array.isArray(tournamentResult.value.featured) &&
      Array.isArray(tournamentResult.value.tournaments)
    ) {
      resolved.tournaments = true;
      const featuredTournaments = tournamentResult.value.featured
        .filter((tournament) => tournament?.joinable === true)
        .sort(newestThenId);
      const publicTournaments = tournamentResult.value.tournaments
        .filter((tournament) => tournament?.joinable === true)
        .sort(newestThenId);
      tournaments = [...featuredTournaments, ...publicTournaments]
        .slice(0, 4)
        .map(adaptTournament);
    } else if (tournamentResult.status === "rejected") {
      logger.error("home suggested-races tournaments error:", tournamentResult.reason);
    }

    return {
      suggestions: [...featured, ...publicRaces, ...tournaments],
      resolved,
    };
  };
}

const getSuggestedRaces = buildGetSuggestedRaces();

module.exports = { buildGetSuggestedRaces, getSuggestedRaces };
