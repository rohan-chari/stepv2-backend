const assert = require("node:assert/strict");
const test = require("node:test");

const { buildComputeRanks } = require("../../src/jobs/computeRanks");

const FIXED_NOW = new Date("2026-06-15T12:00:00Z");
const SILENT = { log() {}, error() {} };

function makeCtx({
  activeSeason = null,
  latestIndex = 0,
  standings = [],
  rankedSettlementEnabled = true,
} = {}) {
  const created = [];
  const provisionalWrites = [];
  const settleCalls = [];

  const Season = {
    async getActive() {
      return activeSeason;
    },
    async getLatestIndex() {
      return latestIndex;
    },
    async create(data) {
      const season = { id: `season-${created.length + 1}`, status: "ACTIVE", ...data };
      created.push(season);
      return season;
    },
  };

  const SeasonScore = {
    async writeProvisional(row) {
      provisionalWrites.push(row);
      return row;
    },
  };

  const computeRanks = buildComputeRanks({
    rankedSettlementEnabled,
    Season,
    SeasonScore,
    Steps: {},
    recomputeStandings: async () => standings,
    settleRankedSeason: async (args) => {
      settleCalls.push(args);
      return { settledIndex: 0, ranked: 0, nextSeasonId: "next" };
    },
    now: () => FIXED_NOW,
    logger: SILENT,
    seasonDurationDays: 30,
  });

  return { computeRanks, created, provisionalWrites, settleCalls };
}

test("computeRanks opens the first season when none is active", async () => {
  const ctx = makeCtx({ activeSeason: null, latestIndex: 0 });

  await ctx.computeRanks();

  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].index, 1);
  // endsAt is 30 days out, so the brand-new season is not immediately settled.
  assert.equal(ctx.settleCalls.length, 0);
});

test("computeRanks numbers the next season after the latest index", async () => {
  const ctx = makeCtx({ activeSeason: null, latestIndex: 7 });
  await ctx.computeRanks();
  assert.equal(ctx.created[0].index, 8);
});

test("computeRanks refreshes provisional standings without settling a live season", async () => {
  const ctx = makeCtx({
    activeSeason: {
      id: "season-live",
      index: 3,
      endsAt: new Date("2026-07-01T00:00:00Z"), // future
    },
    standings: [
      { userId: "u1", points: 1200, earnedPoints: 1200, carryOverSeed: 0, rank: 1, tier: "GOLD", division: 2 },
      { userId: "u2", points: 600, earnedPoints: 600, carryOverSeed: 0, rank: 2, tier: "SILVER", division: 3 },
    ],
  });

  await ctx.computeRanks();

  assert.equal(ctx.provisionalWrites.length, 2);
  assert.equal(ctx.provisionalWrites[0].userId, "u1");
  assert.equal(ctx.provisionalWrites[0].seasonId, "season-live");
  assert.equal(ctx.provisionalWrites[0].tier, "GOLD");
  assert.equal(ctx.settleCalls.length, 0);
});

test("computeRanks settles a season whose end time has passed", async () => {
  const ctx = makeCtx({
    activeSeason: {
      id: "season-ended",
      index: 4,
      endsAt: new Date("2026-06-01T00:00:00Z"), // before FIXED_NOW
    },
    standings: [],
  });

  await ctx.computeRanks();

  assert.equal(ctx.settleCalls.length, 1);
  assert.deepEqual(ctx.settleCalls[0], { seasonId: "season-ended" });
});

// Ranked is paused (product decision 2026-07-01): with the kill switch off —
// the shipped default — the tick is a complete no-op: no season is opened, no
// provisional standings are written, and an ended season is NOT settled (season
// settlement mints ranked_season_reward coins).
test("kill switch (default): the tick does nothing — no season, no standings, no settle", async () => {
  const ctx = makeCtx({
    activeSeason: null,
    latestIndex: 3,
    rankedSettlementEnabled: false,
  });
  const result = await ctx.computeRanks();

  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.provisionalWrites.length, 0);
  assert.equal(ctx.settleCalls.length, 0);
  assert.deepEqual(result, { disabled: true, seasonIndex: null, ranked: 0 });
});

test("kill switch: an ended season is NOT settled (no coins minted)", async () => {
  const ctx = makeCtx({
    activeSeason: {
      id: "season-ended",
      index: 4,
      endsAt: new Date("2026-06-01T00:00:00Z"), // before FIXED_NOW
    },
    standings: [
      { userId: "u1", points: 1200, earnedPoints: 1200, carryOverSeed: 0, rank: 1, tier: "GOLD", division: 2 },
    ],
    rankedSettlementEnabled: false,
  });
  await ctx.computeRanks();

  assert.equal(ctx.settleCalls.length, 0);
  assert.equal(ctx.provisionalWrites.length, 0);
});
