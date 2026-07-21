const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClaimExtraDailyRewardBox,
} = require("../../src/modules/economy/commands/claimExtraDailyRewardBox");
const { DailyRewardError } = require("../../src/modules/economy/commands/claimDailyReward");

// The command validates localDate against real server time (same guard as the
// free daily claim), so tests use the actual current date.
function todayLocalDate() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
const TODAY = todayLocalDate();

// Mock prisma. adRewardGrant.findFirst dispatches on the consumedAt filter:
// `{ not: null }` = "was the extra spin already used today", `null` = "is
// there a verified, unconsumed grant to redeem".
function mockDb({
  user = { lastDailyClaimDate: TODAY, dailyStreakDay: 3, dailyLoginStreak: 3 },
  consumedGrant = null,
  pendingGrant = { id: "grant-1", grantedDate: TODAY },
  consumeCount = 1,
} = {}) {
  const calls = { grantUpdates: [], userUpdates: [], shopItemCreates: [] };
  return {
    calls,
    user: {
      findUnique: async ({ select }) => {
        if (select && select.coins) return { coins: 555 };
        return user;
      },
      update: async (args) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
    userShopItem: {
      create: async ({ data }) => {
        calls.shopItemCreates.push(data);
        return data;
      },
    },
    adRewardGrant: {
      findFirst: async ({ where }) => {
        if (where.consumedAt && where.consumedAt.not === null) {
          return consumedGrant;
        }
        return pendingGrant;
      },
      updateMany: async (args) => {
        calls.grantUpdates.push(args);
        return { count: consumeCount };
      },
      update: async (args) => {
        calls.grantUpdates.push(args);
        return {};
      },
    },
  };
}

function buildCommand({ db, awarded = [], pool = [] } = {}) {
  return buildClaimExtraDailyRewardBox({
    prisma: db,
    awardCoins: async (args) => {
      awarded.push(args);
      return { awarded: true, coins: 999 };
    },
    getUnownedAccessoryPool: async () => pool,
  });
}

async function expectError(promise, statusCode, messagePart) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof DailyRewardError, `expected DailyRewardError, got ${err}`);
    assert.equal(err.statusCode, statusCode);
    if (messagePart) assert.match(err.message, messagePart);
    return true;
  });
}

test("extra box: rejects an invalid localDate", async () => {
  const claim = buildCommand({ db: mockDb() });
  await expectError(claim({ userId: "u1", localDate: "07/06/2026" }), 400);
});

test("extra box: requires the free daily claim first", async () => {
  const db = mockDb({
    user: { lastDailyClaimDate: null, dailyStreakDay: 0, dailyLoginStreak: 0 },
  });
  const claim = buildCommand({ db });
  await expectError(
    claim({ userId: "u1", localDate: TODAY }),
    409,
    /free daily/i
  );
});

test("extra box: rejects when the extra spin was already used today", async () => {
  const db = mockDb({ consumedGrant: { id: "grant-0" } });
  const claim = buildCommand({ db });
  await expectError(
    claim({ userId: "u1", localDate: TODAY }),
    409,
    /already used/i
  );
});

test("extra box: rejects with AD_NOT_VERIFIED when no grant exists", async () => {
  const db = mockDb({ pendingGrant: null });
  const claim = buildCommand({ db });
  await assert.rejects(claim({ userId: "u1", localDate: TODAY }), (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "AD_NOT_VERIFIED");
    return true;
  });
});

test("extra box: happy path (coins) consumes the grant and pays via awardCoins", async () => {
  const db = mockDb();
  const awarded = [];
  const claim = buildCommand({ db, awarded });

  const result = await claim({ userId: "u1", localDate: TODAY, rng: () => 0 });

  assert.equal(result.rarity, "COMMON");
  assert.equal(result.rewardType, "COINS");
  assert.ok(result.coinAmount > 0);
  assert.equal(result.coins, 999);
  assert.equal(result.extra, true);

  // Grant consumed conditionally (consumedAt: null in the where clause).
  const consume = db.calls.grantUpdates.find((u) => u.where.consumedAt === null);
  assert.ok(consume, "expected a conditional consume updateMany");
  assert.equal(consume.where.id, "grant-1");

  // Coin mint is idempotent on the grant id.
  assert.equal(awarded.length, 1);
  assert.equal(awarded[0].reason, "ad_extra_spin");
  assert.equal(awarded[0].refId, "grant-1");

  // The extra spin never touches streak/claim-date state.
  assert.equal(db.calls.userUpdates.length, 0);
});

test("extra box: RARE pays an unowned accessory, no coin mint", async () => {
  const db = mockDb();
  const awarded = [];
  const pool = [{ id: "item-7", priceCoins: 500, name: "Beaver Tail" }];
  const claim = buildCommand({ db, awarded, pool });

  const result = await claim({ userId: "u1", localDate: TODAY, rng: () => 0.999 });

  assert.equal(result.rarity, "RARE");
  assert.equal(result.rewardType, "ACCESSORY");
  assert.equal(db.calls.shopItemCreates.length, 1);
  assert.equal(db.calls.shopItemCreates[0].shopItemId, "item-7");
  assert.equal(awarded.length, 0);
  assert.equal(result.coins, 555);
});

test("extra box: raced consume (count 0) rejects instead of double-paying", async () => {
  const db = mockDb({ consumeCount: 0 });
  const awarded = [];
  const claim = buildCommand({ db, awarded });
  await expectError(claim({ userId: "u1", localDate: TODAY }), 409);
  assert.equal(awarded.length, 0);
});

test("extra box: records the roll result on the grant row", async () => {
  const db = mockDb();
  const claim = buildCommand({ db });
  await claim({ userId: "u1", localDate: TODAY, rng: () => 0 });

  const resultWrite = db.calls.grantUpdates.find(
    (u) => u.data && u.data.rewardType
  );
  assert.ok(resultWrite, "expected the roll result written to the grant");
  assert.equal(resultWrite.data.rarity, "COMMON");
  assert.ok(resultWrite.data.coinAmount > 0);
});
