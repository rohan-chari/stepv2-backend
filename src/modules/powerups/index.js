// Public interface of the powerups module (audit Phase 9m): the in-race
// powerup engine (usePowerup — still on its bespoke PowerupUseError, the one
// major file never migrated to AppError; relocated as-is), roll/redeem/discard/
// grant commands, mystery boxes, the powerup + race-effect models (races-domain
// code consumes these heavily until the finale move), shop/copy catalogs,
// odds/upgrade math, and leech/hitchhike transfer helpers.
// Incremental exports, router last (9i/9l precedent).
Object.assign(module.exports, require("./models/racePowerup"));
Object.assign(module.exports, require("./models/racePowerupEvent"));
Object.assign(module.exports, require("./models/raceActiveEffect"));
Object.assign(module.exports, require("./models/userPowerupItem"));
Object.assign(module.exports, require("./models/powerupShopItem"));
Object.assign(module.exports, require("./models/powerupCopy"));
Object.assign(module.exports, require("./models/powerupUpgradeEvent"));
Object.assign(module.exports, require("./constants/powerupGating"));
Object.assign(module.exports, require("./constants/powerupCopySeed"));
Object.assign(module.exports, require("./powerupOdds"));
Object.assign(module.exports, require("./powerupUpgrades"));
Object.assign(module.exports, require("./hitchhikeCopies"));
Object.assign(module.exports, require("./leechTransfers"));
Object.assign(module.exports, require("./queries/getEligiblePowerupPool"));
Object.assign(module.exports, require("./queries/getPowerupInventory"));
Object.assign(module.exports, require("./queries/getPowerupShopCatalog"));
Object.assign(module.exports, require("./queries/getPowerupCopyCatalog"));
Object.assign(module.exports, require("./queries/getRaceInventory"));
Object.assign(module.exports, require("./commands/rollPowerup"));
Object.assign(module.exports, require("./commands/usePowerup"));
Object.assign(module.exports, require("./commands/discardPowerup"));
Object.assign(module.exports, require("./commands/redeemPowerupToRace"));
Object.assign(module.exports, require("./commands/grantPowerupToUser"));
Object.assign(module.exports, require("./commands/purchasePowerupItem"));
Object.assign(module.exports, require("./commands/unlockPowerupWithAds"));
Object.assign(module.exports, require("./commands/expireEffects"));
Object.assign(module.exports, require("./commands/openMysteryBox"));
Object.assign(module.exports, require("./commands/openMysteryBoxBatch"));
Object.assign(module.exports, require("./commands/rerollMysteryBox"));
Object.assign(module.exports, require("./routes")); // createPowerupsRouter — LAST
