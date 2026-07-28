const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { REWARD_TYPE } = require("../constants/dailyReward");
const {
  DailyRewardError,
  isValidLocalDate,
  withinOneDayOfServer,
} = require("./claimDailyReward");
const {
  getUnownedAccessoryPool,
} = require("../../cosmetics");
const {
  getEligiblePowerupPool,
} = require("../../powerups");
const {
  rollDailyBoxRarity,
  rollRarePrizeKind,
  coinAmountForTier,
  pickAccessory,
  pickPowerup,
} = require("../dailyBoxOdds");
const { serializeShopItem } = require("../../cosmetics");
const { serializePowerupShopItem } = require("../../powerups");
const { grantPowerupToUser } = require("../../powerups");
const { EXTRA_SPIN_REWARD_KIND } = require("../adRewards");
const { balanceConfig: defaultBalanceConfig } = require("../balanceConfig");

// Extra daily box spin, paid for by a verified rewarded-ad watch. Consumes an
// unconsumed AdRewardGrant for the same localDate (minted only by the AdMob
// SSV callback — the client is never trusted), then rolls the SAME box as the
// free /claim-box at the user's current streak. Deliberately does NOT touch
// lastDailyClaimDate / streaks / DailyRewardClaim: the free-claim guards (and
// their @@unique) stay load-bearing, and tomorrow's streak math is unaffected
// by whether an extra spin happened. Response matches /claim-box so shipped
// reel/reveal UI renders it unchanged (plus `extra: true`).
function buildClaimExtraDailyRewardBox(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const getPool =
    dependencies.getUnownedAccessoryPool || getUnownedAccessoryPool;
  const getPowerupPool =
    dependencies.getEligiblePowerupPool || getEligiblePowerupPool;
  const grantPowerup =
    dependencies.grantPowerupToUser || grantPowerupToUser;
  const balanceConfig = dependencies.balanceConfig || defaultBalanceConfig;

  return async function claimExtraDailyRewardBox({
    userId,
    localDate,
    rng = Math.random,
    // Same feature/channel gating as the free /claim-box (see there). Defaults
    // keep the legacy coins/accessory-only roll for old clients.
    supportsSpinPowerups = false,
    supportsJammer = false,
    supportsPowerups2 = false,
    supportsPowerups3 = false,
    supportsPowerups4 = false,
    supportsPowerups5 = false,
    channel = "prod",
  }) {
    if (!isValidLocalDate(localDate)) {
      throw new DailyRewardError("Invalid localDate (expected YYYY-MM-DD)", 400);
    }
    if (!withinOneDayOfServer(localDate)) {
      throw new DailyRewardError("localDate is too far from server time", 400);
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        lastDailyClaimDate: true,
        dailyStreakDay: true,
        dailyLoginStreak: true,
      },
    });
    if (!user) throw new DailyRewardError("User not found", 404);

    // The ad offers "one MORE spin" — the free one must exist first, which
    // also means the streak counters below are already today's values.
    if (user.lastDailyClaimDate !== localDate) {
      throw new DailyRewardError("Claim your free daily box first", 409);
    }

    const alreadyUsed = await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: EXTRA_SPIN_REWARD_KIND,
        grantedDate: localDate,
        consumedAt: { not: null },
      },
      select: { id: true },
    });
    if (alreadyUsed) {
      throw new DailyRewardError("Extra spin already used today", 409);
    }

    const grant = await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: EXTRA_SPIN_REWARD_KIND,
        grantedDate: localDate,
        consumedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!grant) {
      const err = new DailyRewardError(
        "No verified ad reward available yet",
        409
      );
      // The client retries briefly on this code — the SSV callback can lag
      // the on-device earned-reward event by a few seconds.
      err.code = "AD_NOT_VERIFIED";
      throw err;
    }

    // Conditional consume: a concurrent duplicate claim loses here (count 0)
    // before anything mints.
    const consumed = await db.adRewardGrant.updateMany({
      where: { id: grant.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!consumed || consumed.count === 0) {
      throw new DailyRewardError("Extra spin already used today", 409);
    }

    // Streak already advanced by today's free claim — max(1, basis) keeps 0
    // legacy rows sane, matching computeNextLoginStreak's claimed-today branch.
    const streak = Math.max(
      1,
      user.dailyLoginStreak || 0,
      user.dailyStreakDay || 0
    );

    const { config: balance } = await balanceConfig.getSnapshot();
    const pool = await getPool(userId);
    const powerupPool = supportsSpinPowerups
      ? await getPowerupPool({ channel, supportsJammer, supportsPowerups2, supportsPowerups3, supportsPowerups4, supportsPowerups5 })
      : [];
    const rarity = rollDailyBoxRarity(
      streak,
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
      const prizeKind = rollRarePrizeKind(pool.length, powerupPool.length, rng, { config: balance });
      if (prizeKind === "POWERUP") {
        powerup = pickPowerup(powerupPool, streak, rng, balance);
      }
      const rolledAccessory =
        prizeKind === "ACCESSORY" ? pickAccessory(pool, streak, rng, balance) : null;

      if (powerup) {
        rewardType = REWARD_TYPE.POWERUP;
        await grantPowerup(userId, powerup.powerupType, { db });
        const userRow = await db.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        coinsAfter = userRow?.coins ?? 0;
      } else if (rolledAccessory) {
        shopItem = rolledAccessory;
        rewardType = REWARD_TYPE.ACCESSORY;
        await db.userShopItem.create({
          data: { userId, shopItemId: rolledAccessory.id },
        });
        const userRow = await db.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        coinsAfter = userRow?.coins ?? 0;
      } else {
        coinAmount = coinAmountForTier("RARE_FALLBACK", streak);
        const result = await awardCoinsFn({
          userId,
          amount: coinAmount,
          reason: "ad_extra_spin",
          refId: grant.id,
        });
        rewardType = REWARD_TYPE.COINS_FALLBACK;
        coinsAfter = result.coins;
      }
    } else {
      coinAmount = coinAmountForTier(rarity, streak);
      // Idempotent on the grant id, so a retry after a crash between consume
      // and mint can't double-pay.
      const result = await awardCoinsFn({
        userId,
        amount: coinAmount,
        reason: "ad_extra_spin",
        refId: grant.id,
      });
      rewardType = REWARD_TYPE.COINS;
      coinsAfter = result.coins;
    }

    await db.adRewardGrant.update({
      where: { id: grant.id },
      data: {
        rewardType,
        rarity,
        coinAmount,
        shopItemId: shopItem ? shopItem.id : null,
        powerupType: powerup ? powerup.powerupType : null,
      },
    });

    return {
      rarity,
      rewardType,
      coinAmount,
      shopItem: shopItem ? serializeShopItem(shopItem) : null,
      powerup: powerup ? serializePowerupShopItem(powerup) : null,
      coins: coinsAfter,
      streak,
      extra: true,
    };
  };
}

const claimExtraDailyRewardBox = buildClaimExtraDailyRewardBox();

module.exports = { buildClaimExtraDailyRewardBox, claimExtraDailyRewardBox };
