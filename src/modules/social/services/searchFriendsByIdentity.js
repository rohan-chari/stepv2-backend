const { AppError, ValidationError } = require("../../../shared/errors/AppError");
const {
  normalizeDiscoverableNameSearch,
} = require("../../users/services/discoverableName");
const {
  FriendSearchRateWindow,
} = require("../models/friendSearchRateWindow");
const {
  searchDiscoverableUsers,
} = require("../queries/searchDiscoverableUsers");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { friendSearchRateLimiter: defaultRedisLimiter } = require("./friendSearchRateLimiter");

class SearchRateLimitError extends AppError {
  constructor(retryAfter) {
    super("Too many searches", "SEARCH_RATE_LIMITED", 429);
    this.retryAfter = retryAfter;
  }
}

function buildSearchFriendsByIdentity(dependencies = {}) {
  const rateWindow =
    dependencies.FriendSearchRateWindow || FriendSearchRateWindow;
  const searchUsers =
    dependencies.searchDiscoverableUsers || searchDiscoverableUsers;
  const now = dependencies.now || (() => new Date());
  const settings = dependencies.appSettings || defaultAppSettings;
  const redisLimiter = dependencies.friendSearchRateLimiter || defaultRedisLimiter;
  const logger = dependencies.logger || console;

  return async function searchFriendsByIdentity({ userId, q }) {
    if (typeof q !== "string") {
      throw new ValidationError(
        "Search query is required",
        "INVALID_SEARCH_QUERY"
      );
    }
    const handleQuery = q.trim().toLowerCase();
    const discoverableQuery = normalizeDiscoverableNameSearch(q);
    if ([...discoverableQuery].length < 2) {
      throw new ValidationError(
        "Search query must be at least 2 characters",
        "SEARCH_QUERY_TOO_SHORT"
      );
    }

    const current = now();
    let window = null;
    let redisEnabled = false;
    try {
      redisEnabled = (await settings.getFlag("redisFriendSearchRateLimitEnabled")) === true;
    } catch {}
    if (redisEnabled) {
      const startedAt = Date.now();
      try { window = await redisLimiter(userId, current); } catch {}
      logger.info?.("social-cache", {
        surface: "friend-search-rate",
        outcome: window ? "hit" : "bypass/error",
        durationMs: Date.now() - startedAt,
      });
    }
    if (!window) window = await rateWindow.consume(userId, current);
    if (window.count > 30) {
      const nextMinute = window.windowStart.getTime() + 60_000;
      const retryAfter = Math.max(
        1,
        Math.ceil((nextMinute - current.getTime()) / 1000)
      );
      throw new SearchRateLimitError(retryAfter);
    }

    return searchUsers({ userId, handleQuery, discoverableQuery });
  };
}

const searchFriendsByIdentity = buildSearchFriendsByIdentity();

module.exports = {
  SearchRateLimitError,
  buildSearchFriendsByIdentity,
  searchFriendsByIdentity,
};
