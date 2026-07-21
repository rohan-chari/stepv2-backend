// Shared, pure tournament constants + bracket math. Both the create path, the
// engine (start/advance), and the featured reconciler read these so the "who
// pairs with whom", "what a round is called", and "how big a buy-in is legal"
// rules live in exactly one place. The frontend mirrors these values in Dart.

// D4 ladder (revised 2026-07-16, second interview): the max buy-in scales with
// bracket size so a 4-bracket can't approach a ~1,000-coin pot. Pot caps are
// 400 / 800 / 992 for 4 / 8 / 16.
const TOURNAMENT_BUYIN_MAX = { 4: 100, 8: 100, 16: 62 };

const BRACKET_SIZES = [4, 8, 16];
const MATCHUP_DURATIONS = [1, 2, 3];

// Buy-ins below this (but non-zero) are rejected — mirrors race buy-ins.
const MIN_BUY_IN = 10;

// Featured tournaments mint a champion prize; the winnings cap is 1,000 coins.
const MAX_CHAMPION_PRIZE = 1000;

const TOURNAMENT_NAME_MAX_LENGTH = 30;

const TOURNAMENTS_FEATURE = "tournaments";

function totalRoundsFor(bracketSize) {
  return Math.round(Math.log2(bracketSize));
}

// Human label for a round, derived from how many players contest it:
// 2 -> FINAL, 4 -> SEMIFINALS, 8 -> QUARTERFINALS, 16 -> ROUND OF 16, else ROUND OF N.
function roundLabel(bracketSize, round) {
  const totalRounds = totalRoundsFor(bracketSize);
  const playersInRound = Math.pow(2, totalRounds - round + 1);
  switch (playersInRound) {
    case 2:
      return "FINAL";
    case 4:
      return "SEMIFINALS";
    case 8:
      return "QUARTERFINALS";
    case 16:
      return "ROUND OF 16";
    default:
      return `ROUND OF ${playersInRound}`;
  }
}

// Round-1 pairings over the assigned seeds: match i pairs seeds 2i and 2i+1.
function round1Pairings(bracketSize) {
  const pairs = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    pairs.push([2 * i, 2 * i + 1]);
  }
  return pairs;
}

// Pairings for round r+1 given the number of matches in round r (== winners
// available). Match i of the next round pairs the winners of round-r matches
// 2i and 2i+1. Returns pairs of PREVIOUS-round match indices.
function nextRoundPairings(prevRoundMatchCount) {
  const pairs = [];
  for (let i = 0; i < prevRoundMatchCount / 2; i++) {
    pairs.push([2 * i, 2 * i + 1]);
  }
  return pairs;
}

function validateBracketSize(bracketSize, ErrorClass) {
  if (!BRACKET_SIZES.includes(bracketSize)) {
    throw new ErrorClass("Bracket size must be 4, 8, or 16", 400, "VALIDATION");
  }
  return bracketSize;
}

function validateMatchupDuration(matchupDurationDays, ErrorClass) {
  if (!MATCHUP_DURATIONS.includes(matchupDurationDays)) {
    throw new ErrorClass(
      "Matchup duration must be 1, 2, or 3 days",
      400,
      "VALIDATION"
    );
  }
  return matchupDurationDays;
}

function validateTournamentName(name, ErrorClass) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new ErrorClass("Tournament name is required", 400, "VALIDATION");
  }
  const trimmed = name.trim();
  if (trimmed.length > TOURNAMENT_NAME_MAX_LENGTH) {
    throw new ErrorClass(
      `Tournament name must be ${TOURNAMENT_NAME_MAX_LENGTH} characters or less`,
      400,
      "VALIDATION"
    );
  }
  return trimmed;
}

// D4: buy-in is 0 (free) or MIN_BUY_IN..TOURNAMENT_BUYIN_MAX[bracketSize].
// bracketSize must already be validated by the caller.
function validateTournamentBuyIn({ bracketSize, buyInAmount, ErrorClass }) {
  const amount = buyInAmount == null ? 0 : buyInAmount;
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ErrorClass("Buy-in amount must be 0 or greater", 400, "VALIDATION");
  }
  if (amount === 0) return 0;
  if (amount < MIN_BUY_IN) {
    throw new ErrorClass(
      `Buy-in amount must be at least ${MIN_BUY_IN} coins`,
      400,
      "VALIDATION"
    );
  }
  const max = TOURNAMENT_BUYIN_MAX[bracketSize];
  if (max == null) {
    throw new ErrorClass("Bracket size must be 4, 8, or 16", 400, "VALIDATION");
  }
  if (amount > max) {
    throw new ErrorClass(
      `Buy-in for a ${bracketSize}-racer tournament cannot exceed ${max} coins`,
      400,
      "VALIDATION"
    );
  }
  return amount;
}

// D3/D6: decide a matchup winner between exactly two players.
//   1. A forfeited player always loses (a non-forfeited opponent wins).
//   2. Otherwise the higher effective totalSteps wins.
//   3. On an EXACT tie the earlier TournamentParticipant.joinedAt advances.
// `tie` is derived (both non-forfeited and equal totals) so honest UI copy can
// say "Tied — X advances on earlier entry". Never uses a userId sort.
// Each player: { userId, totalSteps, forfeited, tournamentJoinedAt }.
function resolveMatchupWinner(a, b) {
  const aForfeited = a.forfeited === true;
  const bForfeited = b.forfeited === true;

  const decide = (winner, loser, tie) => ({
    winnerUserId: winner.userId,
    loserUserId: loser.userId,
    tie,
  });

  if (aForfeited && !bForfeited) return decide(b, a, false);
  if (bForfeited && !aForfeited) return decide(a, b, false);

  const aSteps = a.totalSteps || 0;
  const bSteps = b.totalSteps || 0;
  if (aSteps !== bSteps) {
    return aSteps > bSteps ? decide(a, b, false) : decide(b, a, false);
  }

  // Equal totals. If both forfeited (documented can't-truly-happen) it is not a
  // real tie for refund purposes, but the earlier joiner still advances.
  const tie = !aForfeited && !bForfeited;
  const aJoined = new Date(a.tournamentJoinedAt).getTime();
  const bJoined = new Date(b.tournamentJoinedAt).getTime();
  if (aJoined !== bJoined) {
    return aJoined < bJoined ? decide(a, b, tie) : decide(b, a, tie);
  }
  // Fully identical (same instant) — last-resort deterministic userId sort.
  return String(a.userId) <= String(b.userId)
    ? decide(a, b, tie)
    : decide(b, a, tie);
}

function toFeatureSet(clientFeatures) {
  if (clientFeatures instanceof Set) return clientFeatures;
  return new Set(clientFeatures || []);
}

function clientSupportsTournaments(clientFeatures) {
  return toFeatureSet(clientFeatures).has(TOURNAMENTS_FEATURE);
}

module.exports = {
  TOURNAMENT_BUYIN_MAX,
  BRACKET_SIZES,
  MATCHUP_DURATIONS,
  MIN_BUY_IN,
  MAX_CHAMPION_PRIZE,
  TOURNAMENT_NAME_MAX_LENGTH,
  TOURNAMENTS_FEATURE,
  totalRoundsFor,
  roundLabel,
  round1Pairings,
  nextRoundPairings,
  validateBracketSize,
  validateMatchupDuration,
  validateTournamentName,
  validateTournamentBuyIn,
  resolveMatchupWinner,
  clientSupportsTournaments,
};
