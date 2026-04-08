const CHALLENGE_RECORD_MINIMUM_COMPLETED = 5;
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

function buildChallengeEntry(entry) {
  const wins = entry.wins || 0;
  const losses = entry.losses || 0;
  const completedCount = wins + losses;
  return {
    userId: entry.userId,
    displayName: entry.displayName || "Anonymous",
    wins,
    losses,
    completedCount,
    winPercentage: completedCount > 0 ? wins / completedCount : 0,
  };
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

function challengeComparator(a, b) {
  return (
    b.winPercentage - a.winPercentage ||
    b.completedCount - a.completedCount ||
    b.wins - a.wins ||
    compareStrings(a.displayName, b.displayName) ||
    compareStrings(a.userId, b.userId)
  );
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

function challengeTie(a, b) {
  return (
    a.winPercentage === b.winPercentage &&
    a.completedCount === b.completedCount &&
    a.wins === b.wins
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

function rankChallengeRecordEntries(entries) {
  return assignCompetitionRanks(
    entries
      .map(buildChallengeEntry)
      .filter((entry) => entry.completedCount >= CHALLENGE_RECORD_MINIMUM_COMPLETED)
      .sort(challengeComparator),
    challengeTie
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

function buildChallengeRecordLeaderboard(entries, currentUserId, currentUserDisplayName = "Anonymous") {
  const normalized = entries.map(buildChallengeEntry);
  const currentUserEntry =
    normalized.find((entry) => entry.userId === currentUserId) || {
      userId: currentUserId,
      displayName: currentUserDisplayName || "Anonymous",
      wins: 0,
      losses: 0,
      completedCount: 0,
      winPercentage: 0,
    };

  const ranked = rankChallengeRecordEntries(entries);

  const top10 = ranked.slice(0, 10).map(({ rank, userId, displayName, wins, losses, completedCount, winPercentage }) => ({
    rank,
    userId,
    displayName,
    wins,
    losses,
    completedCount,
    winPercentage,
  }));

  const rankedCurrentUser = ranked.find((entry) => entry.userId === currentUserId);
  if (rankedCurrentUser) {
    return {
      top10,
      currentUser: {
        rank: rankedCurrentUser.rank,
        displayName: rankedCurrentUser.displayName,
        wins: rankedCurrentUser.wins,
        losses: rankedCurrentUser.losses,
        completedCount: rankedCurrentUser.completedCount,
        winPercentage: rankedCurrentUser.winPercentage,
        inTop10: top10.some((entry) => entry.userId === currentUserId),
        qualified: true,
      },
    };
  }

  return {
    top10,
    currentUser: {
      rank: null,
      displayName: currentUserEntry.displayName,
      wins: currentUserEntry.wins,
      losses: currentUserEntry.losses,
      completedCount: currentUserEntry.completedCount,
      winPercentage: currentUserEntry.winPercentage,
      inTop10: false,
      qualified: false,
    },
  };
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
  const top10 = ranked.slice(0, 10).map(({ rank, userId, displayName, firsts, seconds, thirds }) => ({
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
      top10,
      currentUser: {
        rank: rankedCurrentUser.rank,
        displayName: rankedCurrentUser.displayName,
        firsts: rankedCurrentUser.firsts,
        seconds: rankedCurrentUser.seconds,
        thirds: rankedCurrentUser.thirds,
        inTop10: top10.some((entry) => entry.userId === currentUserId),
      },
    };
  }

  return {
    top10,
    currentUser: {
      rank: null,
      displayName: currentUserEntry.displayName,
      firsts: currentUserEntry.firsts,
      seconds: currentUserEntry.seconds,
      thirds: currentUserEntry.thirds,
      inTop10: false,
    },
  };
}

module.exports = {
  CHALLENGE_RECORD_MINIMUM_COMPLETED,
  RACE_POINTS,
  assignCompetitionRanks,
  buildChallengeEntry,
  buildChallengeRecordLeaderboard,
  buildRaceEntry,
  buildRaceRecordLeaderboard,
  challengeComparator,
  challengeTie,
  raceComparator,
  raceTie,
  rankChallengeRecordEntries,
  rankRaceRecordEntries,
};
