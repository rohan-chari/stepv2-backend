const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");
const { DailyRewardError } = require("../../src/commands/claimDailyReward");

// Watch-ad-for-coins (Get Coins hub):
//   GET  /daily-reward/status       -> additive adCoinReward block, ONLY for
//                                      clients sending `ads` in X-Client-Features
//   POST /coins/claim-ad-reward     -> consumes a coin_reward grant, mints coins
// Old binaries never send the feature flag and never see the new field.

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

const ME = "user-me";

function depsWithStubAuth(overrides = {}) {
  return {
    requireAuth(req, _res, next) {
      req.user = { id: ME };
      next();
    },
    getDailyRewardStatus: async () => ({ claimedToday: true, ladder: [] }),
    getAdExtraSpinStatus: async () => ({
      available: false,
      pendingGrant: false,
      used: false,
    }),
    getAdCoinRewardStatus: async () => ({
      available: true,
      pendingGrant: false,
      remainingToday: 3,
      coinAmount: 25,
    }),
    ...overrides,
  };
}

async function getStatus(baseUrl, headers = {}) {
  const res = await fetch(
    `${baseUrl}/daily-reward/status?localDate=2026-07-06`,
    { headers: { Authorization: "Bearer t", ...headers } }
  );
  return { status: res.status, body: await res.json() };
}

async function postClaim(baseUrl) {
  const res = await fetch(`${baseUrl}/coins/claim-ad-reward`, {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify({ localDate: "2026-07-06" }),
  });
  return { status: res.status, body: await res.json() };
}

test("status includes adCoinReward only for clients declaring the ads feature", async () => {
  const server = await startServer(depsWithStubAuth());
  try {
    const withAds = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters,ads",
    });
    assert.equal(withAds.status, 200);
    assert.deepEqual(withAds.body.adCoinReward, {
      available: true,
      pendingGrant: false,
      remainingToday: 3,
      coinAmount: 25,
    });

    const withoutAds = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters",
    });
    assert.equal("adCoinReward" in withoutAds.body, false);
  } finally {
    await server.close();
  }
});

test("status omits adCoinReward when the kill switch is off", async () => {
  const server = await startServer(
    depsWithStubAuth({
      adRewardsConfig: {
        ADS_EXTRA_SPIN_ENABLED: true,
        ADS_COIN_REWARD_ENABLED: false,
      },
    })
  );
  try {
    const res = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters,ads",
    });
    assert.equal("adCoinReward" in res.body, false);
    // The sibling extra-spin block is unaffected by the coin kill switch.
    assert.equal("adExtraSpin" in res.body, true);
  } finally {
    await server.close();
  }
});

test("POST /coins/claim-ad-reward mints via the command", async () => {
  const claims = [];
  const server = await startServer(
    depsWithStubAuth({
      claimAdCoinReward: async (args) => {
        claims.push(args);
        return { coinAmount: 25, coins: 525, remainingToday: 2 };
      },
    })
  );
  try {
    const res = await postClaim(server.baseUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { coinAmount: 25, coins: 525, remainingToday: 2 });
    assert.equal(claims[0].userId, ME);
    assert.equal(claims[0].localDate, "2026-07-06");
  } finally {
    await server.close();
  }
});

test("POST /coins/claim-ad-reward surfaces the command's code on 409", async () => {
  const err = new DailyRewardError("No verified ad reward available yet", 409);
  err.code = "AD_NOT_VERIFIED";
  const server = await startServer(
    depsWithStubAuth({
      claimAdCoinReward: async () => {
        throw err;
      },
    })
  );
  try {
    const res = await postClaim(server.baseUrl);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "AD_NOT_VERIFIED");
  } finally {
    await server.close();
  }
});

test("POST /coins/claim-ad-reward is 503 when the kill switch is off", async () => {
  const server = await startServer(
    depsWithStubAuth({
      adRewardsConfig: {
        ADS_EXTRA_SPIN_ENABLED: true,
        ADS_COIN_REWARD_ENABLED: false,
      },
    })
  );
  try {
    const res = await postClaim(server.baseUrl);
    assert.equal(res.status, 503);
  } finally {
    await server.close();
  }
});
