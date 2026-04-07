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

async function seedChallenge() {
  return prisma.challenge.create({
    data: {
      title: "Step Showdown",
      description: "Most steps wins",
      type: "HEAD_TO_HEAD",
      resolutionRule: "higher_total",
      active: true,
    },
  });
}

async function createCompletedChallengeInstance({
  challengeId,
  weekOf,
  userAId,
  userBId,
  winnerUserId,
  userATotalSteps = winnerUserId === userAId ? 12000 : 8000,
  userBTotalSteps = winnerUserId === userBId ? 12000 : 8000,
}) {
  return prisma.challengeInstance.create({
    data: {
      challengeId,
      weekOf: new Date(weekOf),
      userAId,
      userBId,
      status: "COMPLETED",
      stakeStatus: "SKIPPED",
      winnerUserId,
      userATotalSteps,
      userBTotalSteps,
      resolvedAt: new Date(`${weekOf}T12:00:00.000Z`),
    },
  });
}

async function createChallengeRecord({
  challengeId,
  user,
  wins,
  losses,
  label,
}) {
  for (let i = 0; i < wins; i++) {
    const opponent = await createUser(`${label}WinOpp${i}`);
    await createCompletedChallengeInstance({
      challengeId,
      weekOf: `2026-01-${String(i + 1).padStart(2, "0")}`,
      userAId: user.userId,
      userBId: opponent.userId,
      winnerUserId: user.userId,
    });
  }

  for (let i = 0; i < losses; i++) {
    const opponent = await createUser(`${label}LossOpp${i}`);
    await createCompletedChallengeInstance({
      challengeId,
      weekOf: `2026-02-${String(i + 1).padStart(2, "0")}`,
      userAId: user.userId,
      userBId: opponent.userId,
      winnerUserId: opponent.userId,
    });
  }
}

