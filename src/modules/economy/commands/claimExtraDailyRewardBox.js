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
const { goldMembershipForUser } = require("../../billing/queries/goldPolicy");

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

    const { isMember: goldMember } = await goldMembershipForUser(db, userId);
    const alreadyGoldUsed = goldMember && db.goldActionClaim
      ? await db.goldActionClaim.findUnique({ where: { userId_action_localDate: { userId, action: "extra_daily_spin", localDate } } })
      : null;
    if (alreadyGoldUsed) {
      if (!alreadyGoldUsed.resultJson) throw new DailyRewardError("Extra spin already used today", 409);
      return { ...alreadyGoldUsed.resultJson, idempotent: true };
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

    let claim = null;
    if (goldMember && db.goldActionClaim) {
      claim = await db.goldActionClaim.create({ data: { userId, action: "extra_daily_spin", localDate } }).catch(async (error) => {
        if (error?.code === "P2002") {
          const existing = await db.goldActionClaim.findUnique({ where: { userId_action_localDate: { userId, action: "extra_daily_spin", localDate } } });
          if (existing?.resultJson) return existing;
        }
        throw error;
      });
      if (claim?.resultJson) return { ...claim.resultJson, idempotent: true };
    }
    const grant = goldMember ? null : await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: EXTRA_SPIN_REWARD_KIND,
        grantedDate: localDate,
        consumedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!goldMember && !grant) {
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
    const consumed = goldMember ? { count: 1 } : await db.adRewardGrant.updateMany({
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
      ? await getPowerupPool({ channel, supportsJammer, supportsPowerups2, supportsPowerups3, supportsPowerups4, supportsPowerups5, isGoldMember: goldMember })
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
    const rewardRef = grant?.id || claim?.id;
    const rewardReason = goldMember ? "gold_extra_spin" : "ad_extra_spin";

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
          reason: rewardReason,
          refId: rewardRef,
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
        reason: rewardReason,
        refId: rewardRef,
      });
      rewardType = REWARD_TYPE.COINS;
      coinsAfter = result.coins;
    }

    if (!goldMember) await db.adRewardGrant.update({
      where: { id: grant.id },
      data: {
        rewardType,
        rarity,
        coinAmount,
        shopItemId: shopItem ? shopItem.id : null,
        powerupType: powerup ? powerup.powerupType : null,
      },
    });

    const result = {
      rarity,
      rewardType,
      coinAmount,
      shopItem: shopItem ? serializeShopItem(shopItem) : null,
      powerup: powerup ? serializePowerupShopItem(powerup, { isGoldMember: goldMember }) : null,
      coins: coinsAfter,
      streak,
      extra: true,
      ...(goldMember ? { bypassedByGold: true } : {}),
    };
    if (claim) await db.goldActionClaim.update({ where: { id: claim.id }, data: { resultJson: result } });
    return result;
  };
}

const claimExtraDailyRewardBox = buildClaimExtraDailyRewardBox();

module.exports = { buildClaimExtraDailyRewardBox, claimExtraDailyRewardBox };
