const SOCIAL_REWARD_AMOUNT = 200;
const SOCIAL_REWARD_REASON = "social_follow_reward";
const SOCIAL_REWARDS = Object.freeze([
  { platform: "instagram", label: "Instagram", handle: "@bara.steps.app", url: "https://instagram.com/bara.steps.app" },
  { platform: "tiktok", label: "TikTok", handle: "@bara.app", url: "https://www.tiktok.com/@bara.app" },
  { platform: "x", label: "X", handle: "@BaraStepsApp", url: "https://x.com/BaraStepsApp" },
]);
const SOCIAL_REWARD_BY_PLATFORM = new Map(SOCIAL_REWARDS.map((item) => [item.platform, item]));

function getSocialReward(platform) {
  return SOCIAL_REWARD_BY_PLATFORM.get(platform) || null;
}

module.exports = { SOCIAL_REWARD_AMOUNT, SOCIAL_REWARD_REASON, SOCIAL_REWARDS, getSocialReward };
