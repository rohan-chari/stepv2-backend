const { UserPowerupItem } = require("../models/userPowerupItem");
const powerupInventoryCache = require("../services/powerupInventoryCache");
const { appSettings } = require("../../../shared/config/appSettings");

// GET /powerups/inventory — the user's owned powerup quantities. Rows with
// quantity 0 (fully spent) are omitted so the UI only renders what's held.
//
// C4 (spec §5 Phase E): behind `redisCacheUserBitsEnabled` the ROW SET is
// served from `v1:user:inventory:{id}` (60s TTL, invalidated at every ownership
// write). The capability filter below still runs PER REQUEST on the way out, so
// a warm payload built for a `powerups4` client can never leak QUICKSAND to an
// older binary.
function buildGetPowerupInventory(deps = {}) {
  const userPowerupItemModel = deps.UserPowerupItem || UserPowerupItem;
  // Injected-deps callers (unit tests, the composition root's overrides) keep
  // the pure Postgres path: they supply their own model and expect it to be the
  // only source of truth.
  const injectedModel = Boolean(deps.UserPowerupItem);
  const settings = deps.appSettings || appSettings;
  const cache = deps.powerupInventoryCache || powerupInventoryCache;

  return async function getPowerupInventory(userId, supportsPowerups4 = false) {
    let items;
    let cacheEnabled = false;
    if (!injectedModel) {
      // Defensive read: an unreadable flag means "cache off" (today's behavior).
      try {
        cacheEnabled =
          (await settings.getFlag("redisCacheUserBitsEnabled")) === true;
      } catch {
        cacheEnabled = false;
      }
    }

    if (cacheEnabled) {
      items = await cache.getItems(userId, true);
    } else {
      const rows = await userPowerupItemModel.findManyByUser(userId);
      items = rows
        .filter((r) => (r.quantity ?? 0) > 0)
        .map((r) => ({ powerupType: r.powerupType, quantity: r.quantity }));
    }

    return {
      items: items.filter(
        (item) =>
          item.powerupType !== "IMPOSTER" &&
          (supportsPowerups4 || item.powerupType !== "QUICKSAND")
      ),
    };
  };
}

const getPowerupInventory = buildGetPowerupInventory();

module.exports = { buildGetPowerupInventory, getPowerupInventory };
