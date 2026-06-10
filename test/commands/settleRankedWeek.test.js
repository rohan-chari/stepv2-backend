const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSettleRankedWeek,
  resolveOutcome,
} = require("../../src/commands/settleRankedWeek");

const FIXED_NOW = new Date("2026-06-15T18:00:00Z");
const SILENT = { log() {}, error() {}, warn() {} };

// ── resolveOutcome (pure) ────────────────────────────────────────────────────

test("resolveOutcome promotes the active top zone into the next tier with bonus", () => {
  const r = resolveOutcome({ rank: 1, size: 30, tier: "GOLD", activeDays: 5 });
  assert.equal(r.outcome, "PROMOTE");
  assert.equal(r.resultTier, "PLATINUM");
  assert.equal(r.rewardCoins, 300); // 200 * 1.5
  assert.equal(r.promotionCoins, 350); // Platinum entry bonus
});

test("resolveOutcome demotes the bottom zone one tier with no pay", () => {
  const r = resolveOutcome({ rank: 30, size: 30, tier: "GOLD", activeDays: 5 });
  assert.equal(r.outcome, "DEMOTE");
  assert.equal(r.resultTier, "SILVER");
  assert.equal(r.rewardCoins, 0);
  assert.equal(r.promotionCoins, 0);
});

test("resolveOutcome holds the middle in its tier", () => {
  const r = resolveOutcome({ rank: 15, size: 30, tier: "SILVER", activeDays: 3 });
  assert.equal(r.outcome, "HOLD");
  assert.equal(r.resultTier, "SILVER");
  assert.equal(r.promotionCoins, 0);
});

test("resolveOutcome never promotes or pays an idle member, even at rank 1", () => {
  const r = resolveOutcome({ rank: 1, size: 30, tier: "GOLD", activeDays: 0 });
  assert.equal(r.outcome, "HOLD");
  assert.equal(r.resultTier, "GOLD");
  assert.equal(r.rewardCoins, 0);
  assert.equal(r.promotionCoins, 0);
});

test("resolveOutcome still demotes an idle member in the demotion zone", () => {
  const r = resolveOutcome({ rank: 29, size: 30, tier: "PLATINUM", activeDays: 0 });
  assert.equal(r.outcome, "DEMOTE");
  assert.equal(r.resultTier, "GOLD");
});

test("resolveOutcome: Bronze never demotes, Legend never promotes", () => {
  const bottom = resolveOutcome({ rank: 30, size: 30, tier: "BRONZE", activeDays: 0 });
  assert.equal(bottom.outcome, "HOLD");
  const top = resolveOutcome({ rank: 1, size: 30, tier: "LEGEND", activeDays: 7 });
  assert.equal(top.outcome, "HOLD");
  assert.equal(top.rewardCoins, 600); // still paid for winning the cohort
});

// ── settleRankedWeek (orchestration with fakes) ──────────────────────────────

function makeCtx({
  claimCount = 1,
  week = {
    id: "week-1",
    index: 1,
    startsOn: new Date("2026-06-08T00:00:00Z"),
    endsOn: new Date("2026-06-15T00:00:00Z"),
  },
  members = [],
  stepRows = [],
} = {}) {
  const finals = [];
  const awards = [];
  const tierWrites = [];
  const legendGrants = [];
  const events = [];
  let closed = null;

  const settle = buildSettleRankedWeek({
    RankedWeek: {
      async claimForSettlement() {
        return claimCount;
      },
      async getById() {
        return week;
      },
      async markClosed(id, settledAt) {
        closed = { id, settledAt };
      },
    },
    RankedCohortMember: {
      async listForWeek() {
        return members;
      },
      async writeFinal(row) {
        finals.push(row);
      },
    },
    Steps: {
      async findRowsInRange() {
        return stepRows;
      },
    },
    awardCoins: async (args) => {
      const duplicate = awards.some(
        (a) => a.reason === args.reason && a.refId === args.refId && a.userId === args.userId
      );
      awards.push(args);
      return { awarded: !duplicate, coins: args.amount };
    },
    grantLegendCosmetic: async ({ userId }) => {
      legendGrants.push(userId);
      return { granted: true };
    },
    setUserTier: async (userId, tier, since) => {
      tierWrites.push({ userId, tier, since });
    },
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    now: () => FIXED_NOW,
    logger: SILENT,
  });

  return {
    settle,
    finals,
    awards,
    tierWrites,
    legendGrants,
    events,
    get closed() {
      return closed;
    },
  };
}

