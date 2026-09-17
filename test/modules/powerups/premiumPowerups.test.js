const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PREMIUM_POWERUP_TYPES,
  powerupAcquisitionState,
  powerupRequiresGold,
} = require("../../../src/modules/powerups/constants/premiumPowerups");
const {
  getPowerupPools,
} = require("../../../src/modules/powerups/queries/getEligiblePowerupPool");
const {
  serializePowerupShopItem,
} = require("../../../src/modules/powerups/models/powerupShopItem");

const ITEMS = [
  { sku: "POWERUP_HITCHHIKE", powerupType: "HITCHHIKE", dailyRewardEligible: true },
  { sku: "POWERUP_LEECH", powerupType: "LEECH", dailyRewardEligible: true },
  { sku: "POWERUP_QUICKSAND", powerupType: "QUICKSAND", dailyRewardEligible: true },
  { sku: "POWERUP_RAINSTORM", powerupType: "RAINSTORM", dailyRewardEligible: true },
];

test("only Hitchhike requires Bara Gold", () => {
  assert.deepEqual([...PREMIUM_POWERUP_TYPES].sort(), [
  "HITCHHIKE",
  ]);
  assert.equal(powerupRequiresGold("HITCHHIKE"), true);
  assert.equal(powerupRequiresGold("LEECH"), false);
  assert.equal(powerupRequiresGold("QUICKSAND"), false);
  assert.equal(powerupRequiresGold("GHOST_PEPPER"), false);
  assert.equal(powerupRequiresGold("RAINSTORM"), false);
});
test("catalog metadata distinguishes visible premium items from free acquisition", () => {
  const item = { powerupType: "LEECH" };
  assert.deepEqual(powerupAcquisitionState(item, false), {
    requiresGold: false,
    goldEligible: true,
    purchaseEligibility: "AVAILABLE",
  });
  assert.deepEqual(serializePowerupShopItem({ ...item, sku: "POWERUP_LEECH", priceCoins: 300 }, { isGoldMember: false }), {
    sku: "POWERUP_LEECH",
    name: undefined,
    description: null,
    priceCoins: 300,
    powerupType: "LEECH",
    requiresGold: false,
    eligible: true,
  });
});

test("display pool includes premium items while free eligible pool excludes them", async () => {
  const model = { async findActive() { return ITEMS; } };
  const free = await getPowerupPools({
    powerupShopItemModel: model,
    supportsPowerups3: true,
    supportsPowerups4: true,
    isGoldMember: false,
  });
  assert.deepEqual(
    free.displayPool.map((item) => item.powerupType),
    ITEMS.map((item) => item.powerupType)
  );
  assert.deepEqual(free.eligiblePool.map((item) => item.powerupType), [
    "LEECH",
    "QUICKSAND",
    "RAINSTORM",
  ]);

  const gold = await getPowerupPools({
    powerupShopItemModel: model,
    supportsPowerups3: true,
    supportsPowerups4: true,
    isGoldMember: true,
  });
  assert.deepEqual(gold.eligiblePool.map((item) => item.powerupType), free.displayPool.map((item) => item.powerupType));
});
