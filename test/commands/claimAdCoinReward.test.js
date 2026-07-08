const assert = require("node:assert/strict");
const test = require("node:test");

const { buildClaimAdCoinReward } = require("../../src/commands/claimAdCoinReward");
const {
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
} = require("../../src/config/adRewards");

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

// In-memory adRewardGrant store mirroring the prisma calls the command makes.
function mockDb({ grants = [] } = {}) {
  const rows = grants.map((g, i) => ({
    id: g.id || `grant-${i}`,
    userId: g.userId || "user-1",
    rewardKind: g.rewardKind || "coin_reward",
    grantedDate: g.grantedDate || todayLocal(),
    consumedAt: g.consumedAt ?? null,
    createdAt: g.createdAt || new Date(2026, 0, 1, 0, 0, i),
    rewardType: null,
    coinAmount: null,
  }));

  const matches = (row, where) =>
    (!where.userId || row.userId === where.userId) &&
    (!where.rewardKind || row.rewardKind === where.rewardKind) &&
    (!where.grantedDate || row.grantedDate === where.grantedDate) &&
    (!("consumedAt" in where) ||
      (where.consumedAt === null
        ? row.consumedAt === null
        : where.consumedAt.not === null
          ? row.consumedAt !== null
          : true)) &&
    (!where.id || row.id === where.id);

  return {
    rows,
    adRewardGrant: {
      count: async ({ where }) => rows.filter((r) => matches(r, where)).length,
      findFirst: async ({ where, orderBy }) => {
        let found = rows.filter((r) => matches(r, where));
        if (orderBy?.createdAt === "asc") {
          found = found.sort((a, b) => a.createdAt - b.createdAt);
        }
        return found[0] || null;
      },
      updateMany: async ({ where, data }) => {
        const found = rows.filter((r) => matches(r, where));
        found.forEach((r) => Object.assign(r, data));
        return { count: found.length };
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

function mockAwardCoins() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { awarded: true, coins: 500 + args.amount };
  };
  fn.calls = calls;
  return fn;
}

test("claimAdCoinReward: consumes the oldest grant and mints the coin reward", async () => {
  const db = mockDb({
    grants: [{ id: "g-old" }, { id: "g-new", createdAt: new Date(2027, 0, 1) }],
  });
  const awardCoins = mockAwardCoins();
  const claim = buildClaimAdCoinReward({ prisma: db, awardCoins });

  const result = await claim({ userId: "user-1", localDate: todayLocal() });

  assert.equal(result.coinAmount, AD_COIN_REWARD_AMOUNT);
  assert.equal(result.coins, 500 + AD_COIN_REWARD_AMOUNT);
  assert.equal(result.remainingToday, AD_COIN_REWARD_DAILY_CAP - 1);
  assert.equal(awardCoins.calls.length, 1);
  assert.equal(awardCoins.calls[0].reason, "ad_coin_reward");
  assert.equal(awardCoins.calls[0].refId, "g-old");
  const consumed = db.rows.find((r) => r.id === "g-old");
  assert.ok(consumed.consumedAt instanceof Date);
  assert.equal(consumed.rewardType, "COINS");
  assert.equal(consumed.coinAmount, AD_COIN_REWARD_AMOUNT);
  const untouched = db.rows.find((r) => r.id === "g-new");
  assert.equal(untouched.consumedAt, null);
});

test("claimAdCoinReward: 409 AD_NOT_VERIFIED when no unconsumed grant exists", async () => {
  const db = mockDb();
  const claim = buildClaimAdCoinReward({ prisma: db, awardCoins: mockAwardCoins() });

  await assert.rejects(
    claim({ userId: "user-1", localDate: todayLocal() }),
    (err) => err.statusCode === 409 && err.code === "AD_NOT_VERIFIED"
  );
});

test("claimAdCoinReward: 409 DAILY_CAP_REACHED once the cap is consumed", async () => {
  const consumedAt = new Date();
  const db = mockDb({
    grants: [
      ...Array.from({ length: AD_COIN_REWARD_DAILY_CAP }, (_, i) => ({
        id: `used-${i}`,
        consumedAt,
      })),
      { id: "g-pending" },
    ],
  });
  const awardCoins = mockAwardCoins();
  const claim = buildClaimAdCoinReward({ prisma: db, awardCoins });

  await assert.rejects(
    claim({ userId: "user-1", localDate: todayLocal() }),
    (err) => err.statusCode === 409 && err.code === "DAILY_CAP_REACHED"
  );
  assert.equal(awardCoins.calls.length, 0);
});

test("claimAdCoinReward: grants from another day never count toward today", async () => {
  const db = mockDb({
    grants: [{ id: "g-yesterday", grantedDate: "2020-01-01" }],
  });
  const claim = buildClaimAdCoinReward({ prisma: db, awardCoins: mockAwardCoins() });

  await assert.rejects(
    claim({ userId: "user-1", localDate: todayLocal() }),
    (err) => err.statusCode === 409 && err.code === "AD_NOT_VERIFIED"
  );
});

test("claimAdCoinReward: concurrent double-consume loses the conditional update", async () => {
  const db = mockDb({ grants: [{ id: "g-1" }] });
  // Simulate the race: another request consumed the grant between findFirst
  // and updateMany.
  const realUpdateMany = db.adRewardGrant.updateMany;
  db.adRewardGrant.updateMany = async (args) => {
    db.rows[0].consumedAt = new Date();
    return realUpdateMany(args);
  };
  const awardCoins = mockAwardCoins();
  const claim = buildClaimAdCoinReward({ prisma: db, awardCoins });

  await assert.rejects(
    claim({ userId: "user-1", localDate: todayLocal() }),
    (err) => err.statusCode === 409
  );
  assert.equal(awardCoins.calls.length, 0);
});

test("claimAdCoinReward: invalid localDate is a 400", async () => {
  const claim = buildClaimAdCoinReward({
    prisma: mockDb(),
    awardCoins: mockAwardCoins(),
  });

  await assert.rejects(
    claim({ userId: "user-1", localDate: "07/06/2026" }),
    (err) => err.statusCode === 400
  );
});
