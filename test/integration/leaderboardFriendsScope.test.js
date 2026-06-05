const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// New tests for Feature 2: friends/global scope on the steps + races
// leaderboards. These live in a separate file so the existing leaderboard
// suite stays untouched. They exercise the new ?scope=friends query param and
// confirm ?scope=global (and scope absent) behave identically to before.

let server;
let nextAppleId = 0;
const DEFAULT_TIME_ZONE = "America/New_York";

async function createUser(displayName) {
  const appleId = `apple-lb-scope-${++nextAppleId}`;
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

// Establish an ACCEPTED friendship between two users via the API flow, mirroring
// friends.test.js (request -> read incoming -> accept).
async function makeFriends(a, b) {
  await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const incoming = await request(server.baseUrl, "GET", "/friends", {
    token: b.token,
  });
  const incomingBody = await incoming.json();
  const friendshipId = incomingBody.pending.incoming[0].friendshipId;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createCompletedRace({ name, winnerUserId, participants }) {
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

function getDateStringInTimeZone(offsetDays = 0, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

function todayStr() {
  return getDateStringInTimeZone(0);
}

describe("leaderboard friends scope", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  describe("scope validation + compat", () => {
    it("rejects an unknown scope with 400", async () => {
      const alice = await createUser("AliceWalker");

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=enemies",
        { token: alice.token }
      );

      assert.equal(res.status, 400);
    });

    it("absent scope behaves identically to scope=global (steps)", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await recordSteps(alice.token, 9000, todayStr());
      await recordSteps(bob.token, 5000, todayStr());

      const defaultRes = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today",
        { token: alice.token }
      );
      const globalRes = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=global",
        { token: alice.token }
      );

      assert.equal(defaultRes.status, 200);
      assert.equal(globalRes.status, 200);
      assert.deepEqual(await defaultRes.json(), await globalRes.json());
    });

    it("accepts scope=global explicitly", async () => {
      const alice = await createUser("AliceWalker");
      await recordSteps(alice.token, 4000, todayStr());

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?type=races&scope=global",
        { token: alice.token }
      );

      assert.equal(res.status, 200);
    });
  });

  describe("friends scope — steps", () => {
    it("includes only the viewer + accepted friends, excluding non-friends", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const stranger = await createUser("StrangerStep");

      await makeFriends(alice, bob);

      await recordSteps(alice.token, 7000, todayStr());
      await recordSteps(bob.token, 9000, todayStr());
      // Stranger out-walks everyone but isn't a friend.
      await recordSteps(stranger.token, 99000, todayStr());

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=friends",
        { token: alice.token }
      );
      assert.equal(res.status, 200);

      const body = await res.json();
      const ids = body.top100.map((entry) => entry.userId);

      assert.ok(ids.includes(alice.userId));
      assert.ok(ids.includes(bob.userId));
      assert.equal(ids.includes(stranger.userId), false);
      assert.equal(body.top100.length, 2);

      // Bob has more steps so he is rank 1; Alice is rank 2 within the friend set.
      assert.equal(body.top100[0].userId, bob.userId);
      assert.equal(body.top100[1].userId, alice.userId);
    });

    it("ranks the viewer within the friend set, not globally", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const stranger = await createUser("StrangerStep");

      await makeFriends(alice, bob);

      await recordSteps(alice.token, 7000, todayStr());
      await recordSteps(bob.token, 9000, todayStr());
      await recordSteps(stranger.token, 99000, todayStr());

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=friends",
        { token: alice.token }
      );
      const body = await res.json();

      // Globally Alice would be rank 3 (behind stranger + bob); within friends
      // she is rank 2 (behind bob only).
      assert.equal(body.currentUser.rank, 2);
      assert.equal(body.currentUser.totalSteps, 7000);
      assert.equal(body.currentUser.inTop100, true);
    });

    it("a viewer with no friends sees only themself", async () => {
      const loner = await createUser("LonerWalk");
      const stranger = await createUser("StrangerStep");
      await recordSteps(loner.token, 3000, todayStr());
      await recordSteps(stranger.token, 50000, todayStr());

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=friends",
        { token: loner.token }
      );
      const body = await res.json();

      assert.equal(body.top100.length, 1);
      assert.equal(body.top100[0].userId, loner.userId);
      assert.equal(body.currentUser.rank, 1);
      assert.equal(body.currentUser.inTop100, true);
    });

    it("keeps the global response shape (top10/top100/currentUser)", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);
      await recordSteps(alice.token, 7000, todayStr());
      await recordSteps(bob.token, 9000, todayStr());

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?period=today&scope=friends",
        { token: alice.token }
      );
      const body = await res.json();

      assert.ok(Array.isArray(body.top10));
      assert.ok(Array.isArray(body.top100));
      assert.ok(body.currentUser);
      assert.equal(typeof body.currentUser.inTop10, "boolean");
      assert.equal(typeof body.currentUser.inTop100, "boolean");
    });
  });

  describe("friends scope — races", () => {
    it("includes only the viewer + accepted friends in the race record board", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const stranger = await createUser("StrangerStep");

      await makeFriends(alice, bob);

      await createCompletedRace({
        name: "friend-race",
        winnerUserId: bob.userId,
        participants: [
          { userId: bob.userId, placement: 1, totalSteps: 120000 },
          { userId: alice.userId, placement: 2, totalSteps: 110000 },
          { userId: stranger.userId, placement: 3, totalSteps: 105000 },
        ],
      });

      const res = await request(
        server.baseUrl,
        "GET",
        "/leaderboard?type=races&scope=friends",
        { token: alice.token }
      );
      assert.equal(res.status, 200);

      const body = await res.json();
      const ids = body.top100.map((entry) => entry.userId);

      assert.ok(ids.includes(alice.userId));
      assert.ok(ids.includes(bob.userId));
      assert.equal(ids.includes(stranger.userId), false);
      assert.equal(body.currentUser.displayName, "AliceWalker");
    });
  });
});
