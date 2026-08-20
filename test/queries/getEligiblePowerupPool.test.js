const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getEligiblePowerupPool,
} = require("../../src/modules/powerups/queries/getEligiblePowerupPool");

// Fake PowerupShopItem model: records the channel it was queried with and
// returns a fixed active catalog (the real testOnly filter is exercised by the
// integration tests against a real DB).
function fakeModel(items) {
  const calls = [];
  return {
    calls,
    async findActive(opts) {
      calls.push(opts);
      return items;
    },
  };
}

const CATALOG = [
  { sku: "POWERUP_IMPOSTER", powerupType: "IMPOSTER", priceCoins: 75 },
  { sku: "POWERUP_RAINSTORM", powerupType: "RAINSTORM", priceCoins: 75 },
  { sku: "POWERUP_SIGNAL_JAMMER", powerupType: "SIGNAL_JAMMER", priceCoins: 75 },
];

test("returns the full active catalog for a jammer-capable client", async () => {
  const model = fakeModel(CATALOG);
  const pool = await getEligiblePowerupPool({
    channel: "prod",
    supportsJammer: true,
    powerupShopItemModel: model,
  });
  assert.deepEqual(
    pool.map((p) => p.powerupType),
    ["RAINSTORM", "SIGNAL_JAMMER"]
  );
});

test("filters out the Signal Jammer for a client without the jammer feature", async () => {
  const model = fakeModel(CATALOG);
  const pool = await getEligiblePowerupPool({
    channel: "prod",
    supportsJammer: false,
    powerupShopItemModel: model,
  });
  assert.deepEqual(
    pool.map((p) => p.powerupType),
    ["RAINSTORM"]
  );
  assert.ok(!pool.some((p) => p.powerupType === "SIGNAL_JAMMER"));
});

test("threads the release channel into the model's active filter", async () => {
  const model = fakeModel(CATALOG);
  await getEligiblePowerupPool({
    channel: "testflight",
    supportsJammer: true,
    powerupShopItemModel: model,
  });
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].channel, "testflight");
});

test("defaults to prod channel and jammer-hidden", async () => {
  const model = fakeModel(CATALOG);
  const pool = await getEligiblePowerupPool({ powerupShopItemModel: model });
  assert.equal(model.calls[0].channel, "prod");
  assert.ok(!pool.some((p) => p.powerupType === "SIGNAL_JAMMER"));
});
