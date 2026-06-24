const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

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

// Bypass auth: requireAuth is injectable on the router via dependencies.
function depsWithStubAuth(overrides = {}) {
  return {
    requireAuth(req, _res, next) {
      req.user = { id: "user-1", appleId: "apple-sub-1" };
      next();
    },
    ...overrides,
  };
}

// A stub awardCoins that mimics the real CoinTransaction idempotency: the first
// call for a (reason, refId) awards; subsequent calls return awarded:false with
// the unchanged balance.
function makeStubAwardCoins(startingBalance = 0) {
  const ledger = new Set();
  let balance = startingBalance;
  return async function awardCoins({ amount, reason, refId }) {
    const key = `${reason}:${refId}`;
    if (ledger.has(key)) {
      return { awarded: false, coins: balance };
    }
    ledger.add(key);
    balance += amount;
    return { awarded: true, coins: balance };
  };
}

test("POST /tutorial/complete-reward grants 100 once, then is a no-op", async () => {
  const updates = [];
  const server = await startServer(
    depsWithStubAuth({
      awardCoins: makeStubAwardCoins(40),
      User: {
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
      },
    })
  );

  try {
    // First completion: grants 100 (40 -> 140).
    const first = await fetch(`${server.baseUrl}/tutorial/complete-reward`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.granted, true);
    assert.equal(firstBody.coins, 140);

    // Second completion (replay / reinstall): no additional coins.
    const second = await fetch(`${server.baseUrl}/tutorial/complete-reward`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.granted, false);
    assert.equal(secondBody.coins, 140);

    // Both completions mark the onboarding step seen.
    assert.equal(updates.length, 2);
    assert.equal(updates[0].fields.tutorialOnboardingSeen, true);
  } finally {
    await server.close();
  }
});

test("POST /tutorial/onboarding-seen marks the flag without granting coins", async () => {
  const updates = [];
  let awardCalls = 0;
  const server = await startServer(
    depsWithStubAuth({
      awardCoins: async () => {
        awardCalls += 1;
        return { awarded: true, coins: 999 };
      },
      User: {
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
      },
    })
  );

  try {
    const res = await fetch(`${server.baseUrl}/tutorial/onboarding-seen`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "user-1");
    assert.equal(updates[0].fields.tutorialOnboardingSeen, true);
    // Skip path must never award coins.
    assert.equal(awardCalls, 0);
  } finally {
    await server.close();
  }
});
