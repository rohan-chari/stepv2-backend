const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getEligiblePowerupPool,
} = require("../../src/queries/getEligiblePowerupPool");

// Leech + X-Ray (DEFENSE_SCAN) are store-only utility/attack powerups and must
// NEVER be awarded from the daily box (Item 2) — a spinpowerups-but-not-powerups2
// client could otherwise win a type it can't render/use. They are excluded from
// the eligible pool unconditionally.
function fakeModel(items) {
  return { async findActive() { return items; } };
}

const CATALOG = [
  { sku: "POWERUP_RAINSTORM", powerupType: "RAINSTORM", priceCoins: 75 },
  { sku: "POWERUP_LEECH", powerupType: "LEECH", priceCoins: 300 },
  { sku: "POWERUP_XRAY", powerupType: "DEFENSE_SCAN", priceCoins: 150 },
  { sku: "POWERUP_SIGNAL_JAMMER", powerupType: "SIGNAL_JAMMER", priceCoins: 75 },
];

test("Leech + X-Ray are excluded from the daily-box eligible pool", async () => {
  const pool = await getEligiblePowerupPool({
    supportsJammer: true,
    powerupShopItemModel: fakeModel(CATALOG),
  });
  const types = pool.map((p) => p.powerupType);
  assert.ok(!types.includes("LEECH"));
  assert.ok(!types.includes("DEFENSE_SCAN"));
  assert.ok(types.includes("RAINSTORM"));
  assert.ok(types.includes("SIGNAL_JAMMER"), "jammer still gated by supportsJammer only");
});
