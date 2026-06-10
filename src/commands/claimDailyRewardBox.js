const { prisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const { REWARD_TYPE } = require("../constants/dailyReward");
const {
  DailyRewardError,
  isValidLocalDate,
  withinOneDayOfServer,
} = require("./claimDailyReward");
const {
  getUnownedAccessoryPool,
} = require("../queries/getUnownedAccessoryPool");
const {
  computeNextCycleDay,
  computeNextLoginStreak,
} = require("../queries/getDailyRewardStatus");
const {
  rollDailyBoxRarity,
  coinAmountForTier,
  pickAccessory,
} = require("../utils/dailyBoxOdds");
const { serializeShopItem } = require("../utils/shopCosmetics");

// Daily reward v2: one mystery-box roll per day. Rarity odds and payout size
// scale with the user's consecutive-day login streak (see utils/dailyBoxOdds).
// COMMON/UNCOMMON pay coins; RARE pays an unowned accessory (coins fallback
// when the user owns everything). The legacy /claim path stays untouched for
// old app builds; both paths share the once-per-day guard via
// lastDailyClaimDate, so a user can never claim both in one day.
async function claimDailyRewardBox({ userId, localDate, rng = Math.random }) {
  if (!isValidLocalDate(localDate)) {
    throw new DailyRewardError("Invalid localDate (expected YYYY-MM-DD)", 400);
  }
  if (!withinOneDayOfServer(localDate)) {
    throw new DailyRewardError("localDate is too far from server time", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      lastDailyClaimDate: true,
      dailyStreakDay: true,
      dailyLoginStreak: true,
    },
  });
  if (!user) throw new DailyRewardError("User not found", 404);

  if (user.lastDailyClaimDate === localDate) {
    throw new DailyRewardError("Already claimed today", 409);
  }

  const loginStreak = computeNextLoginStreak(
    user.lastDailyClaimDate,
    user.dailyLoginStreak,
    user.dailyStreakDay,
    localDate
  );
  // Keep the legacy 6-day cycle advancing too, so old builds still render a
  // sane ladder if the user ever goes back to one.
  const cycleDay = computeNextCycleDay(
    user.lastDailyClaimDate,
    user.dailyStreakDay,
    localDate
  );

  const rarity = rollDailyBoxRarity(loginStreak, rng);

  let rewardType;
  let coinAmount = null;
  let shopItem = null;
  let coinsAfter = null;

  if (rarity === "RARE") {
    const pool = await getUnownedAccessoryPool(userId);
    const rolled = pickAccessory(pool, loginStreak, rng);
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
      coinAmount = coinAmountForTier("RARE_FALLBACK", loginStreak);
      const result = await awardCoins({
        userId,
        amount: coinAmount,
        reason: "daily_reward",
        refId: localDate,
      });
      rewardType = REWARD_TYPE.COINS_FALLBACK;
      coinsAfter = result.coins;
    }
  } else {
    coinAmount = coinAmountForTier(rarity, loginStreak);
    const result = await awardCoins({
      userId,
      amount: coinAmount,
      reason: "daily_reward",
      refId: localDate,
    });
    rewardType = REWARD_TYPE.COINS;
    coinsAfter = result.coins;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        lastDailyClaimDate: localDate,
        dailyStreakDay: cycleDay,
        dailyLoginStreak: loginStreak,
      },
    }),
    prisma.dailyRewardClaim.create({
      data: {
        userId,
        claimedDate: localDate,
        cycleDay,
        rewardType,
        rarity,
        coinAmount,
        shopItemId: shopItem ? shopItem.id : null,
      },
    }),
  ]);

  return {
    rarity,
    rewardType,
    coinAmount,
    shopItem: shopItem ? serializeShopItem(shopItem) : null,
    coins: coinsAfter,
    streak: loginStreak,
  };
}

module.exports = { claimDailyRewardBox };
