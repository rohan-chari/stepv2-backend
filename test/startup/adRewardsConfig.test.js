const assert = require("node:assert/strict");
const test = require("node:test");

// The ad-coin economy is tuned by env override without an App Store cycle, so
// these overrides are the only thing standing between a typo and an uncapped
// coin mint. Constants are read at require time — reload the module per case.
const MODULE_PATH = require.resolve("../../src/modules/economy/adRewards");

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

function withRuntimeEnv(env, fn) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = previous;
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

test("race payout double switches default off and allowlist defaults empty", () => {
  const config = loadConfig({
    ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED: undefined,
    ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED: undefined,
    ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS: undefined,
  });
  assert.equal(config.adsRacePayoutDoublePrepareEnabled(), false);
  assert.equal(config.adsRacePayoutDoubleClaimEnabled(), false);
  assert.deepEqual(config.racePayoutDoubleAdUnitIds(), []);
});

test("race payout double parses canonical dedicated-unit IDs with surrounding whitespace and deduplicates", () => {
  const config = loadConfig({});
  assert.deepEqual(
    withRuntimeEnv(
      {
        ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS:
          " ca-app-pub-3940256099942544/5224354917,ca-app-pub-3940256099942544/1712485313, ca-app-pub-3940256099942544/5224354917 ",
      },
      () => config.racePayoutDoubleAdUnitIds(),
    ),
    [
      "ca-app-pub-3940256099942544/5224354917",
      "ca-app-pub-3940256099942544/1712485313",
    ],
  );
});

test("race payout double suffixes strip the publisher prefix to match AdMob's bare-unit SSV ad_unit param", () => {
  const config = loadConfig({});
  assert.deepEqual(
    withRuntimeEnv(
      {
        ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS:
          "ca-app-pub-3940256099942544/5224354917,ca-app-pub-3940256099942544/1712485313",
      },
      () => config.racePayoutDoubleAdUnitSuffixes(),
    ),
    ["5224354917", "1712485313"],
  );
});

for (const raw of [undefined, "", "   ", "\t\n"]) {
  test(`race payout double allowlist stays off for ${JSON.stringify(raw)}`, () => {
    const config = loadConfig({});
    assert.deepEqual(
      withRuntimeEnv(
        { ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS: raw },
        () => config.racePayoutDoubleAdUnitIds(),
      ),
      [],
    );
  });
}

for (const raw of [
  "ca-app-pub-3940256099942544/5224354917,",
  ",ca-app-pub-3940256099942544/5224354917",
  "ca-app-pub-3940256099942544/5224354917,,ca-app-pub-3940256099942544/1712485313",
  "ca-app-pub-3940256099942544/5224354917,ios",
  "ios,ca-app-pub-3940256099942544/5224354917",
  "ca-app-pub-394025609994254/5224354917",
  "ca-app-pub-39402560999425444/5224354917",
  "ca-app-pub-3940256099942544/522435491",
  "ca-app-pub-3940256099942544/52243549177",
  "ca-app-pub-394025609994254x/5224354917",
  "ca-app-pub-3940256099942544/522435491x",
  "ca-app-pub-3940256099942544 /5224354917",
  "ca-app-pub-3940256099942544/ 5224354917",
  "CA-APP-PUB-3940256099942544/5224354917",
  "pub-3940256099942544/5224354917",
  "ca-app-pub-3940256099942544~5224354917",
]) {
  test(`race payout double allowlist fails closed for malformed input ${JSON.stringify(raw)}`, () => {
    const config = loadConfig({});
    assert.deepEqual(
      withRuntimeEnv(
        { ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS: raw },
        () => config.racePayoutDoubleAdUnitIds(),
      ),
      [],
    );
  });
}

for (const [raw, expected] of [
  ["1", 1], ["100", 100], ["500", 100], ["0", 100], ["-1", 100],
  ["101", 100], ["3.5", 100], ["bad", 100], ["", 100],
]) {
  test(`race payout double cap ${JSON.stringify(raw)} resolves to ${expected}`, () => {
    const config = loadConfig({});
    assert.equal(
      withRuntimeEnv(
        { RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS: raw },
        () => config.racePayoutDoubleMaxBonusCoins(),
      ),
      expected,
    );
  });
}
