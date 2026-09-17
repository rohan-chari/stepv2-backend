const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { status, open, claim, SocialRewardError } = require("../../src/modules/socialRewards/service");

function fakeDb(row = null, coins = 10) {
  const state = { row, coins, grants: 0 };
  const client = {
    socialRewardClaim: {
      findMany: async () => (state.row ? [state.row] : []),
      findUnique: async () => state.row,
      upsert: async ({ create }) => { state.row ??= { ...create, id: "claim-1", claimedAt: null }; return state.row; },
      updateMany: async ({ data }) => { if (state.row?.claimedAt) return { count: 0 }; state.row = { ...state.row, ...data }; return { count: 1 }; },
    },
    user: { findUnique: async () => ({ coins: state.coins }) },
    $transaction: async (fn) => fn(client),
  };
  return { ...client, state };
}

describe("social reward service", () => {
  it("returns all three server-owned platforms", async () => {
    const result = await status({ userId: "u1", db: fakeDb() });
    assert.deepEqual(result.rewards.map((r) => [r.platform, r.handle, r.amount]), [
      ["instagram", "@bara.steps.app", 200], ["tiktok", "@bara.app", 200], ["x", "@BaraStepsApp", 200],
    ]);
    assert.equal(result.totalAvailable, 600);
  });
  it("open is idempotent and never grants", async () => {
    const db = fakeDb();
    const first = await open({ userId: "u1", platform: "instagram", db });
    const second = await open({ userId: "u1", platform: "instagram", db });
    assert.equal(first.state, "opened"); assert.equal(second.state, "opened"); assert.equal(db.state.coins, 10);
  });
  it("requires open and uses the fixed amount through the award seam", async () => {
    const db = fakeDb();
    await assert.rejects(() => claim({ userId: "u1", platform: "x", db }), (error) => error instanceof SocialRewardError && error.code === "NOT_OPENED");
    await open({ userId: "u1", platform: "x", db });
    const result = await claim({ userId: "u1", platform: "x", db, awardCoins: async ({ amount }) => { db.state.grants += amount; db.state.coins += amount; return { awarded: true, coins: db.state.coins }; } });
    assert.equal(result.amount, 200); assert.equal(db.state.grants, 200); assert.equal(db.state.row.claimedAt != null, true);
  });
  it("rejects arbitrary platforms", async () => {
    await assert.rejects(() => open({ userId: "u1", platform: "facebook", db: fakeDb() }), /Invalid social reward platform/);
  });
});