function member(userId, cohortId, tier) {
  return { id: `m-${userId}`, userId, cohortId, weekId: "week-1", tier };
}

function day(userId, dayOffset, steps) {
  const date = new Date("2026-06-08T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return { userId, date, steps };
}

test("settleRankedWeek is a no-op when the claim is lost", async () => {
  const ctx = makeCtx({ claimCount: 0 });
  const result = await ctx.settle({ weekId: "week-1" });
  assert.equal(result, null);
  assert.equal(ctx.finals.length, 0);
  assert.equal(ctx.awards.length, 0);
});

test("settleRankedWeek ranks a cohort, pays placements, and closes the week", async () => {
  const ctx = makeCtx({
    members: [member("a", "c1", "SILVER"), member("b", "c1", "SILVER"), member("c", "c1", "SILVER")],
    stepRows: [day("a", 0, 9000), day("b", 0, 20000), day("c", 0, 6000)],
  });
  const result = await ctx.settle({ weekId: "week-1" });

  assert.equal(result.members, 3);
  // b walked the most → rank 1, promotes out of a 3-person cohort (zone = 1).
  const b = ctx.finals.find((f) => f.id === "m-b");
  assert.equal(b.finalRank, 1);
  assert.equal(b.outcome, "PROMOTE");
  assert.equal(b.resultTier, "GOLD");
  // a holds at rank 2, c demotes at rank 3.
  assert.equal(ctx.finals.find((f) => f.id === "m-a").outcome, "HOLD");
  const c = ctx.finals.find((f) => f.id === "m-c");
  assert.equal(c.outcome, "DEMOTE");
  assert.equal(c.resultTier, "BRONZE");

  // Weekly reward refIds are week+user scoped.
  const weekly = ctx.awards.filter((a) => a.reason === "ranked_week_reward");
  assert.ok(weekly.every((a) => a.refId === `week:week-1:user:${a.userId}`));
  // Promotion bonus is tier-scoped (first entry ever).
  const promo = ctx.awards.find((a) => a.reason === "ranked_promotion_bonus");
  assert.equal(promo.userId, "b");
  assert.equal(promo.refId, "tier:GOLD:user:b");
  assert.equal(promo.amount, 200);

  // Every member's home tier is (re)written; week is closed.
  assert.equal(ctx.tierWrites.length, 3);
  assert.deepEqual(ctx.closed, { id: "week-1", settledAt: FIXED_NOW });
});

test("settleRankedWeek pays nothing to inactive members", async () => {
  const ctx = makeCtx({
    members: [member("a", "c1", "BRONZE"), member("b", "c1", "BRONZE")],
    stepRows: [day("a", 0, 4000)], // under the 5k active floor; b never synced
  });
  await ctx.settle({ weekId: "week-1" });
  assert.equal(ctx.awards.length, 0);
  assert.ok(ctx.finals.every((f) => f.rewardCoins === 0));
});

test("settleRankedWeek grants the Legend cosmetic to members ending in LEGEND", async () => {
  const ctx = makeCtx({
    members: [
      member("a", "c1", "DIAMOND"),
      member("b", "c1", "DIAMOND"),
      member("c", "c1", "DIAMOND"),
    ],
    stepRows: [day("a", 0, 90000), day("b", 0, 8000), day("c", 0, 7000)],
  });
  await ctx.settle({ weekId: "week-1" });
  // a promotes Diamond → Legend and gets the crown + 1000 bonus.
  assert.deepEqual(ctx.legendGrants, ["a"]);
  const promo = ctx.awards.find((x) => x.reason === "ranked_promotion_bonus");
  assert.equal(promo.amount, 1000);
  assert.equal(promo.refId, "tier:LEGEND:user:a");
});

test("settleRankedWeek settles cohorts independently", async () => {
  const ctx = makeCtx({
    members: [
      member("a", "c1", "BRONZE"),
      member("b", "c1", "BRONZE"),
      member("x", "c2", "GOLD"),
      member("y", "c2", "GOLD"),
    ],
    stepRows: [
      day("a", 0, 10000),
      day("b", 0, 8000),
      day("x", 0, 50000),
      day("y", 0, 60000),
    ],
  });
  await ctx.settle({ weekId: "week-1" });
  // Ranks are per-cohort: both cohorts have a rank-1 member.
  const rank1s = ctx.finals.filter((f) => f.finalRank === 1);
  assert.equal(rank1s.length, 2);
});
