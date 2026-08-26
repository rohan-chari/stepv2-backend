const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  deriveStandingContext,
} = require("../../src/modules/giveaways/models/standingContext");

describe("giveaway standing context", () => {
  it("uses the full standings beyond the public leaderboard limit and handles a tie", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      entrantId: `entrant-${index + 1}`,
      verifiedCount: index < 25 ? 20 - Math.floor(index / 2) : 10,
      provisionalRank: index + 1,
    }));
    const mine = rows[26];

    assert.deepEqual(deriveStandingContext(rows, mine), {
      percentile: 90,
      nextTargetRank: 26,
      referralsBehindNextTarget: 1,
    });
  });

  it("returns percentile but no next target for first place", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      verifiedCount: 30 - index,
      provisionalRank: index + 1,
    }));
    assert.deepEqual(deriveStandingContext(rows, rows[0]), {
      percentile: 4,
      nextTargetRank: null,
      referralsBehindNextTarget: null,
    });
  });

  it("returns null context for an unranked entrant", () => {
    const rows = [
      { verifiedCount: 2, provisionalRank: 1 },
      { verifiedCount: 0, provisionalRank: null },
    ];
    assert.deepEqual(deriveStandingContext(rows, rows[1]), {
      percentile: null,
      nextTargetRank: null,
      referralsBehindNextTarget: null,
    });
  });

  it("derives the same context from final standings", () => {
    const rows = [
      { verifiedCount: 8, finalRank: 1 },
      { verifiedCount: 5, finalRank: 2 },
      { verifiedCount: 5, finalRank: 3 },
    ];
    assert.deepEqual(deriveStandingContext(rows, rows[2]), {
      percentile: 100,
      nextTargetRank: 2,
      referralsBehindNextTarget: 1,
    });
  });
});
