const assert = require("node:assert/strict");
const test = require("node:test");

// markRankedResultsSeen uses prisma directly, so we mock the db module and
// re-require the command (same pattern as markRaceResultsSeen.test.js) to avoid
// needing a real DB.
function withMockPrisma(mockPrisma, fn) {
  const originalModule = require("../../src/db");
  const originalPrisma = originalModule.prisma;
  Object.assign(originalModule, { prisma: mockPrisma });
  try {
    delete require.cache[
      require.resolve("../../src/modules/ranked/commands/markRankedResultsSeen")
    ];
    const mod = require("../../src/modules/ranked/commands/markRankedResultsSeen");
    return fn(mod);
  } finally {
    Object.assign(originalModule, { prisma: originalPrisma });
    delete require.cache[
      require.resolve("../../src/modules/ranked/commands/markRankedResultsSeen")
    ];
  }
}

test("markRankedResultsSeen: resolves the week then stamps the caller's member row", async () => {
  const calls = [];
  const mockPrisma = {
    rankedWeek: {
      findUnique: async (args) => {
        calls.push(["findUnique", args]);
        return { id: "week-uuid" };
      },
    },
    rankedCohortMember: {
      updateMany: async (args) => {
        calls.push(["updateMany", args]);
        return { count: 1 };
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ markRankedResultsSeen }) => {
    const result = await markRankedResultsSeen({ userId: "user-1", weekIndex: 7 });
    assert.equal(result.count, 1);
    assert.deepEqual(calls[0][1].where, { index: 7 });
    // Only the caller's row, scoped to the resolved week.
    assert.equal(calls[1][1].where.userId, "user-1");
    assert.equal(calls[1][1].where.weekId, "week-uuid");
    assert.ok(calls[1][1].data.resultsSeenAt instanceof Date);
  });
});

test("markRankedResultsSeen: unknown weekIndex is a no-op (no updateMany)", async () => {
  let updateManyCalled = false;
  const mockPrisma = {
    rankedWeek: { findUnique: async () => null },
    rankedCohortMember: {
      updateMany: async () => {
        updateManyCalled = true;
        return { count: 0 };
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ markRankedResultsSeen }) => {
    const result = await markRankedResultsSeen({
      userId: "user-1",
      weekIndex: 999,
    });
    assert.equal(result.count, 0);
    assert.equal(updateManyCalled, false);
  });
});

test("markRankedResultsSeen: rejects a non-integer weekIndex", async () => {
  const mockPrisma = {
    rankedWeek: {
      findUnique: async () => {
        throw new Error("should not be called");
      },
    },
  };

  await withMockPrisma(
    mockPrisma,
    async ({ markRankedResultsSeen, MarkRankedResultsSeenError }) => {
      for (const bad of [undefined, "7", 1.5, null]) {
        await assert.rejects(
          () => markRankedResultsSeen({ userId: "user-1", weekIndex: bad }),
          (err) => {
            assert.ok(err instanceof MarkRankedResultsSeenError);
            assert.equal(err.statusCode, 400);
            return true;
          }
        );
      }
    }
  );
});
