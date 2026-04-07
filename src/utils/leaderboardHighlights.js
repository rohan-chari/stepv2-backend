const { RACE_POINTS } = require("./recordLeaderboardRankings");

const MAX_HIGHLIGHT_RANK = 25;
const STEP_PERIOD_PRIORITY = ["allTime", "month", "week", "today"];
const numberFormatter = new Intl.NumberFormat("en-US");

function ordinal(rank) {
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${rank}th`;
  }

  switch (rank % 10) {
    case 1:
      return `${rank}st`;
    case 2:
      return `${rank}nd`;
    case 3:
      return `${rank}rd`;
    default:
      return `${rank}th`;
  }
}

function scopeLabel(period, leaderboardType) {
  if (leaderboardType !== "steps") {
    return "all time";
  }

  switch (period) {
    case "month":
      return "this month";
    case "week":
      return "this week";
    case "today":
      return "today";
    case "allTime":
    default:
      return "all time";
  }
}

function warmTitle(rank, scope, leaderboardType) {
  const base = `You're ${ordinal(rank)} ${scope} in ${leaderboardType}.`;
  if (rank === 1) {
    return base;
  }
  if (rank <= 3) {
    return `${base.slice(0, -1)}. That's huge.`;
  }
  if (rank <= 10) {
    return `${base.slice(0, -1)}. Keep climbing.`;
  }
  return `${base.slice(0, -1)}. Keep it up.`;
}

function formatCount(count, singular, plural = `${singular}s`) {
  return `${numberFormatter.format(count)} ${count === 1 ? singular : plural}`;
}

function compareChallengeRecords(a, b) {
  const aCompleted = a.wins + a.losses;
  const bCompleted = b.wins + b.losses;
  const aScore = aCompleted === 0 ? 0 : a.wins / aCompleted;
  const bScore = bCompleted === 0 ? 0 : b.wins / bCompleted;

  return (
    aScore - bScore ||
    aCompleted - bCompleted ||
    a.wins - b.wins
  );
}

function getChallengeWinsNeededToAdvance(current, nextBetter) {
  const currentCompleted = current.wins + current.losses;
  const nextCompleted = nextBetter.wins + nextBetter.losses;
  if (nextCompleted > 0 && nextBetter.wins === nextCompleted && current.losses > 0) {
    return null;
  }

  for (let extraWins = 1; extraWins <= 1000; extraWins++) {
    const projected = {
      wins: current.wins + extraWins,
      losses: current.losses,
    };

    if (compareChallengeRecords(projected, nextBetter) > 0) {
      return extraWins;
    }
  }

  return null;
}

function racePoints(record) {
  return (
    (record.firsts || 0) * RACE_POINTS.first +
    (record.seconds || 0) * RACE_POINTS.second +
    (record.thirds || 0) * RACE_POINTS.third
  );
}

function compareRaceRecords(a, b) {
  return (
    racePoints(a) - racePoints(b) ||
    (a.firsts || 0) - (b.firsts || 0) ||
    (a.seconds || 0) - (b.seconds || 0) ||
    (a.thirds || 0) - (b.thirds || 0)
  );
}

function getRacePodiumTargetToAdvance(current, nextBetter) {
  const candidates = [];

  for (let totalFinishes = 1; totalFinishes <= 30; totalFinishes++) {
    for (let firsts = 0; firsts <= totalFinishes; firsts++) {
      for (let seconds = 0; seconds <= totalFinishes - firsts; seconds++) {
        const thirds = totalFinishes - firsts - seconds;
        const projected = {
          firsts: (current.firsts || 0) + firsts,
          seconds: (current.seconds || 0) + seconds,
          thirds: (current.thirds || 0) + thirds,
        };

        if (compareRaceRecords(projected, nextBetter) > 0) {
          candidates.push({
            firsts,
            seconds,
            thirds,
            totalFinishes,
            addedPoints:
              firsts * RACE_POINTS.first +
              seconds * RACE_POINTS.second +
              thirds * RACE_POINTS.third,
          });
        }
      }
    }

    if (candidates.length > 0) {
      break;
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    return (
      a.totalFinishes - b.totalFinishes ||
      a.addedPoints - b.addedPoints ||
      a.firsts - b.firsts ||
      a.seconds - b.seconds ||
      a.thirds - b.thirds
    );
  });

  const best = candidates[0];
  return {
    firsts: best.firsts,
    seconds: best.seconds,
    thirds: best.thirds,
  };
}

