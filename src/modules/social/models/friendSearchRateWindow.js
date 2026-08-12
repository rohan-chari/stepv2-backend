const { prisma: defaultPrisma } = require("../../../db");

function utcMinuteStart(now) {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

function buildFriendSearchRateWindow(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  return {
    async consume(userId, now = new Date()) {
      const windowStart = utcMinuteStart(now);
      const rows = await db.$queryRaw`
        INSERT INTO friend_search_rate_windows (user_id, window_start, count)
        VALUES (${userId}, ${windowStart}, 1)
        ON CONFLICT (user_id) DO UPDATE SET
          window_start = CASE
            WHEN friend_search_rate_windows.window_start = EXCLUDED.window_start
              THEN friend_search_rate_windows.window_start
            ELSE EXCLUDED.window_start
          END,
          count = CASE
            WHEN friend_search_rate_windows.window_start = EXCLUDED.window_start
              THEN friend_search_rate_windows.count + 1
            ELSE 1
          END
        RETURNING window_start AS "windowStart", count
      `;
      return rows[0];
    },
  };
}

const FriendSearchRateWindow = buildFriendSearchRateWindow();

module.exports = {
  utcMinuteStart,
  buildFriendSearchRateWindow,
  FriendSearchRateWindow,
};
