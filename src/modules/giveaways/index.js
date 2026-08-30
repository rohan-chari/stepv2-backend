const { createGiveawayPublicRouter } = require("./routes/public");
const { createGiveawayAdminRouter } = require("./routes/admin");
const { buildGiveawayService } = require("./services/giveawayService");
const { deriveContestStatus } = require("./models/contest");
const {
  buildGiveawayRetention,
  scheduleGiveawayRetention,
} = require("./jobs/retention");
const {
  invalidateActiveContestBannerCache,
  resolveActiveContestBanner,
} = require("./queries/activeContestBanner");
const { buildAmendStandardRules } = require("./commands/amendStandardRules");

async function resolveContestBanner({ prisma, slug, now = new Date() }) {
  if (!slug || typeof slug !== "string") return null;
  const contest = await prisma.giveawayContest.findUnique({ where: { slug } });
  if (!contest || contest.lifecycleStatus !== "PUBLISHED") return null;
  const status = deriveContestStatus(contest, now);
  if (!["SCHEDULED", "ACTIVE", "VERIFYING"].includes(status)) return null;
  return { type: "contest", contestSlug: contest.slug };
}

module.exports = {
  buildGiveawayService,
  buildAmendStandardRules,
  buildGiveawayRetention,
  createGiveawayAdminRouter,
  createGiveawayPublicRouter,
  invalidateActiveContestBannerCache,
  resolveActiveContestBanner,
  resolveContestBanner,
  scheduleGiveawayRetention,
};
