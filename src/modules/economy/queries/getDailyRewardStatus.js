const { prisma } = require("../../../db");
const {
  CYCLE_LENGTH,
  getRewardPreviewForDay,
} = require("../constants/dailyReward");
const {
  dailyBoxOddsForPool,
  rarePrizeMix,
  pickProbabilities,
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_COIN_RANGES,
} = require("../dailyBoxOdds");
const { balanceConfig } = require("../balanceConfig");
const {
  getUnownedAccessoryPool,
} = require("../../cosmetics");
const {
  getEligiblePowerupPool,
} = require("../../powerups");
const { serializeShopItem } = require("../../cosmetics");
const { serializePowerupShopItem } = require("../../powerups");

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
  // Read the balance config FIRST so every downstream consumer in this request
  // uses the same version. getEligiblePowerupPool otherwise falls back to the
  // synchronous cache, which can still hold the previous config for up to the
  // TTL — the pool would then be built from an older version than the odds
  // reported alongside it.
  const { version: configVersion, config } = await balanceConfig.getSnapshot();

  const accessoryPool = await getUnownedAccessoryPool(userId);
  // Shop powerups are only rolled/previewed for spinpowerups-capable clients —
  // old binaries can't render a POWERUP tile/result. Non-flagged clients get an
  // empty pool, so their odds and payload are byte-identical to today.
  const powerupPool = supportsSpinPowerups
    ? await getEligiblePowerupPool({ channel, supportsJammer, config })
    : [];
  // Empty pools → RARE folded to 0 so shipped clients never draw the "???"
  // mystery-accessory tile (see dailyBoxOddsForPool). With powerups in play,
  // RARE stays alive even when every accessory is owned.
  const [common, uncommon, rare] = dailyBoxOddsForPool(
    projectedStreak,
    accessoryPool.length,
    powerupPool.length,
    config
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
    // UNCHANGED and still sent: frozen clients read this exact shape. It omits
    // the COINS slice and is therefore wrong whenever rareCoinsShare > 0 — the
    // additive `itemOdds.rareMix` below is the corrected version. Do not "fix"
    // this field; old binaries depend on its current meaning.
    box.rarePrizeMix = { ACCESSORY: accessoryShare, POWERUP: powerupShare };
  }

  // §5.3 — additive `itemOdds`: the exact odds a player is up against, derived
  // from the same helpers the roll uses. Absent fields (rather than nulls) let a
  // client presence-check, and a client that does not understand this key simply
  // ignores it.
  const accessoryProbabilities = pickProbabilities(
    accessoryPool,
    projectedStreak,
    config
  );
  const powerupProbabilities = pickProbabilities(
    powerupPool,
    projectedStreak,
    config
  );
  const accessories = accessoryPool
    .map((item, i) => ({ sku: item.sku, p: accessoryProbabilities[i] }))
    .slice(0, ACCESSORY_POOL_PREVIEW_LIMIT);
  const powerups = powerupPool.map((item, i) => ({
    type: item.powerupType,
    p: powerupProbabilities[i],
  }));

  box.itemOdds = {
    configVersion,
    rarity: { COMMON: common, UNCOMMON: uncommon, RARE: rare },
    // Unlike rarePrizeMix, this INCLUDES the COINS slice and always sums to 1.
    rareMix: rarePrizeMix(accessoryPool.length, powerupPool.length, config),
    ...(accessories.length > 0 ? { accessories } : {}),
    ...(powerups.length > 0 ? { powerups } : {}),
  };

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
