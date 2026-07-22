const assert = require("node:assert/strict");
const test = require("node:test");
const { getEligiblePowerupPool } = require("../../src/modules/powerups/queries/getEligiblePowerupPool");

const items = ["SIGNAL_JAMMER", "DEFENSE_SCAN", "LEECH", "HITCHHIKE", "QUICK_RINSE", "QUICKSAND"].map((powerupType) => ({ powerupType }));
const model = { async findActive() { return items; } };
const config = { dailyBoxExcludedTypes: [] };
const types = async (flags) => (await getEligiblePowerupPool({ powerupShopItemModel: model, config, ...flags })).map((i) => i.powerupType);

test("daily powerup pool advances only with request-scoped capability generations", async () => {
  assert.deepEqual(await types({}), []);
  assert.deepEqual(await types({ supportsJammer: true, supportsPowerups2: true }), ["SIGNAL_JAMMER", "DEFENSE_SCAN"]);
  assert.deepEqual(await types({ supportsJammer: true, supportsPowerups2: true, supportsPowerups3: true }), ["SIGNAL_JAMMER", "DEFENSE_SCAN", "LEECH", "HITCHHIKE", "QUICK_RINSE"]);
  assert.deepEqual(await types({ supportsJammer: true, supportsPowerups2: true, supportsPowerups3: true, supportsPowerups4: true }), items.map((i) => i.powerupType));
});
