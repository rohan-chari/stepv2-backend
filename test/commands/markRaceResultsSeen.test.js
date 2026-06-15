const assert = require("node:assert/strict");
const test = require("node:test");

// markRaceResultsSeen uses prisma directly, so we mock the db module and
// re-require the command (same pattern as awardCoins.test.js) to avoid needing
// a real DB.
function withMockPrisma(mockPrisma, fn) {
  const originalModule = require("../../src/db");
  const originalPrisma = originalModule.prisma;
  Object.assign(originalModule, { prisma: mockPrisma });
  try {
    delete require.cache[
      require.resolve("../../src/commands/markRaceResultsSeen")
    ];
    const mod = require("../../src/commands/markRaceResultsSeen");
    return fn(mod);
  } finally {
    Object.assign(originalModule, { prisma: originalPrisma });
    delete require.cache[
      require.resolve("../../src/commands/markRaceResultsSeen")
    ];
  }
}

test("markRaceResultsSeen: sets timestamp for the caller's rows in the given races", async () => {
  const calls = [];
  const mockPrisma = {
    raceParticipant: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 2 };
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ markRaceResultsSeen }) => {
    const result = await markRaceResultsSeen({
      userId: "user-1",
      raceIds: ["race-1", "race-2"],
    });
    assert.equal(result.count, 2);
    assert.equal(calls.length, 1);
    // Only the caller's rows, scoped to the requested races.
    assert.equal(calls[0].where.userId, "user-1");
    assert.deepEqual(calls[0].where.raceId, { in: ["race-1", "race-2"] });
    assert.ok(calls[0].data.resultsSeenAt instanceof Date);
  });
});

test("markRaceResultsSeen: idempotent — second call issues another updateMany", async () => {
  let updateManyCount = 0;
  const mockPrisma = {
    raceParticipant: {
      updateMany: async () => {
        updateManyCount += 1;
        return { count: 1 };
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ markRaceResultsSeen }) => {
    await markRaceResultsSeen({ userId: "user-1", raceIds: ["race-1"] });
    await markRaceResultsSeen({ userId: "user-1", raceIds: ["race-1"] });
    assert.equal(updateManyCount, 2);
  });
});

test("markRaceResultsSeen: unknown ids are passed through harmlessly (updateMany matches 0)", async () => {
  const mockPrisma = {
    raceParticipant: {
      updateMany: async () => ({ count: 0 }),
    },
  };

  await withMockPrisma(mockPrisma, async ({ markRaceResultsSeen }) => {
    const result = await markRaceResultsSeen({
      userId: "user-1",
      raceIds: ["does-not-exist"],
    });
    assert.equal(result.count, 0);
  });
});

test("markRaceResultsSeen: rejects empty / missing raceIds", async () => {
  const mockPrisma = {
    raceParticipant: {
      updateMany: async () => {
        throw new Error("should not be called");
      },
    },
  };

  await withMockPrisma(
    mockPrisma,
    async ({ markRaceResultsSeen, MarkRaceResultsSeenError }) => {
      await assert.rejects(
        () => markRaceResultsSeen({ userId: "user-1", raceIds: [] }),
        (err) => {
          assert.ok(err instanceof MarkRaceResultsSeenError);
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
      await assert.rejects(
        () => markRaceResultsSeen({ userId: "user-1" }),
        (err) => err instanceof MarkRaceResultsSeenError
      );
    }
  );
});

test("markRaceResultsSeen: rejects non-string entries", async () => {
  const mockPrisma = {
    raceParticipant: {
      updateMany: async () => {
        throw new Error("should not be called");
      },
    },
  };

  await withMockPrisma(
    mockPrisma,
    async ({ markRaceResultsSeen, MarkRaceResultsSeenError }) => {
      await assert.rejects(
        () => markRaceResultsSeen({ userId: "user-1", raceIds: ["ok", 7] }),
        (err) => err instanceof MarkRaceResultsSeenError
      );
    }
  );
});
