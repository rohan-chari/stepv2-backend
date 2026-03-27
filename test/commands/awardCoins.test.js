const assert = require("node:assert/strict");
const test = require("node:test");

// We test against a mock prisma to avoid needing a real DB.
// The awardCoins function uses prisma directly, so we mock the module.

test("awardCoins: awards coins and returns new balance", async () => {
  const calls = { transactions: [], updates: [] };

  // Build a minimal mock that satisfies awardCoins
  const mockPrisma = {
    coinTransaction: {
      findFirst: async () => null, // no existing transaction
      create: async (args) => {
        calls.transactions.push(args.data);
        return args.data;
      },
    },
    user: {
      findUnique: async () => ({ id: "user-1", coins: 0 }),
      update: async (args) => {
        calls.updates.push(args);
        return { id: "user-1", coins: 100 };
      },
    },
    $transaction: async (operations) => {
      const results = [];
      for (const op of operations) {
        results.push(await op);
      }
      return results;
    },
  };

  // Inject mock by temporarily replacing the module
  const originalModule = require("../../src/db");
  const originalPrisma = originalModule.prisma;

  // Monkey-patch for this test
  Object.assign(originalModule, { prisma: mockPrisma });

  try {
    // Re-require to pick up mock (clear cache first)
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
    const { awardCoins } = require("../../src/commands/awardCoins");

    const result = await awardCoins({
      userId: "user-1",
      amount: 100,
      reason: "challenge_win",
      refId: "instance-1",
    });

    assert.equal(result.awarded, true);
    assert.equal(result.coins, 100);
    assert.equal(calls.transactions.length, 1);
    assert.equal(calls.transactions[0].amount, 100);
    assert.equal(calls.transactions[0].reason, "challenge_win");
  } finally {
    Object.assign(originalModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
  }
});

test("awardCoins: idempotent — skips if already awarded for same reason+refId", async () => {
  const mockPrisma = {
    coinTransaction: {
      findFirst: async () => ({ id: "existing-tx" }), // already exists
    },
    user: {
      findUnique: async () => ({ id: "user-1", coins: 100 }),
    },
  };

  const originalModule = require("../../src/db");
  const originalPrisma = originalModule.prisma;
  Object.assign(originalModule, { prisma: mockPrisma });

  try {
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
    const { awardCoins } = require("../../src/commands/awardCoins");

    const result = await awardCoins({
      userId: "user-1",
      amount: 100,
      reason: "challenge_win",
      refId: "instance-1",
    });

    assert.equal(result.awarded, false);
    assert.equal(result.coins, 100);
  } finally {
    Object.assign(originalModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
  }
});

test("awardCoins: no refId skips idempotency check", async () => {
  const calls = { transactions: [] };

  const mockPrisma = {
    coinTransaction: {
      create: async (args) => {
        calls.transactions.push(args.data);
        return args.data;
      },
    },
    user: {
      update: async () => ({ id: "user-1", coins: 10 }),
    },
    $transaction: async (operations) => {
      const results = [];
      for (const op of operations) {
        results.push(await op);
      }
      return results;
    },
  };

  const originalModule = require("../../src/db");
  const originalPrisma = originalModule.prisma;
  Object.assign(originalModule, { prisma: mockPrisma });

  try {
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
    const { awardCoins } = require("../../src/commands/awardCoins");

    const result = await awardCoins({
      userId: "user-1",
      amount: 10,
      reason: "daily_goal_1x",
    });

    assert.equal(result.awarded, true);
    assert.equal(result.coins, 10);
  } finally {
    Object.assign(originalModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/commands/awardCoins")];
  }
});
