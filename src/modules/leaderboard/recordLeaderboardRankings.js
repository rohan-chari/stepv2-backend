const RACE_POINTS = {
  first: 60,
  second: 30,
  third: 10,
};

function compareStrings(a, b) {
  return (a || "").localeCompare(b || "");
}

function assignCompetitionRanks(entries, isTie) {
  if (entries.length === 0) {
    return [];
  }

  const ranked = [];
  let previousRank = 1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (index === 0) {
      ranked.push({ ...entry, rank: 1 });
      continue;
    }

    const previousEntry = entries[index - 1];
    const rank = isTie(entry, previousEntry) ? previousRank : index + 1;
    previousRank = rank;
    ranked.push({ ...entry, rank });
  }

  return ranked;
}

function buildRaceEntry(entry) {
  const firsts = entry.firsts || 0;
  const seconds = entry.seconds || 0;
  const thirds = entry.thirds || 0;
  return {
    userId: entry.userId,
    displayName: entry.displayName || "Anonymous",
    firsts,
    seconds,
    thirds,
    points:
      firsts * RACE_POINTS.first +
      seconds * RACE_POINTS.second +
      thirds * RACE_POINTS.third,
  };
}

function hasPodiumFinish(entry) {
  return (entry.firsts || 0) > 0 || (entry.seconds || 0) > 0 || (entry.thirds || 0) > 0;
}

function raceComparator(a, b) {
  return (
    b.points - a.points ||
    b.firsts - a.firsts ||
    b.seconds - a.seconds ||
    b.thirds - a.thirds ||
    compareStrings(a.displayName, b.displayName) ||
    compareStrings(a.userId, b.userId)
  );
}

function raceTie(a, b) {
  return (
    a.points === b.points &&
    a.firsts === b.firsts &&
    a.seconds === b.seconds &&
    a.thirds === b.thirds
  );
}

function rankRaceRecordEntries(entries) {
  return assignCompetitionRanks(
    entries
      .map(buildRaceEntry)
      .filter(hasPodiumFinish)
      .sort(raceComparator),
    raceTie
  );
}

function buildRaceRecordLeaderboard(entries, currentUserId, currentUserDisplayName = "Anonymous") {
  const normalized = entries.map(buildRaceEntry);
  const currentUserEntry =
    normalized.find((entry) => entry.userId === currentUserId) || {
      userId: currentUserId,
      displayName: currentUserDisplayName || "Anonymous",
      firsts: 0,
      seconds: 0,
      thirds: 0,
      points: 0,
    };

  const ranked = rankRaceRecordEntries(entries);
  const top100 = ranked.slice(0, 100).map(({ rank, userId, displayName, firsts, seconds, thirds }) => ({
    rank,
    userId,
    displayName,
    firsts,
    seconds,
    thirds,
  }));

  const rankedCurrentUser = ranked.find((entry) => entry.userId === currentUserId);
  if (rankedCurrentUser) {
    return {
      top100,
      currentUser: {
        rank: rankedCurrentUser.rank,
        displayName: rankedCurrentUser.displayName,
        firsts: rankedCurrentUser.firsts,
        seconds: rankedCurrentUser.seconds,
        thirds: rankedCurrentUser.thirds,
        inTop100: top100.some((entry) => entry.userId === currentUserId),
      },
    };
  }

  return {
    top100,
    currentUser: {
      rank: null,
      displayName: currentUserEntry.displayName,
      firsts: currentUserEntry.firsts,
      seconds: currentUserEntry.seconds,
      thirds: currentUserEntry.thirds,
      inTop100: false,
    },
  };
}

module.exports = {
  RACE_POINTS,
  assignCompetitionRanks,
  buildRaceEntry,
  buildRaceRecordLeaderboard,
  raceComparator,
  raceTie,
  rankRaceRecordEntries,
};
