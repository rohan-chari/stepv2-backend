const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  TOURNAMENT_BUYIN_MAX,
  BRACKET_SIZES,
  MATCHUP_DURATIONS,
  totalRoundsFor,
  roundLabel,
  validateTournamentBuyIn,
  validateBracketSize,
  validateMatchupDuration,
  validateTournamentName,
  round1Pairings,
  nextRoundPairings,
  clientSupportsTournaments,
  resolveMatchupWinner,
  TOURNAMENTS_FEATURE,
} = require("../../src/constants/tournaments");

class Err extends Error {
  constructor(message, statusCode, code) {
    super(message);
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

describe("tournaments constants — bracket math", () => {
  it("totalRoundsFor is log2 of the bracket size", () => {
    assert.equal(totalRoundsFor(4), 2);
    assert.equal(totalRoundsFor(8), 3);
    assert.equal(totalRoundsFor(16), 4);
  });

  it("round labels for a 16-bracket", () => {
    assert.equal(roundLabel(16, 1), "ROUND OF 16");
    assert.equal(roundLabel(16, 2), "QUARTERFINALS");
    assert.equal(roundLabel(16, 3), "SEMIFINALS");
    assert.equal(roundLabel(16, 4), "FINAL");
  });

  it("round labels for an 8-bracket", () => {
    assert.equal(roundLabel(8, 1), "QUARTERFINALS");
    assert.equal(roundLabel(8, 2), "SEMIFINALS");
    assert.equal(roundLabel(8, 3), "FINAL");
  });

  it("round labels for a 4-bracket", () => {
    assert.equal(roundLabel(4, 1), "SEMIFINALS");
    assert.equal(roundLabel(4, 2), "FINAL");
  });

  it("round-1 pairings pair seeds 2i and 2i+1", () => {
    assert.deepEqual(round1Pairings(4), [
      [0, 1],
      [2, 3],
    ]);
    assert.deepEqual(round1Pairings(8), [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
  });

  it("next-round pairings pair winners of matches 2i and 2i+1", () => {
    // round 1 of an 8-bracket has 4 matches -> round 2 has 2 matches:
    // match 0 = winners of (0,1), match 1 = winners of (2,3)
    assert.deepEqual(nextRoundPairings(4), [
      [0, 1],
      [2, 3],
    ]);
    assert.deepEqual(nextRoundPairings(2), [[0, 1]]);
  });
});

describe("tournaments constants — validation", () => {
  it("accepts only 4/8/16 bracket sizes", () => {
    for (const size of BRACKET_SIZES) {
      assert.equal(validateBracketSize(size, Err), size);
    }
    for (const bad of [2, 3, 5, 6, 32, 0, null, "8"]) {
      assert.throws(() => validateBracketSize(bad, Err));
    }
  });

  it("accepts only 1/2/3 day durations", () => {
    for (const d of MATCHUP_DURATIONS) {
      assert.equal(validateMatchupDuration(d, Err), d);
    }
    for (const bad of [0, 4, 7, null, "2"]) {
      assert.throws(() => validateMatchupDuration(bad, Err));
    }
  });

  it("name must be 1..30 chars", () => {
    assert.equal(validateTournamentName("Friday Gauntlet", Err), "Friday Gauntlet");
    assert.throws(() => validateTournamentName("", Err));
    assert.throws(() => validateTournamentName("   ", Err));
    assert.throws(() => validateTournamentName("x".repeat(31), Err));
  });

  it("buy-in ladder: 0 is free; caps are 100/100/62; pots never exceed 400/800/992", () => {
    // Free is always allowed.
    for (const size of BRACKET_SIZES) {
      assert.equal(validateTournamentBuyIn({ bracketSize: size, buyInAmount: 0, ErrorClass: Err }), 0);
    }
    // Max per size.
    assert.equal(validateTournamentBuyIn({ bracketSize: 4, buyInAmount: 100, ErrorClass: Err }), 100);
    assert.equal(validateTournamentBuyIn({ bracketSize: 8, buyInAmount: 100, ErrorClass: Err }), 100);
    assert.equal(validateTournamentBuyIn({ bracketSize: 16, buyInAmount: 62, ErrorClass: Err }), 62);

    // Just over the cap fails and pot would exceed the cap.
    assert.throws(() => validateTournamentBuyIn({ bracketSize: 4, buyInAmount: 101, ErrorClass: Err }));
    assert.throws(() => validateTournamentBuyIn({ bracketSize: 16, buyInAmount: 63, ErrorClass: Err }));

    // Pots at the cap never exceed 400/800/992.
    assert.ok(4 * TOURNAMENT_BUYIN_MAX[4] <= 400);
    assert.ok(8 * TOURNAMENT_BUYIN_MAX[8] <= 800);
    assert.ok(16 * TOURNAMENT_BUYIN_MAX[16] <= 992);

    // Below-minimum non-zero (1..9) rejected, mirroring race buy-ins.
    assert.throws(() => validateTournamentBuyIn({ bracketSize: 8, buyInAmount: 5, ErrorClass: Err }));
  });
});

describe("tournaments — matchup winner resolution (D3)", () => {
  const early = new Date("2026-07-01T00:00:00Z");
  const late = new Date("2026-07-02T00:00:00Z");

  it("higher steps wins, not a tie", () => {
    const r = resolveMatchupWinner(
      { userId: "a", totalSteps: 18452, forfeited: false, tournamentJoinedAt: late },
      { userId: "b", totalSteps: 12001, forfeited: false, tournamentJoinedAt: early }
    );
    assert.equal(r.winnerUserId, "a");
    assert.equal(r.loserUserId, "b");
    assert.equal(r.tie, false);
  });

  it("exact tie -> earlier tournament joinedAt advances, tie flagged", () => {
    const r = resolveMatchupWinner(
      { userId: "a", totalSteps: 5000, forfeited: false, tournamentJoinedAt: late },
      { userId: "b", totalSteps: 5000, forfeited: false, tournamentJoinedAt: early }
    );
    assert.equal(r.winnerUserId, "b"); // earlier joiner
    assert.equal(r.tie, true);
  });

  it("does NOT use userId sort on a tie (earlier joinedAt beats lexicographic)", () => {
    // "a" < "z" lexicographically, but "z" joined earlier -> "z" advances.
    const r = resolveMatchupWinner(
      { userId: "a", totalSteps: 7000, forfeited: false, tournamentJoinedAt: late },
      { userId: "z", totalSteps: 7000, forfeited: false, tournamentJoinedAt: early }
    );
    assert.equal(r.winnerUserId, "z");
    assert.equal(r.tie, true);
  });

  it("forfeited player always loses regardless of steps", () => {
    const r = resolveMatchupWinner(
      { userId: "a", totalSteps: 99999, forfeited: true, tournamentJoinedAt: early },
      { userId: "b", totalSteps: 10, forfeited: false, tournamentJoinedAt: late }
    );
    assert.equal(r.winnerUserId, "b");
    assert.equal(r.tie, false);
  });
});

describe("tournaments constants — feature gate", () => {
  it("clientSupportsTournaments reads the sticky token", () => {
    assert.equal(TOURNAMENTS_FEATURE, "tournaments");
    assert.equal(clientSupportsTournaments(new Set(["tournaments"])), true);
    assert.equal(clientSupportsTournaments(["tournaments"]), true);
    assert.equal(clientSupportsTournaments(new Set(["team_races"])), false);
    assert.equal(clientSupportsTournaments(null), false);
  });
});
