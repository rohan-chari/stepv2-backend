const { prisma } = require("../db");

// Add one powerup of `powerupType` to a user's GLOBAL inventory (create the row
// on first grant, else increment). This is the coin-charge-free counterpart of
// the inventory step in purchasePowerupItem — used by reward flows (daily box)
// that award a powerup outright. Accepts an optional `db` (a prisma tx client)
// so callers can run it inside their own transaction; defaults to the shared
// prisma client. Returns the updated inventory row.
async function grantPowerupToUser(userId, powerupType, { db = prisma } = {}) {
  return db.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType } },
    create: { userId, powerupType, quantity: 1 },
    update: { quantity: { increment: 1 } },
  });
}

module.exports = { grantPowerupToUser };
