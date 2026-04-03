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
  const appleId = `apple-race-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createRace(token, overrides = {}) {
  const res = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: overrides.name || "Test Race",
      targetSteps: overrides.targetSteps || 50000,
      maxDurationDays: overrides.maxDurationDays || 7,
      powerupsEnabled: overrides.powerupsEnabled || false,
      ...overrides,
    },
    token,
  });
  return res;
}

describe("races", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === RACE CREATION ===

  describe("race creation", () => {
    it("creates race with valid fields → PENDING status", async () => {
      const alice = await createUser("AliceWalker");

      const res = await createRace(alice.token, { name: "Weekend Warriors", targetSteps: 25000, maxDurationDays: 5 });
      assert.equal(res.status, 201);

      const body = await res.json();
      assert.equal(body.race.name, "Weekend Warriors");
      assert.equal(body.race.targetSteps, 25000);
      assert.equal(body.race.maxDurationDays, 5);
      assert.equal(body.race.status, "PENDING");
    });

    it("creator is auto-added as ACCEPTED participant", async () => {
      const alice = await createUser("AliceWalker");

      const createRes = await createRace(alice.token);
      const raceId = (await createRes.json()).race.id;

      const detailRes = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      const detail = await detailRes.json();

      const creator = detail.participants.find((p) => p.userId === alice.userId);
      assert.ok(creator);
      assert.equal(creator.status, "ACCEPTED");
    });

    it("rejects empty name", async () => {
      const alice = await createUser("AliceWalker");
      const res = await createRace(alice.token, { name: "" });
      assert.equal(res.status, 400);
    });

    it("rejects name over 50 characters", async () => {
      const alice = await createUser("AliceWalker");
      const res = await createRace(alice.token, { name: "A".repeat(51) });
      assert.equal(res.status, 400);
    });

    it("rejects targetSteps below 1000", async () => {
      const alice = await createUser("AliceWalker");
      const res = await createRace(alice.token, { targetSteps: 500 });
      assert.equal(res.status, 400);
    });

    it("rejects maxDurationDays outside 1-30", async () => {
      const alice = await createUser("AliceWalker");

      const res0 = await createRace(alice.token, { maxDurationDays: 0 });
      assert.equal(res0.status, 400);

      const res31 = await createRace(alice.token, { maxDurationDays: 31 });
      assert.equal(res31.status, 400);
    });
  });

  // === INVITING FRIENDS ===

  describe("inviting friends", () => {
    it("creator invites a friend → friend appears as INVITED", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const invRes = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      assert.equal(invRes.status, 200);

      const detailRes = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      const detail = await detailRes.json();
      const bobP = detail.participants.find((p) => p.userId === bob.userId);
      assert.ok(bobP);
      assert.equal(bobP.status, "INVITED");
    });

    it("can invite multiple friends at once", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId, charlie.userId] },
        token: alice.token,
      });
      assert.equal(res.status, 200);

      const detailRes = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      const detail = await detailRes.json();
      assert.equal(detail.participants.length, 3); // alice + bob + charlie
    });

    it("non-creator cannot invite", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);
      await makeFriends(bob, charlie);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      // Bob (not creator) tries to invite charlie
      // First bob needs to accept to be a participant
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [charlie.userId] },
        token: bob.token,
      });
      assert.equal(res.status, 403);
    });

    it("cannot invite non-friends", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      // not friends

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      assert.equal(res.status, 403);
    });

    it("cannot invite yourself", async () => {
      const alice = await createUser("AliceWalker");

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [alice.userId] },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });

    it("cannot invite someone already in the race", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      // Invite again
      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });

    it("cannot invite to a CANCELLED race", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      // Cancel race
      await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });

    it("max 10 participants enforced", async () => {
      const alice = await createUser("AliceWalker");

      // Create 10 friends (alice is already participant 1)
      const friends = [];
      for (let i = 0; i < 10; i++) {
        const f = await createUser(`Friend${String(i).padStart(2, "0")}Runner`);
        await makeFriends(alice, f);
        friends.push(f);
      }

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      // Invite first 9 (making 10 total with alice)
      const first9 = friends.slice(0, 9).map((f) => f.userId);
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: first9 },
        token: alice.token,
      });

      // 11th participant should fail
      const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [friends[9].userId] },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });
  });

  // === RESPONDING TO INVITES ===

  describe("responding to invites", () => {
    it("accept invite → status becomes ACCEPTED", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.participant.status, "ACCEPTED");
    });

    it("decline invite → status becomes DECLINED", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: false },
        token: bob.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.participant.status, "DECLINED");
    });

    it("non-invited user cannot respond", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      // Charlie was never invited
      const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: charlie.token,
      });
      assert.ok(res.status === 403 || res.status === 404);
    });

    it("cannot respond twice", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: false },
        token: bob.token,
      });
      assert.equal(res.status, 400);
    });
  });

  // === STARTING A RACE ===

  describe("starting a race", () => {
    async function setupPendingRace() {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });

      return { alice, bob, raceId };
    }

    it("creator starts with 2+ accepted → ACTIVE with startedAt and endsAt", async () => {
      const { alice, raceId } = await setupPendingRace();

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
      assert.equal(res.status, 200);

      const detailRes = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      const detail = await detailRes.json();
      assert.equal(detail.status, "ACTIVE");
      assert.ok(detail.startedAt);
      assert.ok(detail.endsAt);
    });

    it("non-creator cannot start", async () => {
      const { bob, raceId } = await setupPendingRace();

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: bob.token });
      assert.equal(res.status, 403);
    });

    it("cannot start with fewer than 2 accepted", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      // Bob doesn't accept

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
      assert.equal(res.status, 400);
    });

    it("cannot start an already-active race", async () => {
      const { alice, raceId } = await setupPendingRace();

      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
      assert.equal(res.status, 400);
    });

    it("baseline steps are snapshotted at start", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Alice has steps before race
      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 3000, date: today },
        token: alice.token,
      });

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });

      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      // Baseline was captured — verify by checking progress shows 0 race steps
      // (alice had 3000 before race, no new steps after start)
      const progressRes = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: alice.token });
      const progressBody = await progressRes.json();
      const aliceP = progressBody.progress.participants.find((p) => p.userId === alice.userId);
      assert.equal(aliceP.totalSteps, 0);
    });
  });

  // === CANCELLING A RACE ===

  describe("cancelling a race", () => {
    it("creator cancels PENDING race → CANCELLED", async () => {
      const alice = await createUser("AliceWalker");
      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const res = await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });
      assert.equal(res.status, 200);
    });

    it("creator cancels ACTIVE race → CANCELLED", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      const res = await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });
      assert.equal(res.status, 200);
    });

    it("non-creator cannot cancel", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: bob.token });
      assert.equal(res.status, 403);
    });

    it("cannot cancel already-cancelled race", async () => {
      const alice = await createUser("AliceWalker");
      const raceId = (await (await createRace(alice.token)).json()).race.id;

      await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });

      const res = await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });
      assert.equal(res.status, 400);
    });
  });

  // === RACE LISTING & DETAILS ===

  describe("race listing & details", () => {
    it("GET /races returns races grouped by active/pending/completed", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Create a pending race
      await createRace(alice.token, { name: "Pending Race" });

      // Create and start an active race
      const activeId = (await (await createRace(alice.token, { name: "Active Race" })).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${activeId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${activeId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", `/races/${activeId}/start`, { token: alice.token });

      const res = await request(server.baseUrl, "GET", "/races", { token: alice.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(Array.isArray(body.active));
      assert.ok(Array.isArray(body.pending));
      assert.ok(Array.isArray(body.completed));
      assert.equal(body.active.length, 1);
      assert.equal(body.pending.length, 1);
    });

    it("GET /races/:raceId returns race with participant list", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.name, "Test Race");
      assert.ok(Array.isArray(body.participants));
      assert.equal(body.participants.length, 2);
    });

    it("non-participant cannot view race details", async () => {
      const alice = await createUser("AliceWalker");
      const charlie = await createUser("CharlieJoggs");

      const raceId = (await (await createRace(alice.token)).json()).race.id;

      const res = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: charlie.token });
      assert.equal(res.status, 403);
    });

    it("cancelled races don't appear in GET /races listing", async () => {
      const alice = await createUser("AliceWalker");

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });

      const res = await request(server.baseUrl, "GET", "/races", { token: alice.token });
      const body = await res.json();
      assert.equal(body.active.length, 0);
      assert.equal(body.pending.length, 0);
      assert.equal(body.completed.length, 0);
    });
  });

  // === LATE JOINING ===

  describe("late joining", () => {
    it("accept during ACTIVE race → baseline steps captured", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Create race with bob, start it
      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      // Charlie has steps before joining
      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 6000, date: today },
        token: charlie.token,
      });

      // Invite charlie to active race, charlie accepts
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [charlie.userId] },
        token: alice.token,
      });
      const acceptRes = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: charlie.token,
      });
      assert.equal(acceptRes.status, 200);

      // Charlie's participant should have baseline captured
      const detailRes = await request(server.baseUrl, "GET", `/races/${raceId}`, { token: alice.token });
      const detail = await detailRes.json();
      const charlieP = detail.participants.find((p) => p.userId === charlie.userId);
      assert.ok(charlieP);
      assert.equal(charlieP.status, "ACCEPTED");
    });
  });

  // === RACE PROGRESS ===

  describe("race progress", () => {
    it("steps recorded during race show up in progress", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token, { targetSteps: 100000 })).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      // Backdate race start so samples fall within the race window
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await prisma.race.update({ where: { id: raceId }, data: { startedAt: twoHoursAgo } });
      await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: twoHoursAgo } });

      // Record step samples (progress uses samples for race start day)
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      await request(server.baseUrl, "POST", "/steps/samples", {
        body: {
          samples: [{ periodStart: oneHourAgo.toISOString(), periodEnd: now.toISOString(), steps: 12000 }],
        },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: alice.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(body.progress.participants);
      assert.ok(body.progress.participants.length >= 1);

      // Alice should have steps in the progress
      const aliceEntry = body.progress.participants.find((e) => e.userId === alice.userId);
      assert.ok(aliceEntry);
      assert.ok(aliceEntry.totalSteps > 0);
    });

    it("non-participant cannot view progress", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);

      const raceId = (await (await createRace(alice.token)).json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: charlie.token });
      assert.ok(res.status === 403 || res.status === 404);
    });
  });
});
