const { prisma } = require("../../db");
const { awardCoins: defaultAwardCoins } = require("../../shared/economy/awardCoins");
const { SOCIAL_REWARD_AMOUNT, SOCIAL_REWARD_REASON, SOCIAL_REWARDS, getSocialReward } = require("./config");

class SocialRewardError extends Error {
  constructor(message, statusCode = 400, code = "SOCIAL_REWARD_ERROR") {
    super(message); this.name = "SocialRewardError"; this.statusCode = statusCode; this.code = code;
  }
}

function present(item, row) {
  const claimed = row?.claimedAt != null;
  const opened = row?.openedAt != null;
  return {
    platform: item.platform, label: item.label, handle: item.handle, url: item.url,
    amount: SOCIAL_REWARD_AMOUNT,
    state: claimed ? "claimed" : opened ? "opened" : "not_started",
    openedAt: row?.openedAt || null, claimedAt: row?.claimedAt || null,
  };
}

async function status({ userId, db = prisma }) {
  const rows = await db.socialRewardClaim.findMany({ where: { userId } });
  const byPlatform = new Map(rows.map((row) => [row.platform, row]));
  const rewards = SOCIAL_REWARDS.map((item) => present(item, byPlatform.get(item.platform)));
  const totalClaimed = rewards.filter((item) => item.state === "claimed").reduce((sum, item) => sum + item.amount, 0);
  return { rewards, totalAvailable: SOCIAL_REWARDS.length * SOCIAL_REWARD_AMOUNT - totalClaimed, totalClaimed };
}

async function open({ userId, platform, db = prisma, now = new Date() }) {
  const item = getSocialReward(platform);
  if (!item) throw new SocialRewardError("Invalid social reward platform", 400, "INVALID_PLATFORM");
  const row = await db.socialRewardClaim.upsert({
    where: { userId_platform: { userId, platform } },
    create: { userId, platform, openedAt: now, rewardAmount: SOCIAL_REWARD_AMOUNT },
    update: { openedAt: { set: now } },
  });
  return present(item, row);
}

async function claim({ userId, platform, db = prisma, awardCoins = defaultAwardCoins, now = new Date() }) {
  const item = getSocialReward(platform);
  if (!item) throw new SocialRewardError("Invalid social reward platform", 400, "INVALID_PLATFORM");
  return db.$transaction(async (tx) => {
    let row = await tx.socialRewardClaim.findUnique({ where: { userId_platform: { userId, platform } } });
    if (!row || !row.openedAt) throw new SocialRewardError("Open the social profile before claiming", 409, "NOT_OPENED");
    if (row.claimedAt) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
      return { awarded: false, amount: 0, coins: user?.coins ?? 0, reward: present(item, row) };
    }
    row = await tx.socialRewardClaim.updateMany({
      where: { id: row.id, claimedAt: null }, data: { claimedAt: now, rewardAmount: SOCIAL_REWARD_AMOUNT },
    }).then(async (result) => {
      if (result.count !== 1) return tx.socialRewardClaim.findUnique({ where: { userId_platform: { userId, platform } } });
      return tx.socialRewardClaim.findUnique({ where: { userId_platform: { userId, platform } } });
    });
    if (!row?.claimedAt) throw new SocialRewardError("Unable to claim social reward", 409, "CLAIM_RETRY");
    const grant = await awardCoins({ tx, userId, amount: SOCIAL_REWARD_AMOUNT, reason: SOCIAL_REWARD_REASON, refId: platform });
    return { awarded: grant.awarded, amount: grant.awarded ? SOCIAL_REWARD_AMOUNT : 0, coins: grant.coins, reward: present(item, row) };
  });
}

module.exports = { SocialRewardError, status, open, claim };
