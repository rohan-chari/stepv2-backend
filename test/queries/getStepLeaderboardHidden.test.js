const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// T8: hiddenFromLeaderboard preference. A user who opts to hide is removed from
// OTHERS' GLOBAL step leaderboard (top list + the usersAbove rank count), but:
//  - still sees their OWN global rank via the self-rank fallback, and
//  - remains visible on the FRIENDS-scoped board.
//
// getStepLeaderboard talks to prisma directly, so we mock the db module's prisma
// and re-require the query (markRaceResultsSeen.test.js pattern). The mock
// honours the where.user filter so we can assert real exclusion behaviour.
// ---------------------------------------------------------------------------

function withMockPrisma(mockPrisma, fn) {
  const dbModule = require("../../src/db");
  const originalPrisma = dbModule.prisma;
  Object.assign(dbModule, { prisma: mockPrisma });
  try {
    delete require.cache[require.resolve("../../src/modules/leaderboard/getLeaderboard")];
    const mod = require("../../src/modules/leaderboard/getLeaderboard");
    return fn(mod);
  } finally {
    Object.assign(dbModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/modules/leaderboard/getLeaderboard")];
  }
}

// users: { id: { hidden, review, name } }   steps: { id: totalSteps }
function makeLeaderboardPrisma({ users, steps, friendships = [] }) {
  function passesUserFilter(uid, where) {
    const u = users[uid] || {};
    const uf = where.user || {};
    if (uf.isReviewAccount === false && u.review) return false;
    if (uf.hiddenFromLeaderboard === false && u.hidden) return false;
    return true;
  }
  function inScope(uid, where) {
    if (where.userId && Array.isArray(where.userId.in)) {
      return where.userId.in.includes(uid);
    }
    return true;
  }
  function eligible(where) {
    return Object.keys(steps).filter(
      (uid) => passesUserFilter(uid, where) && inScope(uid, where)
    );
  }
  const capturedWheres = [];
  return {
    capturedWheres,
    step: {
      async groupBy({ where, take, having }) {
        capturedWheres.push(where);
        let rows = eligible(where).map((uid) => ({
          userId: uid,
          _sum: { steps: steps[uid] },
        }));
        const gt = having?.steps?._sum?.gt;
        if (gt != null) rows = rows.filter((r) => r._sum.steps > gt);
        rows.sort((a, b) => b._sum.steps - a._sum.steps);
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      async aggregate({ where }) {
        return { _sum: { steps: steps[where.userId] ?? 0 } };
      },
    },
    user: {
      async findMany({ where }) {
        return (where.id.in || [])
          .filter((id) => users[id])
          .map((id) => ({
            id,
            displayName: users[id].name,
            profilePhotoUrl: null,
            equippedAccessories: [],
          }));
      },
      async findUnique({ where }) {
        const u = users[where.id];
        return u ? { displayName: u.name, profilePhotoUrl: null } : null;
      },
    },
    friendship: {
      async findMany() {
        return friendships;
      },
    },
  };
}

test("global board EXCLUDES a hidden user from the top list and the rank seen by others", async () => {
  const prisma = makeLeaderboardPrisma({
    users: {
      "user-me": { name: "Me" },
      alice: { name: "Alice" },
      hidden1: { hidden: true, name: "Ghost" },
    },
    steps: { "user-me": 5000, alice: 9000, hidden1: 20000 },
  });

  const result = await withMockPrisma(prisma, ({ getLeaderboard }) =>
    getLeaderboard({
      type: "steps",
      period: "today",
      scope: "global",
      currentUserId: "user-me",
      timeZone: "UTC",
    })
  );

  const ids = result.top100.map((e) => e.userId);
  assert.ok(!ids.includes("hidden1"), "hidden user must not appear on the global board");
  assert.deepEqual(ids, ["alice", "user-me"]);
  // Me ranks 2nd — the hidden 20k user is not counted ahead of me.
  assert.equal(result.currentUser.rank, 2);
  assert.equal(result.currentUser.inTop100, true);
});

test("a hidden user still sees their OWN global rank via the self-rank fallback, and is excluded from usersAbove", async () => {
  const prisma = makeLeaderboardPrisma({
    users: {
      "user-me": { hidden: true, name: "Me" },
      alice: { name: "Alice" },
      hiddenHigh: { hidden: true, name: "Phantom" },
    },
    // Me (hidden) walked 20k; a DIFFERENT hidden user walked 99k.
    steps: { "user-me": 20000, alice: 9000, hiddenHigh: 99999 },
  });

  const result = await withMockPrisma(prisma, ({ getLeaderboard }) =>
    getLeaderboard({
      type: "steps",
      period: "today",
      scope: "global",
      currentUserId: "user-me",
      timeZone: "UTC",
    })
  );

  // Hidden me is NOT in the public top list...
  assert.ok(!result.top100.some((e) => e.userId === "user-me"));
  assert.equal(result.currentUser.inTop100, false);
  // ...but still gets a self-rank. usersAbove excludes the hidden 99k user, so
  // me is rank 1 (only non-hidden alice@9k is below me). If usersAbove failed to
  // exclude hidden users, hiddenHigh would push me to rank 2.
  assert.equal(result.currentUser.rank, 1);
  assert.equal(result.currentUser.totalSteps, 20000);
});

test("FRIENDS scope still shows a hidden friend (hidden only from strangers)", async () => {
  const prisma = makeLeaderboardPrisma({
    users: {
      "user-me": { name: "Me" },
      friendHidden: { hidden: true, name: "Buddy" },
    },
    steps: { "user-me": 5000, friendHidden: 30000 },
    friendships: [{ requesterId: "user-me", addresseeId: "friendHidden" }],
  });

  const result = await withMockPrisma(prisma, ({ getLeaderboard }) =>
    getLeaderboard({
      type: "steps",
      period: "today",
      scope: "friends",
      currentUserId: "user-me",
      timeZone: "UTC",
    })
  );

  const ids = result.top100.map((e) => e.userId);
  assert.ok(
    ids.includes("friendHidden"),
    "a hidden user must remain visible to their friends"
  );
  assert.deepEqual(ids, ["friendHidden", "user-me"]);
});

test("non-hidden users are unaffected on the global board", async () => {
  const prisma = makeLeaderboardPrisma({
    users: {
      "user-me": { name: "Me" },
      alice: { name: "Alice" },
      bob: { name: "Bob" },
    },
    steps: { "user-me": 7000, alice: 9000, bob: 3000 },
  });

  const result = await withMockPrisma(prisma, ({ getLeaderboard }) =>
    getLeaderboard({
      type: "steps",
      period: "today",
      scope: "global",
      currentUserId: "user-me",
      timeZone: "UTC",
    })
  );

  assert.deepEqual(result.top100.map((e) => e.userId), ["alice", "user-me", "bob"]);
  assert.equal(result.currentUser.rank, 2);
});
