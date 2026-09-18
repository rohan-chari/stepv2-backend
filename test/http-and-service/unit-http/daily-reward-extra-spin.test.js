const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");
const { DailyRewardError } = require("../../src/modules/economy/commands/claimDailyReward");

// Extra daily box spin (rewarded ad):
//   GET  /daily-reward/status          -> additive adExtraSpin block, ONLY for
//                                         clients sending `ads` in X-Client-Features
//   POST /daily-reward/claim-extra-box -> rolls the extra box (grant-gated)
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
      available: true,
      pendingGrant: false,
      used: false,
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

test("status includes adExtraSpin only for clients declaring the ads feature", async () => {
  const server = await startServer(depsWithStubAuth());
  try {
    const withAds = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters,ads",
    });
    assert.equal(withAds.status, 200);
    assert.deepEqual(withAds.body.adExtraSpin, {
      available: true,
      pendingGrant: false,
      used: false,
    });

    const withoutAds = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters",
    });
    assert.equal(withoutAds.status, 200);
    assert.equal("adExtraSpin" in withoutAds.body, false);

    const noHeader = await getStatus(server.baseUrl);
    assert.equal("adExtraSpin" in noHeader.body, false);
  } finally {
    await server.close();
  }
});

test("status omits adExtraSpin when the kill switch is off", async () => {
  const server = await startServer(
    depsWithStubAuth({ adRewardsConfig: { ADS_EXTRA_SPIN_ENABLED: false } })
  );
  try {
    const res = await getStatus(server.baseUrl, {
      "X-Client-Features": "characters,ads",
    });
    assert.equal("adExtraSpin" in res.body, false);
  } finally {
    await server.close();
  }
});

test("POST /claim-extra-box rolls the extra box", async () => {
  const claims = [];
  const server = await startServer(
    depsWithStubAuth({
      claimExtraDailyRewardBox: async (args) => {
        claims.push(args);
        return { rarity: "COMMON", rewardType: "COINS", coins: 42, extra: true };
      },
    })
  );
  try {
    const res = await fetch(`${server.baseUrl}/daily-reward/claim-extra-box`, {
      method: "POST",
      headers: {
        Authorization: "Bearer t",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localDate: "2026-07-06" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.extra, true);
    assert.equal(claims[0].userId, ME);
    assert.equal(claims[0].localDate, "2026-07-06");
  } finally {
    await server.close();
  }
});

test("POST /claim-extra-box surfaces DailyRewardError statuses and codes", async () => {
  const err = new DailyRewardError("No verified ad reward available yet", 409);
  err.code = "AD_NOT_VERIFIED";
  const server = await startServer(
    depsWithStubAuth({
      claimExtraDailyRewardBox: async () => {
        throw err;
      },
    })
  );
  try {
    const res = await fetch(`${server.baseUrl}/daily-reward/claim-extra-box`, {
      method: "POST",
      headers: {
        Authorization: "Bearer t",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localDate: "2026-07-06" }),
    });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
  } finally {
    await server.close();
  }
});

// The home race-card batch embeds dailyReward.adExtraSpin for ads-capable
// clients once today's box is claimed, so the home button can show "EXTRA
// SPIN" without a second request.
test("home batch embeds dailyReward.adExtraSpin for ads clients after claim", async () => {
  const localDate = "2026-07-06";
  const server = await startServer({
    requireAuth(req, _res, next) {
      req.user = { id: ME, lastDailyClaimDate: localDate };
      next();
    },
    getHomeRaceCard: async () => ({}),
    getAdExtraSpinStatus: async () => ({
      available: true,
      pendingGrant: true,
      used: false,
    }),
  });
  try {
    const withAds = await fetch(
      `${server.baseUrl}/home/race-card?localDate=${localDate}`,
      {
        headers: {
          Authorization: "Bearer t",
          "X-Client-Features": "characters,ads",
        },
      }
    );
    const adsBody = await withAds.json();
    assert.equal(adsBody.dailyReward.claimedToday, true);
    assert.deepEqual(adsBody.dailyReward.adExtraSpin, {
      available: true,
      pendingGrant: true,
      used: false,
    });

    const withoutAds = await fetch(
      `${server.baseUrl}/home/race-card?localDate=${localDate}`,
      { headers: { Authorization: "Bearer t" } }
    );
    const plainBody = await withoutAds.json();
    assert.equal("adExtraSpin" in plainBody.dailyReward, false);
  } finally {
    await server.close();
  }
});

test("home batch omits adExtraSpin before the free claim", async () => {
  const server = await startServer({
    requireAuth(req, _res, next) {
      req.user = { id: ME, lastDailyClaimDate: "2026-07-05" };
      next();
    },
    getHomeRaceCard: async () => ({}),
    getAdExtraSpinStatus: async () => {
      throw new Error("should not be called before the free claim");
    },
  });
  try {
    const res = await fetch(
      `${server.baseUrl}/home/race-card?localDate=2026-07-06`,
      {
        headers: {
          Authorization: "Bearer t",
          "X-Client-Features": "characters,ads",
        },
      }
    );
    const body = await res.json();
    assert.equal(body.dailyReward.claimedToday, false);
    assert.equal("adExtraSpin" in body.dailyReward, false);
  } finally {
    await server.close();
  }
});

test("POST /claim-extra-box is 503 when the kill switch is off", async () => {
  const server = await startServer(
    depsWithStubAuth({
      adRewardsConfig: { ADS_EXTRA_SPIN_ENABLED: false },
      claimExtraDailyRewardBox: async () => ({}),
    })
  );
  try {
    const res = await fetch(`${server.baseUrl}/daily-reward/claim-extra-box`, {
      method: "POST",
      headers: {
        Authorization: "Bearer t",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localDate: "2026-07-06" }),
    });
    assert.equal(res.status, 503);
  } finally {
    await server.close();
  }
});