async function createCompletedRace({
  name,
  winnerUserId,
  participants,
}) {
  const race = await prisma.race.create({
    data: {
      creatorId: participants[0].userId,
      name,
      targetSteps: 100000,
      status: "COMPLETED",
      startedAt: new Date("2026-03-01T00:00:00.000Z"),
      endsAt: new Date("2026-03-08T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T12:00:00.000Z"),
      winnerUserId,
    },
  });

  await prisma.raceParticipant.createMany({
    data: participants.map((participant) => ({
      raceId: race.id,
      userId: participant.userId,
      status: "ACCEPTED",
      totalSteps: participant.totalSteps ?? 100000,
      baselineSteps: participant.baselineSteps ?? 0,
      nextBoxAtSteps: participant.nextBoxAtSteps ?? 0,
      bonusSteps: participant.bonusSteps ?? 0,
      powerupSlots: participant.powerupSlots ?? 3,
      placement: participant.placement ?? null,
      finishedAt: participant.finishedAt ?? new Date("2026-03-02T12:00:00.000Z"),
      finishTotalSteps: participant.finishTotalSteps ?? participant.totalSteps ?? 100000,
    })),
  });

  return race;
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

    it("invalid type returns 400", async () => {
      const alice = await createUser("AliceWalker");

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=bananas", {
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

  describe("challenge record leaderboard", () => {
    it("ranks qualified users by win percentage and excludes users under 5 completed challenges", async () => {
      const challenge = await seedChallenge();
      const ace = await createUser("AceWinner");
      const blaze = await createUser("BlazeRun");
      const cedar = await createUser("CedarJog");

      await createChallengeRecord({
        challengeId: challenge.id,
        user: ace,
        wins: 5,
        losses: 0,
        label: "ace",
      });
      await createChallengeRecord({
        challengeId: challenge.id,
        user: blaze,
        wins: 4,
        losses: 1,
        label: "blaze",
      });
      await createChallengeRecord({
        challengeId: challenge.id,
        user: cedar,
        wins: 4,
        losses: 0,
        label: "cedar",
      });

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=challenges", {
        token: ace.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.top10.length, 2);
      assert.deepEqual(
        body.top10.map((entry) => ({
          displayName: entry.displayName,
          rank: entry.rank,
          wins: entry.wins,
          losses: entry.losses,
        })),
        [
          { displayName: "AceWinner", rank: 1, wins: 5, losses: 0 },
          { displayName: "BlazeRun", rank: 2, wins: 4, losses: 1 },
        ]
      );
      assert.equal(body.top10.some((entry) => entry.displayName === "CedarJog"), false);
      assert.equal(body.currentUser.displayName, "AceWinner");
      assert.equal(body.currentUser.rank, 1);
      assert.equal(body.currentUser.inTop10, true);
      assert.equal(body.currentUser.qualified, true);
    });

    it("returns current user as unranked when they are below the qualification minimum", async () => {
      const challenge = await seedChallenge();
      const ace = await createUser("AceWinner");
      const cedar = await createUser("CedarJog");

      await createChallengeRecord({
        challengeId: challenge.id,
        user: ace,
        wins: 5,
        losses: 0,
        label: "ace",
      });
      await createChallengeRecord({
        challengeId: challenge.id,
        user: cedar,
        wins: 4,
        losses: 0,
        label: "cedar",
      });

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=challenges", {
        token: cedar.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.top10.some((entry) => entry.displayName === "CedarJog"), false);
      assert.deepEqual(body.currentUser, {
        rank: null,
        displayName: "CedarJog",
        wins: 4,
        losses: 0,
        completedCount: 4,
        winPercentage: 1,
        inTop10: false,
        qualified: false,
      });
    });

    it("breaks challenge leaderboard ties by more completed challenges then more wins", async () => {
      const challenge = await seedChallenge();
      const atlas = await createUser("AtlasRun");
      const bolt = await createUser("BoltStep");
      const cinder = await createUser("CinderGo");

      await createChallengeRecord({
        challengeId: challenge.id,
        user: atlas,
        wins: 8,
        losses: 2,
        label: "atlas",
      });
      await createChallengeRecord({
        challengeId: challenge.id,
        user: bolt,
        wins: 4,
        losses: 1,
        label: "bolt",
      });
      await createChallengeRecord({
        challengeId: challenge.id,
        user: cinder,
        wins: 8,
        losses: 2,
        label: "cinder",
      });

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=challenges", {
        token: atlas.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.deepEqual(
        body.top10.map((entry) => ({
          displayName: entry.displayName,
          rank: entry.rank,
          wins: entry.wins,
          losses: entry.losses,
          completedCount: entry.completedCount,
        })),
        [
          { displayName: "AtlasRun", rank: 1, wins: 8, losses: 2, completedCount: 10 },
          { displayName: "CinderGo", rank: 1, wins: 8, losses: 2, completedCount: 10 },
          { displayName: "BoltStep", rank: 3, wins: 4, losses: 1, completedCount: 5 },
        ]
      );
    });
  });

  describe("race record leaderboard", () => {
    it("ranks users by hidden race points from completed races only", async () => {
      const atlas = await createUser("AtlasRun");
      const blaze = await createUser("BlazeRun");
      const cinder = await createUser("CinderGo");
      const drift = await createUser("DriftRun");

      await createCompletedRace({
        name: "race-1",
        winnerUserId: blaze.userId,
        participants: [
          { userId: blaze.userId, placement: 1, totalSteps: 110000 },
          { userId: atlas.userId, placement: 2, totalSteps: 105000 },
          { userId: cinder.userId, placement: 3, totalSteps: 101000 },
          { userId: drift.userId, placement: 4, totalSteps: 98000, finishedAt: null, finishTotalSteps: null },
        ],
      });

      await createCompletedRace({
        name: "race-2",
        winnerUserId: atlas.userId,
        participants: [
          { userId: atlas.userId, placement: 1, totalSteps: 120000 },
          { userId: cinder.userId, placement: 2, totalSteps: 115000 },
          { userId: drift.userId, placement: 3, totalSteps: 111000 },
          { userId: blaze.userId, placement: 4, totalSteps: 107000, finishedAt: null, finishTotalSteps: null },
        ],
      });

      await prisma.race.create({
        data: {
          creatorId: drift.userId,
          name: "ignored-active-race",
          targetSteps: 100000,
          status: "ACTIVE",
          startedAt: new Date("2026-03-10T00:00:00.000Z"),
          endsAt: new Date("2026-03-17T00:00:00.000Z"),
          participants: {
            create: [
              { userId: atlas.userId, status: "ACCEPTED" },
              { userId: drift.userId, status: "ACCEPTED" },
            ],
          },
        },
      });

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=races", {
        token: atlas.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.deepEqual(
        body.top10.map((entry) => ({
          displayName: entry.displayName,
          rank: entry.rank,
          firsts: entry.firsts,
          seconds: entry.seconds,
          thirds: entry.thirds,
        })),
        [
          { displayName: "AtlasRun", rank: 1, firsts: 1, seconds: 1, thirds: 0 },
          { displayName: "BlazeRun", rank: 2, firsts: 1, seconds: 0, thirds: 0 },
          { displayName: "CinderGo", rank: 3, firsts: 0, seconds: 1, thirds: 1 },
          { displayName: "DriftRun", rank: 4, firsts: 0, seconds: 0, thirds: 1 },
        ]
      );
      assert.equal(body.currentUser.displayName, "AtlasRun");
      assert.equal(body.currentUser.rank, 1);
      assert.equal(body.currentUser.inTop10, true);
    });

    it("breaks race leaderboard ties by firsts then seconds then thirds", async () => {
      const atlas = await createUser("AtlasRun");
      const blaze = await createUser("BlazeRun");
      const cinder = await createUser("CinderGo");
      const drift = await createUser("DriftRun");
      const ember = await createUser("EmberRun");

      await createCompletedRace({
        name: "atlas-win",
        winnerUserId: atlas.userId,
        participants: [
          { userId: atlas.userId, placement: 1 },
          { userId: drift.userId, placement: 2 },
          { userId: ember.userId, placement: 3 },
        ],
      });

      await createCompletedRace({
        name: "blaze-second-a",
        winnerUserId: drift.userId,
        participants: [
          { userId: drift.userId, placement: 1 },
          { userId: blaze.userId, placement: 2 },
          { userId: ember.userId, placement: 3 },
        ],
      });

      await createCompletedRace({
        name: "blaze-second-b",
        winnerUserId: ember.userId,
        participants: [
          { userId: ember.userId, placement: 1 },
          { userId: blaze.userId, placement: 2 },
          { userId: drift.userId, placement: 3 },
        ],
      });

      await createCompletedRace({
        name: "cinder-third-a",
        winnerUserId: drift.userId,
        participants: [
          { userId: drift.userId, placement: 1 },
          { userId: ember.userId, placement: 2 },
          { userId: cinder.userId, placement: 3 },
        ],
      });

      await createCompletedRace({
        name: "cinder-third-b",
        winnerUserId: drift.userId,
        participants: [
          { userId: drift.userId, placement: 1 },
          { userId: ember.userId, placement: 2 },
          { userId: cinder.userId, placement: 3 },
        ],
      });

      await createCompletedRace({
        name: "cinder-third-c",
        winnerUserId: drift.userId,
        participants: [
          { userId: drift.userId, placement: 1 },
          { userId: ember.userId, placement: 2 },
          { userId: cinder.userId, placement: 3 },
        ],
      });

      const res = await request(server.baseUrl, "GET", "/leaderboard?type=races", {
        token: atlas.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.deepEqual(
        body.top10.map((entry) => ({
          displayName: entry.displayName,
          rank: entry.rank,
          firsts: entry.firsts,
          seconds: entry.seconds,
          thirds: entry.thirds,
        })),
        [
          { displayName: "DriftRun", rank: 1, firsts: 4, seconds: 1, thirds: 1 },
          { displayName: "EmberRun", rank: 2, firsts: 1, seconds: 3, thirds: 2 },
          { displayName: "AtlasRun", rank: 3, firsts: 1, seconds: 0, thirds: 0 },
          { displayName: "BlazeRun", rank: 4, firsts: 0, seconds: 2, thirds: 0 },
          { displayName: "CinderGo", rank: 5, firsts: 0, seconds: 0, thirds: 3 },
        ]
      );
    });
  });
});
