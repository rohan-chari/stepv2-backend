const { prisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const {
  DAILY_COIN_LADDER,
  CYCLE_LENGTH,
  DAY_6_FALLBACK_COINS,
  REWARD_TYPE,
} = require("../constants/dailyReward");
const {
  computeNextCycleDay,
} = require("../queries/getDailyRewardStatus");
const { serializeShopItem } = require("../utils/shopCosmetics");

class DailyRewardError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "DailyRewardError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function isValidLocalDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function withinOneDayOfServer(localDate) {
  const serverToday = new Date().toISOString().slice(0, 10);
  const diffDays =
    Math.abs(new Date(localDate) - new Date(serverToday)) /
    (1000 * 60 * 60 * 24);
  return diffDays <= 1.5;
}

async function rollAccessory(userId) {
  const [activeItems, owned] = await Promise.all([
    prisma.shopItem.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.userShopItem.findMany({
      where: { userId },
      select: { shopItemId: true },
    }),
  ]);
  const ownedIds = new Set(owned.map((r) => r.shopItemId));
  const pool = activeItems.filter((item) => !ownedIds.has(item.id));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function claimDailyReward({ userId, localDate }) {
  if (!isValidLocalDate(localDate)) {
    throw new DailyRewardError("Invalid localDate (expected YYYY-MM-DD)", 400);
  }
  if (!withinOneDayOfServer(localDate)) {
    throw new DailyRewardError("localDate is too far from server time", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastDailyClaimDate: true, dailyStreakDay: true },
  });
  if (!user) throw new DailyRewardError("User not found", 404);

  if (user.lastDailyClaimDate === localDate) {
    throw new DailyRewardError("Already claimed today", 409);
  }

  const cycleDay = computeNextCycleDay(
    user.lastDailyClaimDate,
    user.dailyStreakDay,
    localDate
  );

  let rewardType;
  let coinAmount = null;
  let shopItem = null;
  let coinsAfter = null;

  if (cycleDay < CYCLE_LENGTH) {
    coinAmount = DAILY_COIN_LADDER[cycleDay - 1];
    const result = await awardCoins({
      userId,
      amount: coinAmount,
      reason: "daily_reward",
      refId: localDate,
    });
    rewardType = REWARD_TYPE.COINS;
    coinsAfter = result.coins;
  } else {
    // Day 6: try to grant a fresh accessory; fallback to coins if all owned.
    const rolled = await rollAccessory(userId);
    if (rolled) {
      shopItem = rolled;
      rewardType = REWARD_TYPE.ACCESSORY;
      await prisma.userShopItem.create({
        data: { userId, shopItemId: rolled.id },
      });
      const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      coinsAfter = userRow?.coins ?? 0;
    } else {
      coinAmount = DAY_6_FALLBACK_COINS;
      const result = await awardCoins({
        userId,
        amount: coinAmount,
        reason: "daily_reward",
        refId: localDate,
      });
      rewardType = REWARD_TYPE.COINS_FALLBACK;
      coinsAfter = result.coins;
    }
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { lastDailyClaimDate: localDate, dailyStreakDay: cycleDay },
    }),
    prisma.dailyRewardClaim.create({
      data: {
        userId,
        claimedDate: localDate,
        cycleDay,
        rewardType,
        coinAmount,
        shopItemId: shopItem ? shopItem.id : null,
      },
    }),
  ]);

  return {
    cycleDay,
    rewardType,
    coinAmount,
    shopItem: shopItem ? serializeShopItem(shopItem) : null,
    coins: coinsAfter,
  };
}

module.exports = { claimDailyReward, DailyRewardError };
