const assert = require("node:assert/strict");
const test = require("node:test");

const { buildSettleRankedSeason } = require("../../src/commands/settleRankedSeason");

const FIXED_NOW = new Date("2026-06-15T12:00:00Z");
const SILENT = { log() {}, error() {} };

function makeCtx({ claimCount = 1, season, standings = [] } = {}) {
  const finals = [];
  const awards = [];
  const tierWrites = [];
  const events = [];
  const created = [];
  let closed = null;

  const Season = {
    async claimForSettlement() {
      return claimCount;
    },
    async getById() {
      return season;
    },
    async markClosed(id, settledAt) {
      closed = { id, settledAt };
    },
    async create(data) {
      const next = { id: `season-${created.length + 2}`, ...data };
      created.push(next);
      return next;
    },
  };

  const SeasonScore = {
    async writeFinal(row) {
      finals.push(row);
    },
  };

  const settle = buildSettleRankedSeason({
    Season,
    SeasonScore,
    Steps: {},
    recomputeStandings: async () => standings,
    awardCoins: async (args) => {
      awards.push(args);
      return { awarded: true, coins: args.amount };
    },
    setUserTier: async (userId, tier, division) => {
      tierWrites.push({ userId, tier, division });
    },
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    now: () => FIXED_NOW,
    seasonDurationDays: 30,
    logger: SILENT,
  });

  return { settle, finals, awards, tierWrites, events, created, get closed() { return closed; } };
}

test("settleRankedSeason is a no-op when the claim is lost (already settling)", async () => {
  const ctx = makeCtx({ claimCount: 0 });
  const result = await ctx.settle({ seasonId: "s1" });

  assert.equal(result, null);
  assert.equal(ctx.finals.length, 0);
  assert.equal(ctx.awards.length, 0);
});

test("settleRankedSeason writes finals, mints tier rewards, sets badges, rolls next season", async () => {
  const ctx = makeCtx({
    claimCount: 1,
    season: { id: "s5", index: 5, endsAt: new Date("2026-06-15T00:00:00Z") },
    standings: [
      { userId: "u_diamond", points: 2000, earnedPoints: 2000, carryOverSeed: 0, rank: 1, tier: "DIAMOND", division: null },
      { userId: "u_bronze", points: 120, earnedPoints: 120, carryOverSeed: 0, rank: 2, tier: "BRONZE", division: 3 },
    ],
  });

  const result = await ctx.settle({ seasonId: "s5" });

  // finals written for both
  assert.equal(ctx.finals.length, 2);

  // TIER_REWARDS were all zeroed at the Ranked-v2 cutover (coins now mint weekly
  // via settleRankedWeek), and settlement skips 0-coin mints, so season-end
  // settlement makes no coin awards.
  assert.equal(ctx.awards.length, 0);

  // denormalized badges
  assert.deepEqual(
    ctx.tierWrites.find((t) => t.userId === "u_diamond"),
    { userId: "u_diamond", tier: "DIAMOND", division: null }
  );

  // events emitted with zero coins, season closed, next season opened at index + 1
  const rewardEvents = ctx.events.filter((e) => e.name === "SEASON_REWARD_GRANTED");
  assert.equal(rewardEvents.length, 2);
  assert.ok(rewardEvents.every((e) => e.payload.coins === 0));
  assert.equal(ctx.closed.id, "s5");
  assert.equal(ctx.created[0].index, 6);
  assert.equal(result.settledIndex, 5);
  assert.equal(result.ranked, 2);
});
