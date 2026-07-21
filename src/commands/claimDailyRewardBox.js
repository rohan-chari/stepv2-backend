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
  getEligiblePowerupPool,
} = require("../queries/getEligiblePowerupPool");
const {
  computeNextCycleDay,
  computeNextLoginStreak,
} = require("../queries/getDailyRewardStatus");
const {
  rollDailyBoxRarity,
  rollRarePrizeKind,
  coinAmountForTier,
  pickAccessory,
  pickPowerup,
} = require("../utils/dailyBoxOdds");
const { balanceConfig } = require("../services/balanceConfig");
const { serializeShopItem } = require("../utils/shopCosmetics");
const { serializePowerupShopItem } = require("../models/powerupShopItem");
const { grantPowerupToUser } = require("./grantPowerupToUser");

// Daily reward v2: one mystery-box roll per day. Rarity odds and payout size
// scale with the user's consecutive-day login streak (see utils/dailyBoxOdds).
// COMMON/UNCOMMON pay coins; RARE pays a prize: an unowned accessory or — for
// `spinpowerups`-capable clients — a shop powerup (sub-rolled 50/50 when both
// pools have stock; see rollRarePrizeKind). When NO prize is available (all
// accessories owned AND no powerups offered, e.g. old clients), RARE odds fold
// to 0 (see dailyBoxOddsForPool) so the tier is never rolled. Old app builds
// (no `spinpowerups` token) get the exact legacy coins/accessory-only roll. The
// legacy /claim path stays untouched; both paths share the once-per-day guard
// via lastDailyClaimDate, so a user can never claim both in one day.
async function claimDailyRewardBox({
  userId,
  localDate,
  rng = Math.random,
  // Feature/channel gating for powerup prizes. Defaults reproduce the legacy
  // coins/accessory-only roll for old clients (no `spinpowerups` token): the
  // powerup pool stays empty, so RARE can only pay an accessory (or fold to 0),
  // and a POWERUP is never rolled or returned.
  supportsSpinPowerups = false,
  supportsJammer = false,
  channel = "prod",
}) {
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

  // Pools fetched before the roll so the odds match what getDailyRewardStatus
  // displayed. When BOTH are empty, RARE folds to 0 and can't be rolled; the
  // coins-fallback branch below stays as a safety net only. The powerup pool is
  // empty for non-spinpowerups clients, so their roll is unchanged.
  // Read the balance config ONCE and thread it through every step of the roll,
  // so the pool, the rarity odds and the payout ranges are guaranteed to come
  // from a single version. Relying on the synchronous cache here would let the
  // pool be built from one config and the odds from another.
  const { config: balance } = await balanceConfig.getSnapshot();

  const pool = await getUnownedAccessoryPool(userId);
  const powerupPool = supportsSpinPowerups
    ? await getEligiblePowerupPool({ channel, supportsJammer, config: balance })
    : [];
  const rarity = rollDailyBoxRarity(
    loginStreak,
    rng,
    pool.length,
    powerupPool.length,
    balance
  );

  let rewardType;
  let coinAmount = null;
  let shopItem = null;
  let powerup = null;
  let coinsAfter = null;

  if (rarity === "RARE") {
    // Sub-roll the RARE prize: accessory vs shop powerup (see rollRarePrizeKind).
    const prizeKind = rollRarePrizeKind(pool.length, powerupPool.length, rng, { config: balance });
    if (prizeKind === "POWERUP") {
      powerup = pickPowerup(powerupPool, loginStreak, rng, balance);
    }
    const rolledAccessory =
      prizeKind === "ACCESSORY" ? pickAccessory(pool, loginStreak, rng, balance) : null;

    if (powerup) {
      rewardType = REWARD_TYPE.POWERUP;
      await grantPowerupToUser(userId, powerup.powerupType);
      const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      coinsAfter = userRow?.coins ?? 0;
    } else if (rolledAccessory) {
      shopItem = rolledAccessory;
      rewardType = REWARD_TYPE.ACCESSORY;
      await prisma.userShopItem.create({
        data: { userId, shopItemId: rolledAccessory.id },
      });
      const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      coinsAfter = userRow?.coins ?? 0;
    } else {
      coinAmount = coinAmountForTier("RARE_FALLBACK", loginStreak, balance);
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
    coinAmount = coinAmountForTier(rarity, loginStreak, balance);
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
        powerupType: powerup ? powerup.powerupType : null,
      },
    }),
  ]);

  return {
    rarity,
    rewardType,
    coinAmount,
    shopItem: shopItem ? serializeShopItem(shopItem) : null,
    powerup: powerup ? serializePowerupShopItem(powerup) : null,
    coins: coinsAfter,
    streak: loginStreak,
  };
}

module.exports = { claimDailyRewardBox };
