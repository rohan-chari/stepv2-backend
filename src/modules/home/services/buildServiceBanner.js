const { resolveContestBanner } = require("../../giveaways");
const { isAllowedBannerMessage } = require("../../giveaways/services/validation");

async function buildServiceBanner({ settings, prisma, supportsReferralContest, now = new Date() }) {
  const keys = [
    "homeServiceBannerEnabled",
    "homeServiceBannerMessage",
    "homeServiceBannerContestSlug",
  ];
  const shared = typeof settings.getSharedFlags === "function"
    ? await settings.getSharedFlags(keys)
    : Object.fromEntries(await Promise.all(
        keys.map(async (key) => [key, await settings.getFlag(key)]),
      ));
  const enabled = shared.homeServiceBannerEnabled;
  const rawMessage = shared.homeServiceBannerMessage;
  const rawSlug = shared.homeServiceBannerContestSlug;
  if (enabled !== true || typeof rawMessage !== "string") return null;
  const message = rawMessage.trim();
  if (message.length < 1 || message.length > 240) return null;
  const slug = typeof rawSlug === "string" ? rawSlug.trim() : "";
  if (!slug) return { enabled: true, message };
  // A contest-linked notice is an all-or-nothing capable-client contract. Old
  // binaries must not receive advertising for a flow/rules surface they lack.
  if (supportsReferralContest !== true) return null;
  const action = await resolveContestBanner({ prisma, slug, now });
  if (!action) return null;
  const contest = await prisma.giveawayContest.findUnique({
    where: { slug }, select: { bannerMessage: true, cashCurrency: true, cashMinor: true, coinPrize: true },
  });
  return contest?.bannerMessage === message && isAllowedBannerMessage(message, contest)
    ? { enabled: true, message, action } : null;
}

module.exports = { buildServiceBanner };
