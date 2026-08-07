const { prisma } = require("../../../db");

// Add one powerup of `powerupType` to a user's GLOBAL inventory (create the row
// on first grant, else increment). This is the coin-charge-free counterpart of
// the inventory step in purchasePowerupItem — used by reward flows (daily box)
// that award a powerup outright. Accepts an optional `db` (a prisma tx client)
// so callers can run it inside their own transaction; defaults to the shared
// prisma client. Returns the updated inventory row.
async function grantPowerupToUser(userId, powerupType, { db = prisma } = {}) {
  const row = await db.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType } },
    create: { userId, powerupType, quantity: 1 },
    update: { quantity: { increment: 1 } },
  });
  // C4 (spec §5 Phase E): ownership changed -> drop `v1:user:inventory:{id}`.
  // When `db` is a caller's tx this fires just before their commit; the 60s TTL
  // and the fact that the very next inventory read rebuilds from Postgres bound
  // the residual window (see powerupInventoryCache.js).
  await require("../services/powerupInventoryCache").invalidateSafe(userId);
  return row;
}

module.exports = { grantPowerupToUser };
