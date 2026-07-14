const { prisma } = require("../db");
const {
  CYCLE_LENGTH,
  getRewardPreviewForDay,
} = require("../constants/dailyReward");
const {
  dailyBoxOddsForPool,
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_COIN_RANGES,
} = require("../utils/dailyBoxOdds");
const {
  getUnownedAccessoryPool,
} = require("./getUnownedAccessoryPool");
const {
  getEligiblePowerupPool,
} = require("./getEligiblePowerupPool");
const { serializeShopItem } = require("../utils/shopCosmetics");
const { serializePowerupShopItem } = require("../models/powerupShopItem");

// How many unowned accessories the status preview ships for the reel.
const ACCESSORY_POOL_PREVIEW_LIMIT = 10;

function previousDateString(dateStr) {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function computeNextCycleDay(prevDate, prevStreakDay, today) {
  if (prevDate === today) return prevStreakDay; // already claimed today
  if (prevDate === previousDateString(today) && prevStreakDay < CYCLE_LENGTH) {
    return prevStreakDay + 1;
  }
  // Missed a day, or just finished cycle (prevStreakDay === CYCLE_LENGTH).
  return 1;
}

// Unbounded consecutive-day login streak (daily box odds). Seeds from the
// legacy cycle day so users who already had a run going when daily_login_streak
// shipped (column defaults to 0) don't restart at 1.
function computeNextLoginStreak(prevDate, prevLoginStreak, legacyCycleDay, today) {
  const basis = Math.max(prevLoginStreak || 0, legacyCycleDay || 0);
  if (prevDate === today) return Math.max(1, basis); // already claimed today
  if (prevDate === previousDateString(today)) return basis + 1;
  return 1; // missed a day (or first ever claim)
}

async function getDailyRewardStatus({
  userId,
  localDate,
  // Feature/channel gating for the daily-box powerup prizes. Defaults keep the
  // legacy coins/accessory-only behavior for old clients (no `spinpowerups`
  // token): the powerup pool stays empty and RARE folds to 0 exactly as before.
  supportsSpinPowerups = false,
  supportsJammer = false,
  channel = "prod",
}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      lastDailyClaimDate: true,
      dailyStreakDay: true,
      dailyLoginStreak: true,
    },
  });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const claimedToday = user.lastDailyClaimDate === localDate;
  const projectedDay = claimedToday
    ? user.dailyStreakDay
    : computeNextCycleDay(
        user.lastDailyClaimDate,
        user.dailyStreakDay,
        localDate
      );

  const ladder = [];
  for (let day = 1; day <= CYCLE_LENGTH; day++) {
    ladder.push({
      day,
      reward: getRewardPreviewForDay(day),
      claimed: claimedToday && day <= projectedDay,
      isToday: day === projectedDay,
    });
  }

  // Daily box (v2): the streak today's claim would roll with, plus the rarity
  // odds for that streak. Additive field — old app builds ignore it and keep
  // rendering the ladder above; new app builds switch to the box UI only when
  // this field is present.
  const projectedStreak = computeNextLoginStreak(
    user.lastDailyClaimDate,
    user.dailyLoginStreak,
    user.dailyStreakDay,
    localDate
  );
  // Same pool the RARE roll draws from, so the reel previews real winnable
  // accessories (capped — it's display-only).
  const accessoryPool = await getUnownedAccessoryPool(userId);
  // Shop powerups are only rolled/previewed for spinpowerups-capable clients —
  // old binaries can't render a POWERUP tile/result. Non-flagged clients get an
  // empty pool, so their odds and payload are byte-identical to today.
  const powerupPool = supportsSpinPowerups
    ? await getEligiblePowerupPool({ channel, supportsJammer })
    : [];
  // Empty pools → RARE folded to 0 so shipped clients never draw the "???"
  // mystery-accessory tile (see dailyBoxOddsForPool). With powerups in play,
  // RARE stays alive even when every accessory is owned.
  const [common, uncommon, rare] = dailyBoxOddsForPool(
    projectedStreak,
    accessoryPool.length,
    powerupPool.length
  );

  const box = {
    streak: projectedStreak,
    streakCap: DAILY_BOX_STREAK_CAP,
    odds: { COMMON: common, UNCOMMON: uncommon, RARE: rare },
    coinRanges: {
      COMMON: DAILY_BOX_COIN_RANGES.COMMON,
      UNCOMMON: DAILY_BOX_COIN_RANGES.UNCOMMON,
    },
    accessoryPool: accessoryPool
      .slice(0, ACCESSORY_POOL_PREVIEW_LIMIT)
      .map((item) => serializeShopItem(item)),
  };

  // Additive: only spinpowerups-capable clients get these fields. `rarePrizeMix`
  // lets the client explain the RARE tier honestly in its odds sheet (what
  // share of a RARE is an accessory vs a powerup) without re-deriving the
  // 50/50-or-fold-to-one rule the command uses.
  if (supportsSpinPowerups) {
    box.powerupPool = powerupPool.map((item) => serializePowerupShopItem(item));
    const hasAccessory = accessoryPool.length > 0;
    const hasPowerup = powerupPool.length > 0;
    let accessoryShare = 0;
    let powerupShare = 0;
    if (hasAccessory && hasPowerup) {
      accessoryShare = 0.5;
      powerupShare = 0.5;
    } else if (hasPowerup) {
      powerupShare = 1;
    } else if (hasAccessory) {
      accessoryShare = 1;
    }
    box.rarePrizeMix = { ACCESSORY: accessoryShare, POWERUP: powerupShare };
  }

  return {
    cycleLength: CYCLE_LENGTH,
    currentDay: projectedDay,
    claimedToday,
    ladder,
    box,
  };
}

module.exports = {
  getDailyRewardStatus,
  computeNextCycleDay,
  computeNextLoginStreak,
  previousDateString,
};
