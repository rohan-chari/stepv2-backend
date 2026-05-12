const assert = require("node:assert/strict");
const test = require("node:test");

// Mocked-prisma unit test for the new atomic-deduct helper.
// Pattern matches awardCoins.test.js: monkey-patch the prisma module export.

function withMockPrisma(mockPrisma, fn) {
  const dbModule = require("../../src/db");
  const originalPrisma = dbModule.prisma;
  Object.assign(dbModule, { prisma: mockPrisma });
  try {
    delete require.cache[require.resolve("../../src/commands/deductCoinsAtomic")];
    return fn();
  } finally {
    Object.assign(dbModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/commands/deductCoinsAtomic")];
  }
}

test("deductCoinsAtomic: deducts coins, creates a CoinTransaction, returns new balance", async () => {
  const calls = { updates: [], creates: [], finds: [] };

  const mockPrisma = {
    $transaction: async (cb) => cb(mockPrisma),
    user: {
      updateMany: async (args) => {
        calls.updates.push(args);
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.finds.push(args);
        return { id: "user-1", coins: 50 };
      },
    },
    coinTransaction: {
      create: async (args) => {
        calls.creates.push(args.data);
        return args.data;
      },
    },
  };

  await withMockPrisma(mockPrisma, async () => {
    const { deductCoinsAtomic } = require("../../src/commands/deductCoinsAtomic");
    const result = await deductCoinsAtomic({
      userId: "user-1",
      amount: 75,
      reason: "powerup_upgrade",
      refId: "pw-1",
    });

    assert.equal(result.coins, 50);
    assert.equal(calls.updates.length, 1);
    // Critical safety: the where-clause must guard against overdraw
    assert.deepEqual(calls.updates[0].where, { id: "user-1", coins: { gte: 75 } });
    assert.deepEqual(calls.updates[0].data, { coins: { decrement: 75 } });
    assert.equal(calls.creates.length, 1);
    assert.deepEqual(calls.creates[0], {
      userId: "user-1",
      amount: -75,
      reason: "powerup_upgrade",
      refId: "pw-1",
    });
  });
});

test("deductCoinsAtomic: throws InsufficientCoinsError when updateMany matches 0 rows", async () => {
  const calls = { updates: [], creates: [] };

  const mockPrisma = {
    $transaction: async (cb) => cb(mockPrisma),
    user: {
      updateMany: async (args) => {
        calls.updates.push(args);
        return { count: 0 };
      },
      findUnique: async () => ({ id: "user-1", coins: 5 }),
    },
    coinTransaction: {
      create: async (args) => {
        calls.creates.push(args.data);
        return args.data;
      },
    },
  };

  await withMockPrisma(mockPrisma, async () => {
    const {
      deductCoinsAtomic,
      InsufficientCoinsError,
    } = require("../../src/commands/deductCoinsAtomic");

    await assert.rejects(
      () =>
        deductCoinsAtomic({
          userId: "user-1",
          amount: 75,
          reason: "powerup_upgrade",
          refId: "pw-1",
        }),
      (err) => {
        assert.ok(err instanceof InsufficientCoinsError);
        return true;
      }
    );

    // Critical: failed deduction must NOT create a CoinTransaction record
    assert.equal(calls.creates.length, 0);
  });
});

test("deductCoinsAtomic: amount=0 is a no-op (no update, no transaction record)", async () => {
  const calls = { updates: [], creates: [] };

  const mockPrisma = {
    $transaction: async (cb) => cb(mockPrisma),
    user: {
      updateMany: async (args) => {
        calls.updates.push(args);
        return { count: 1 };
      },
      findUnique: async () => ({ id: "user-1", coins: 100 }),
    },
    coinTransaction: {
      create: async (args) => {
        calls.creates.push(args.data);
        return args.data;
      },
    },
  };

  await withMockPrisma(mockPrisma, async () => {
    const { deductCoinsAtomic } = require("../../src/commands/deductCoinsAtomic");
    const result = await deductCoinsAtomic({
      userId: "user-1",
      amount: 0,
      reason: "powerup_upgrade",
      refId: "pw-1",
    });

    assert.equal(result.coins, 100);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.creates.length, 0);
  });
});

test("deductCoinsAtomic: rejects negative amounts (must be a deduction, not a credit)", async () => {
  await withMockPrisma({}, async () => {
    const { deductCoinsAtomic } = require("../../src/commands/deductCoinsAtomic");
    await assert.rejects(
      () =>
        deductCoinsAtomic({
          userId: "user-1",
          amount: -10,
          reason: "powerup_upgrade",
          refId: "pw-1",
        }),
      /amount.*positive|amount.*non-negative/i
    );
  });
});

test("deductCoinsAtomic: simulated concurrent deduction — second call sees count=0 and rejects", async () => {
  // Simulates Postgres-level atomicity. Two concurrent updateMany calls both attempt
  // to decrement; only one wins. The second sees count=0 because the where-clause
  // (coins gte amount) no longer matches after the first decrement.
  let userCoins = 75;
  const calls = { creates: [] };

  const mockPrisma = {
    $transaction: async (cb) => cb(mockPrisma),
    user: {
      updateMany: async ({ where, data }) => {
        if (userCoins >= where.coins.gte) {
          userCoins -= data.coins.decrement;
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async () => ({ id: "user-1", coins: userCoins }),
    },
    coinTransaction: {
      create: async (args) => {
        calls.creates.push(args.data);
        return args.data;
      },
    },
  };

  await withMockPrisma(mockPrisma, async () => {
    const {
      deductCoinsAtomic,
      InsufficientCoinsError,
    } = require("../../src/commands/deductCoinsAtomic");

    // First call succeeds
    const r1 = await deductCoinsAtomic({
      userId: "user-1",
      amount: 75,
      reason: "powerup_upgrade",
      refId: "pw-1",
    });
    assert.equal(r1.coins, 0);

    // Second call must fail — exactly one CoinTransaction record exists
    await assert.rejects(
      () =>
        deductCoinsAtomic({
          userId: "user-1",
          amount: 75,
          reason: "powerup_upgrade",
          refId: "pw-2",
        }),
      InsufficientCoinsError
    );

    assert.equal(calls.creates.length, 1, "exactly one CoinTransaction should exist");
  });
});
