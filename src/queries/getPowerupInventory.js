const { UserPowerupItem } = require("../models/userPowerupItem");

// GET /powerups/inventory — the user's owned powerup quantities. Rows with
// quantity 0 (fully spent) are omitted so the UI only renders what's held.
function buildGetPowerupInventory(deps = {}) {
  const userPowerupItemModel = deps.UserPowerupItem || UserPowerupItem;

  return async function getPowerupInventory(userId) {
    const rows = await userPowerupItemModel.findManyByUser(userId);
    return {
      items: rows
        .filter((r) => (r.quantity ?? 0) > 0)
        .map((r) => ({ powerupType: r.powerupType, quantity: r.quantity })),
    };
  };
}

const getPowerupInventory = buildGetPowerupInventory();

module.exports = { buildGetPowerupInventory, getPowerupInventory };
