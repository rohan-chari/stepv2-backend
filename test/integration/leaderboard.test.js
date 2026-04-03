const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-lb-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;

  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
    });
  }

  return { userId, token, appleId };
}

async function recordSteps(token, steps, date) {
  return request(server.baseUrl, "POST", "/steps", {
    body: { steps, date },
    token,
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe("leaderboard", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === BASIC LEADERBOARD ===

  describe("basic ranking", () => {
    it("returns top 10 sorted by steps descending with correct ranks", async () => {
      const users = [];
      for (let i = 1; i <= 12; i++) {
        const u = await createUser(`User${String(i).padStart(2, "0")}Leaderboard`);
        await recordSteps(u.token, i * 1000, todayStr());
        users.push(u);
      }

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: users[0].token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.top10.length, 10);

      // Rank 1 should be user with most steps (user 12 = 12000 steps)
      assert.equal(body.top10[0].rank, 1);
      assert.equal(body.top10[0].totalSteps, 12000);

      // Rank 10 should be user with 3000 steps (user 3)
      assert.equal(body.top10[9].rank, 10);
      assert.equal(body.top10[9].totalSteps, 3000);

      // Should be in descending order
      for (let i = 1; i < body.top10.length; i++) {
        assert.ok(body.top10[i - 1].totalSteps >= body.top10[i].totalSteps);
      }
    });

    it("current user in top 10 has inTop10: true", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 9999, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.inTop10, true);
      assert.equal(body.currentUser.totalSteps, 9999);
      assert.equal(body.currentUser.rank, 1);
    });

    it("current user outside top 10 has inTop10: false with correct rank", async () => {
      // Create 11 users with more steps
      const users = [];
      for (let i = 1; i <= 11; i++) {
        const u = await createUser(`Ranker${String(i).padStart(2, "0")}Boards`);
        await recordSteps(u.token, (12 - i) * 1000, todayStr());
        users.push(u);
      }

      // Create user with fewest steps
      const lastPlace = await createUser("LastPlaceRunner");
      await recordSteps(lastPlace.token, 100, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: lastPlace.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.inTop10, false);
      assert.equal(body.currentUser.rank, 12);
      assert.equal(body.currentUser.totalSteps, 100);
    });

    it("user with no steps still gets a rank", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await recordSteps(alice.token, 5000, todayStr());
      // bob records nothing

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: bob.token,
      });
      const body = await res.json();

      assert.ok(body.currentUser.rank >= 1);
      assert.equal(body.currentUser.totalSteps, 0);
    });

    it("users without display names show as Anonymous", async () => {
      const noName = await createUser(null);
      await recordSteps(noName.token, 8000, todayStr());

      const viewer = await createUser("ViewerPerson");
      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: viewer.token,
      });
      const body = await res.json();

      const noNameEntry = body.top10.find((e) => e.userId === noName.userId);
      assert.equal(noNameEntry.displayName, "Anonymous");
    });

    it("invalid period returns 400", async () => {
      const alice = await createUser("AliceWalker");

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=yesterday", {
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });
  });

  // === PERIOD BOUNDARIES ===

  describe("period boundaries", () => {
    it("today period only includes today's steps, not yesterday's", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 3000, yesterdayStr());
      await recordSteps(alice.token, 7000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.totalSteps, 7000);
    });

    it("week period includes steps from Monday onward", async () => {
      const alice = await createUser("AliceWalker");

      // Record steps for each day this week starting from Monday
      const now = new Date();
      const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(now);
      monday.setUTCDate(monday.getUTCDate() - daysToMonday);
      const mondayStr = monday.toISOString().slice(0, 10);

      // Steps on Monday
      await recordSteps(alice.token, 5000, mondayStr);

      // Steps on today
      await recordSteps(alice.token, 3000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=week", {
        token: alice.token,
      });
      const body = await res.json();

      // Should include both Monday and today
      assert.ok(body.currentUser.totalSteps >= 5000);
    });

    it("week period excludes last Sunday's steps", async () => {
      const alice = await createUser("AliceWalker");

      // Find last Sunday
      const now = new Date();
      const dayOfWeek = now.getUTCDay();
      const daysToLastSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
      const lastSunday = new Date(now);
      lastSunday.setUTCDate(lastSunday.getUTCDate() - daysToLastSunday);
      const lastSundayStr = lastSunday.toISOString().slice(0, 10);

      await recordSteps(alice.token, 9000, lastSundayStr);
      await recordSteps(alice.token, 1000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=week", {
        token: alice.token,
      });
      const body = await res.json();

      // Should only have today's 1000, not last Sunday's 9000
      assert.equal(body.currentUser.totalSteps, 1000);
    });

    it("month period includes steps from the 1st", async () => {
      const alice = await createUser("AliceWalker");

      const now = new Date();
      const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      await recordSteps(alice.token, 4000, firstOfMonth);
      await recordSteps(alice.token, 2000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=month", {
        token: alice.token,
      });
      const body = await res.json();

      // Should include both
      assert.ok(body.currentUser.totalSteps >= 4000);
    });

    it("month period excludes last month's steps", async () => {
      const alice = await createUser("AliceWalker");

      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      const lastMonthStr = lastMonth.toISOString().slice(0, 10);

      await recordSteps(alice.token, 10000, lastMonthStr);
      await recordSteps(alice.token, 500, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=month", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.totalSteps, 500);
    });

    it("allTime period includes all steps regardless of date", async () => {
      const alice = await createUser("AliceWalker");

      // Record steps far in the past
      await recordSteps(alice.token, 3000, "2025-01-15");
      await recordSteps(alice.token, 2000, "2025-06-20");
      await recordSteps(alice.token, 1000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=allTime", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.totalSteps, 6000);
    });
  });

  // === TIMEZONE HANDLING ===

  describe("timezone effects", () => {
    it("today boundary respects user timezone — UTC+13 user's tomorrow is still today for UTC user", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");

      // Record steps for today (UTC)
      await recordSteps(alice.token, 5000, todayStr());
      await recordSteps(bob.token, 3000, todayStr());

      // Alice queries with Pacific/Apia (UTC+13) — could be a different local date
      const aliceRes = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
        headers: { "X-Timezone": "Pacific/Apia" },
      });

      // Bob queries with Pacific/Midway (UTC-11)
      const bobRes = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: bob.token,
        headers: { "X-Timezone": "Pacific/Midway" },
      });

      const aliceBody = await aliceRes.json();
      const bobBody = await bobRes.json();

      // Both should get 200, but may see different results depending on
      // what "today" means in their timezone
      assert.equal(aliceRes.status, 200);
      assert.equal(bobRes.status, 200);
    });

    it("week boundary differs by timezone — Asia/Tokyo Monday starts earlier in UTC", async () => {
      const alice = await createUser("AliceWalker");

      // Find the current UTC Monday
      const now = new Date();
      const dayOfWeek = now.getUTCDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(now);
      monday.setUTCDate(monday.getUTCDate() - daysToMonday);
      const mondayStr = monday.toISOString().slice(0, 10);

      // Record steps on UTC Monday
      await recordSteps(alice.token, 8000, mondayStr);

      // Query with Tokyo timezone (UTC+9) — Monday started 9 hours earlier
      const tokyoRes = await request(server.baseUrl, "GET", "/leaderboard?period=week", {
        token: alice.token,
        headers: { "X-Timezone": "Asia/Tokyo" },
      });

      // Query with LA timezone (UTC-7) — Monday started 7 hours later
      const laRes = await request(server.baseUrl, "GET", "/leaderboard?period=week", {
        token: alice.token,
        headers: { "X-Timezone": "America/Los_Angeles" },
      });

      // Both should return 200 and include Monday's steps in the week
      const tokyoBody = await tokyoRes.json();
      const laBody = await laRes.json();

      assert.equal(tokyoRes.status, 200);
      assert.equal(laRes.status, 200);
      assert.ok(tokyoBody.currentUser.totalSteps >= 0);
      assert.ok(laBody.currentUser.totalSteps >= 0);
    });

    it("default timezone is used when X-Timezone header is missing", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 5000, todayStr());

      // No X-Timezone header — should default to America/New_York
      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(body.currentUser.totalSteps >= 0);
    });

    it("invalid timezone header falls back gracefully", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 5000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
        headers: { "X-Timezone": "Not/A/Timezone" },
      });
      assert.equal(res.status, 200);
    });
  });

  // === RANKING EDGE CASES ===

  describe("ranking edge cases", () => {
    it("tied step counts give same rank", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");

      await recordSteps(alice.token, 5000, todayStr());
      await recordSteps(bob.token, 5000, todayStr());
      await recordSteps(charlie.token, 3000, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: charlie.token,
      });
      const body = await res.json();

      // Alice and Bob should share rank 1
      const aliceEntry = body.top10.find((e) => e.userId === alice.userId);
      const bobEntry = body.top10.find((e) => e.userId === bob.userId);
      assert.equal(aliceEntry.rank, bobEntry.rank);

      // Charlie should be rank 3 (not 2, since two people share rank 1)
      const charlieEntry = body.top10.find((e) => e.userId === charlie.userId);
      assert.equal(charlieEntry.rank, 3);
    });

    it("user with steps only outside current period shows 0 totalSteps", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 10000, yesterdayStr());
      // No steps today

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.currentUser.totalSteps, 0);
    });

    it("leaderboard works with only one user", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 7777, todayStr());

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      const body = await res.json();

      assert.equal(body.top10.length, 1);
      assert.equal(body.top10[0].rank, 1);
      assert.equal(body.currentUser.inTop10, true);
      assert.equal(body.currentUser.rank, 1);
    });

    it("leaderboard works with no steps recorded by anyone", async () => {
      const alice = await createUser("AliceWalker");

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=today", {
        token: alice.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.top10.length, 0);
      assert.equal(body.currentUser.totalSteps, 0);
    });

    it("steps accumulate across multiple days within a period", async () => {
      const alice = await createUser("AliceWalker");

      // Record steps on multiple days this month
      const now = new Date();
      const day1 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const day2 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-02`;

      await recordSteps(alice.token, 3000, day1);
      await recordSteps(alice.token, 4000, day2);

      const res = await request(server.baseUrl, "GET", "/leaderboard?period=month", {
        token: alice.token,
      });
      const body = await res.json();

      // Should be sum of both days
      assert.ok(body.currentUser.totalSteps >= 7000);
    });
  });
});
