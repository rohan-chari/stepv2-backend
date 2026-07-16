const assert = require("node:assert/strict");
const test = require("node:test");

// The ad-coin economy is tuned by env override without an App Store cycle, so
// these overrides are the only thing standing between a typo and an uncapped
// coin mint. Constants are read at require time — reload the module per case.
const MODULE_PATH = require.resolve("../../src/config/adRewards");

function loadConfig(env) {
  const previousEnv = process.env;
  process.env = { ...previousEnv, ...env };
  delete require.cache[MODULE_PATH];
  try {
    return require(MODULE_PATH);
  } finally {
    process.env = previousEnv;
    delete require.cache[MODULE_PATH];
  }
}

test("adRewards — defaults to 25 coins x 3 watches when unset", () => {
  const config = loadConfig({
    AD_COIN_REWARD_AMOUNT: undefined,
    AD_COIN_REWARD_DAILY_CAP: undefined,
  });

  assert.equal(config.AD_COIN_REWARD_AMOUNT, 25);
  assert.equal(config.AD_COIN_REWARD_DAILY_CAP, 3);
});

test("adRewards — env overrides retune the amount and cap", () => {
  const config = loadConfig({
    AD_COIN_REWARD_AMOUNT: "10",
    AD_COIN_REWARD_DAILY_CAP: "8",
  });

  assert.equal(config.AD_COIN_REWARD_AMOUNT, 10);
  assert.equal(config.AD_COIN_REWARD_DAILY_CAP, 8);
});

// A NaN cap would make `consumed >= cap` false forever — unlimited coins from a
// stray keystroke. Every malformed value must fall back to the default instead.
for (const bad of ["", "unlimited", "3.5", "-1", "0", "1e3x"]) {
  test(`adRewards — falls back to the default cap on ${JSON.stringify(
    bad
  )}`, () => {
    const config = loadConfig({ AD_COIN_REWARD_DAILY_CAP: bad });

    assert.equal(config.AD_COIN_REWARD_DAILY_CAP, 3);
  });
}
