const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { deriveContestStatus } = require("../models/contest");
const { isAllowedBannerMessage } = require("../services/validation");

const TITLE_MAX_LENGTH = 120;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const CACHE_TTL_SECONDS = 15;

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function bannerFromContest(contest, now) {
  if (!contest || contest.lifecycleStatus !== "PUBLISHED") return null;
  if (deriveContestStatus(contest, now) !== "ACTIVE") return null;
  const title = typeof contest.title === "string" ? contest.title.trim() : "";
  if (title.length < 1 || title.length > TITLE_MAX_LENGTH) return null;
  const slug = typeof contest.slug === "string" ? contest.slug.trim() : "";
  if (!SLUG_RE.test(slug)) return null;
  const coinPrize = Number(contest.coinPrize);
  if (!Number.isSafeInteger(coinPrize) || coinPrize <= 0) return null;
  const endsAt = validDate(contest.endsAt);
  if (!endsAt || endsAt <= now) return null;
  const eligibilityMode = contest.eligibilityMode === "BARA_ACCOUNT" ? "BARA_ACCOUNT" : "US_18";
  const message = typeof contest.bannerMessage === "string" ? contest.bannerMessage.trim() : "";
  if (eligibilityMode === "BARA_ACCOUNT" && !isAllowedBannerMessage(message, { eligibilityMode })) return null;
  return {
    type: "referral_contest",
    contestSlug: slug,
    title,
    status: "ACTIVE",
    endsAt: endsAt.toISOString(),
    coinPrize,
    eligibilityMode,
    ...(eligibilityMode === "BARA_ACCOUNT" ? { message } : {}),
  };
}

async function loadActiveContestBanner({ prisma, now }) {
  try {
    const contests = await prisma.giveawayContest.findMany({
      where: {
        lifecycleStatus: "PUBLISHED",
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      select: {
        slug: true,
        title: true,
        lifecycleStatus: true,
        startsAt: true,
        endsAt: true,
        coinPrize: true,
        eligibilityMode: true,
        bannerMessage: true,
      },
      take: 2,
      orderBy: { startsAt: "desc" },
    });
    if (contests.length !== 1) return null;
    return bannerFromContest(contests[0], now);
  } catch {
    return null;
  }
}

async function resolveActiveContestBanner({ prisma, now = new Date(), includeEligibilityMode = false }) {
  const current = validDate(now) || new Date();
  const cacheRead = () => derivedCache.cachedRead({
    key: cacheKeys.homeGiveawayBanner(),
    prefix: cacheKeys.PREFIX.HOME_GIVEAWAY_BANNER,
    ttlSeconds: CACHE_TTL_SECONDS,
    enabled: true,
    load: () => loadActiveContestBanner({ prisma, now: current }),
  });
  let banner = await cacheRead();
  const cacheShapeIsCurrent = (value) => value == null || (
    value && typeof value === "object" &&
    ["US_18", "BARA_ACCOUNT"].includes(value.eligibilityMode) &&
    (value.eligibilityMode !== "BARA_ACCOUNT" ||
      isAllowedBannerMessage(value.message, { eligibilityMode: "BARA_ACCOUNT" }))
  );
  // An old worker may populate this stable v1 key without the new mode/message
  // fields during a rolling deploy. That payload is ambiguous, so never infer
  // legacy eligibility from it: evict and reload Postgres fail-closed.
  if (!cacheShapeIsCurrent(banner)) {
    await invalidateActiveContestBannerCache();
    banner = await cacheRead();
    // A still-running old worker can race the invalidation and repopulate the
    // ambiguous value immediately. Bypass Redis for this request if so.
    if (!cacheShapeIsCurrent(banner)) {
      banner = await loadActiveContestBanner({ prisma, now: current });
    }
  }
  const resolved = bannerFromContest(
    banner && {
      slug: banner.contestSlug,
      title: banner.title,
      lifecycleStatus: "PUBLISHED",
      startsAt: current,
      endsAt: banner.endsAt,
      coinPrize: banner.coinPrize,
      eligibilityMode: banner.eligibilityMode,
      bannerMessage: banner.message,
    },
    current
  );
  if (resolved && !includeEligibilityMode) delete resolved.eligibilityMode;
  return resolved;
}

async function invalidateActiveContestBannerCache() {
  await derivedCache.invalidate({
    keys: [cacheKeys.homeGiveawayBanner()],
    prefix: cacheKeys.PREFIX.HOME_GIVEAWAY_BANNER,
  });
}

module.exports = {
  invalidateActiveContestBannerCache,
  resolveActiveContestBanner,
};
