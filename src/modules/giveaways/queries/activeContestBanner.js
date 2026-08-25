const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { deriveContestStatus } = require("../models/contest");

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
  return {
    type: "referral_contest",
    contestSlug: slug,
    title,
    status: "ACTIVE",
    endsAt: endsAt.toISOString(),
    coinPrize,
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

async function resolveActiveContestBanner({ prisma, now = new Date() }) {
  const current = validDate(now) || new Date();
  const banner = await derivedCache.cachedRead({
    key: cacheKeys.homeGiveawayBanner(),
    prefix: cacheKeys.PREFIX.HOME_GIVEAWAY_BANNER,
    ttlSeconds: CACHE_TTL_SECONDS,
    enabled: true,
    load: () => loadActiveContestBanner({ prisma, now: current }),
  });
  return bannerFromContest(
    banner && {
      slug: banner.contestSlug,
      title: banner.title,
      lifecycleStatus: "PUBLISHED",
      startsAt: current,
      endsAt: banner.endsAt,
      coinPrize: banner.coinPrize,
    },
    current
  );
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
