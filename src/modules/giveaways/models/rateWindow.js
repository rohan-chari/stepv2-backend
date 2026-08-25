const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { AppError } = require("../../../shared/errors/AppError");
const { hmacClientIpHashes } = require("../../../shared/lib/clientIp");

function windowStart(now, durationMs) {
  return new Date(Math.floor(now.getTime() / durationMs) * durationMs);
}

function buildGiveawayRateWindow(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;
  const logger = dependencies.logger || console;

  async function consume(kind, keyHash, durationMs, maximum, code) {
    const start = windowStart(now(), durationMs);
    const rows = await db.$queryRaw`
      INSERT INTO giveaway_rate_windows
        (kind, key_hash, window_start, count, updated_at)
      VALUES (${kind}, ${keyHash}, ${start}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (kind, key_hash) DO UPDATE SET
        window_start = CASE
          WHEN giveaway_rate_windows.window_start = EXCLUDED.window_start
            THEN giveaway_rate_windows.window_start
          ELSE EXCLUDED.window_start
        END,
        count = CASE
          WHEN giveaway_rate_windows.window_start = EXCLUDED.window_start
            THEN giveaway_rate_windows.count + 1
          ELSE 1
        END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING count
    `;
    if (rows[0].count > maximum) {
      throw new AppError("Too many giveaway requests", code, 429);
    }
  }

  return {
    async consumePublic(req) {
      const hashes = hmacClientIpHashes(req, { env, logger });
      const networkKey = hashes.ipNetHash || hashes.ipHash;
      if (!networkKey || !hashes.version) {
        throw new AppError(
          "Public giveaway temporarily unavailable",
          "INTERNAL_ERROR",
          500,
        );
      }
      return consume(
        "PUBLIC_DETAIL",
        `v${hashes.version}:${networkKey}`,
        60_000,
        60,
        "GIVEAWAY_PUBLIC_RATE_LIMITED",
      );
    },

    consumeEntry(userId) {
      const keyHash = crypto.createHash("sha256").update(String(userId)).digest("hex");
      return consume(
        "ENTRY",
        keyHash,
        60 * 60_000,
        10,
        "GIVEAWAY_ENTRY_RATE_LIMITED",
      );
    },
  };
}

module.exports = { buildGiveawayRateWindow, windowStart };
