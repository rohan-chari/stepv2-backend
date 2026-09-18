const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createApp } = require("../../src/app");

async function startServer(dependencies) {
  const server = http.createServer(createApp(dependencies));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function dependencies({ membership = { raceId: "daily-1" }, claimed = false } = {}) {
  const awardCalls = [];
  return {
    awardCalls,
    requireAuth(req, _res, next) {
      req.user = { id: "user-1" };
      next();
    },
    prisma: {
      raceParticipant: {
        async findFirst(args) {
          assert.equal(args.where.status, "ACCEPTED");
          assert.equal(args.where.race.status, "ACTIVE");
          // Any ACTIVE *seeded* race qualifies (spec §5.6). The old
          // seed.kind === "DAILY_10K" pin 403'd users whose only active seeded
          // race was some other challenge.
          assert.deepEqual(args.where.race.seedId, { not: null });
          assert.equal(args.where.race.seed, undefined);
          return membership;
        },
      },
      coinTransaction: {
        async findFirst() {
          return claimed ? { id: "ledger-1" } : null;
        },
      },
    },
    async awardCoins(input) {
      awardCalls.push(input);
      return { awarded: !claimed, coins: claimed ? 150 : 250 };
    },
  };
}

test("starter eligibility requires accepted active Daily membership", async () => {
  const deps = dependencies();
  const server = await startServer(deps);
  try {
    const response = await fetch(`${server.baseUrl}/onboarding/starter-reward`, {
      headers: { authorization: "Bearer x" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      eligible: true,
      claimed: false,
      amount: 100,
      raceId: "daily-1",
    });
  } finally {
    await server.close();
  }
});

test("starter claim shares the legacy tutorial ledger key", async () => {
  const deps = dependencies();
  const server = await startServer(deps);
  try {
    const response = await fetch(`${server.baseUrl}/onboarding/starter-reward/claim`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { granted: true, coins: 250 });
    assert.deepEqual(deps.awardCalls, [
      {
        userId: "user-1",
        amount: 100,
        reason: "tutorial_complete",
        refId: "user-1",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("starter claim rejects users outside the active Daily", async () => {
  const deps = dependencies({ membership: null });
  const server = await startServer(deps);
  try {
    const response = await fetch(`${server.baseUrl}/onboarding/starter-reward/claim`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "STARTER_REWARD_NOT_ELIGIBLE");
    assert.equal(deps.awardCalls.length, 0);
  } finally {
    await server.close();
  }
});

test("legacy tutorial completion and Daily claim can grant only once", async () => {
  let balance = 10;
  const ledger = new Set();
  const deps = dependencies();
  deps.User = { async update() { return { id: "user-1" }; } };
  deps.awardCoins = async ({ amount, reason, refId }) => {
    const key = `${reason}:${refId}`;
    if (ledger.has(key)) return { awarded: false, coins: balance };
    ledger.add(key);
    balance += amount;
    return { awarded: true, coins: balance };
  };
  const server = await startServer(deps);
  try {
    const tutorial = await fetch(`${server.baseUrl}/tutorial/complete-reward`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.deepEqual(await tutorial.json(), { granted: true, coins: 110 });

    const daily = await fetch(`${server.baseUrl}/onboarding/starter-reward/claim`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{}",
    });
    assert.deepEqual(await daily.json(), { granted: false, coins: 110 });
  } finally {
    await server.close();
  }
});