function describeRacePodiumTarget(target) {
  if (!target) {
    return "Keep chasing the podium.";
  }

  const parts = [];
  if (target.firsts === 1) {
    parts.push("A win");
  } else if (target.firsts > 1) {
    parts.push(`${numberFormatter.format(target.firsts)} wins`);
  }

  if (target.seconds === 1) {
    parts.push("A 2nd-place finish");
  } else if (target.seconds > 1) {
    parts.push(`${numberFormatter.format(target.seconds)} 2nd-place finishes`);
  }

  if (target.thirds === 1) {
    parts.push("A 3rd-place finish");
  } else if (target.thirds > 1) {
    parts.push(`${numberFormatter.format(target.thirds)} 3rd-place finishes`);
  }

  if (parts.length === 0) {
    return "Keep chasing the podium.";
  }
  if (parts.length === 1) {
    return `${parts[0]} could move you up.`;
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1].toLowerCase()} could move you up.`;
  }

  return `${parts[0]}, ${parts[1].toLowerCase()}, and ${parts[2].toLowerCase()} could move you up.`;
}

function stepSubtitle(candidate) {
  if (candidate.rank === 1) {
    return "Everyone's chasing you.";
  }

  return `Only ${formatCount(candidate.distanceToNext, "step")} from ${ordinal(candidate.nextRank)}.`;
}

function challengeSubtitle(candidate) {
  if (candidate.rank === 1) {
    return "Everyone's chasing you.";
  }
  if (candidate.winsNeededToAdvance == null) {
    return "Keep stacking wins.";
  }
  if (candidate.winsNeededToAdvance === 1) {
    return "One more win could move you up.";
  }
  return `${numberFormatter.format(candidate.winsNeededToAdvance)} more wins could move you up.`;
}

function raceSubtitle(candidate) {
  if (candidate.rank === 1) {
    return "Everyone's chasing you.";
  }
  return describeRacePodiumTarget(candidate.podiumTarget);
}

function buildCard(leaderboardType, candidate) {
  const period = candidate.period || "allTime";
  const scope = scopeLabel(period, leaderboardType);
  const title = warmTitle(candidate.rank, scope, leaderboardType);
  const subtitle =
    leaderboardType === "steps"
      ? stepSubtitle(candidate)
      : leaderboardType === "challenges"
      ? challengeSubtitle(candidate)
      : raceSubtitle(candidate);

  return {
    id: `${leaderboardType}-${period}`,
    leaderboardType,
    period,
    title,
    subtitle,
    rank: candidate.rank,
  };
}

function cardPriority(card) {
  if (card.leaderboardType === "steps") {
    switch (card.period) {
      case "allTime":
        return 0;
      case "month":
        return 3;
      case "week":
        return 4;
      case "today":
      default:
        return 5;
    }
  }
  if (card.leaderboardType === "races") {
    return 1;
  }
  return 2;
}

function selectBestStepCandidate(stepCandidates = []) {
  for (const period of STEP_PERIOD_PRIORITY) {
    const candidate = stepCandidates.find((entry) => entry.period === period);
    if (candidate && candidate.rank <= MAX_HIGHLIGHT_RANK) {
      return candidate;
    }
  }

  return null;
}

function buildLeaderboardHighlightCards({ steps = [], challenges = null, races = null }) {
  const cards = [];

  const stepCandidate = selectBestStepCandidate(steps);
  if (stepCandidate) {
    cards.push(buildCard("steps", stepCandidate));
  }

  if (challenges && challenges.rank <= MAX_HIGHLIGHT_RANK) {
    cards.push(buildCard("challenges", { ...challenges, period: "allTime" }));
  }

  if (races && races.rank <= MAX_HIGHLIGHT_RANK) {
    cards.push(buildCard("races", { ...races, period: "allTime" }));
  }

  cards.sort((a, b) => {
    const aTier = a.rank <= 3 ? 0 : a.rank <= 10 ? 1 : 2;
    const bTier = b.rank <= 3 ? 0 : b.rank <= 10 ? 1 : 2;

    return (
      aTier - bTier ||
      a.rank - b.rank ||
      cardPriority(a) - cardPriority(b)
    );
  });

  return cards.slice(0, 3).map(({ rank, ...card }) => card);
}

module.exports = {
  MAX_HIGHLIGHT_RANK,
  buildLeaderboardHighlightCards,
  getChallengeWinsNeededToAdvance,
  getRacePodiumTargetToAdvance,
};
