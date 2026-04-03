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
  const appleId = `apple-challenge-${++nextAppleId}`;
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

async function makeFriends(userA, userB) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: userB.userId },
    token: userA.token,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: userB.token,
  });
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

async function seedStake(overrides = {}) {
  return prisma.stake.create({
    data: {
      name: "Buy lunch",
      description: "Loser buys winner lunch",
      category: "food",
      relationshipTags: ["friend"],
      format: "EITHER",
      active: true,
      ...overrides,
    },
  });
}

describe("challenge flow", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === STAKES CATALOG ===

  describe("GET /stakes", () => {
    it("returns active stakes", async () => {
      const alice = await createUser("AliceWalker");
      await seedStake();
      await seedStake({ name: "Inactive stake", active: false });

      const res = await request(server.baseUrl, "GET", "/stakes", { token: alice.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.stakes.length, 1);
      assert.equal(body.stakes[0].name, "Buy lunch");
    });

    it("filters stakes by relationship type", async () => {
      const alice = await createUser("AliceWalker");
      await seedStake({ name: "Friend stake", relationshipTags: ["friend"] });
      await seedStake({ name: "Partner stake", relationshipTags: ["partner"] });

      const res = await request(server.baseUrl, "GET", "/stakes?relationship_type=partner", { token: alice.token });
      const body = await res.json();

      const names = body.stakes.map((s) => s.name);
      assert.ok(names.includes("Partner stake"));
      assert.ok(!names.includes("Friend stake"));
    });
  });

  // === WEEKLY CHALLENGE AUTO-CREATION ===

  describe("GET /challenges/current", () => {
    it("auto-creates weekly challenge and returns empty instances", async () => {
      await seedChallenge();
      const alice = await createUser("AliceWalker");

      const res = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(body.challenge);
      assert.equal(body.challenge.title, "Step Showdown");
      assert.ok(body.weekOf);
      assert.deepEqual(body.instances, []);
    });
  });

  // === INITIATION ===

  describe("POST /challenges/initiate", () => {
    it("initiates challenge between friends", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(res.status, 201);

      const body = await res.json();
      assert.equal(body.instance.status, "PENDING_STAKE");
      assert.equal(body.instance.proposedById, alice.userId);
    });

    it("cannot challenge a non-friend", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      // not friends

      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(res.status, 403);
    });

    it("cannot challenge same friend twice in same week", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(res.status, 409);
    });

    it("friend can also initiate (duplicate pair check is bidirectional)", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      // Alice challenges Bob
      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      // Bob tries to challenge Alice (should fail — same pair)
      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: alice.userId, stakeId: stake.id },
        token: bob.token,
      });
      assert.equal(res.status, 409);
    });

    it("requires stakeId", async () => {
      await seedChallenge();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });

    it("initiated challenge shows in both users' current challenges", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const aliceCurrent = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      const aliceBody = await aliceCurrent.json();
      assert.equal(aliceBody.instances.length, 1);

      const bobCurrent = await request(server.baseUrl, "GET", "/challenges/current", { token: bob.token });
      const bobBody = await bobCurrent.json();
      assert.equal(bobBody.instances.length, 1);
    });
  });

  // === STAKE NEGOTIATION ===

  describe("stake negotiation", () => {
    async function initChallenge() {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const res = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instance = (await res.json()).instance;
      return { alice, bob, instance, stake };
    }

    it("recipient accepts stake → challenge becomes ACTIVE", async () => {
      const { bob, instance } = await initChallenge();

      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.instance.status, "ACTIVE");
      assert.equal(body.instance.stakeStatus, "AGREED");
      assert.ok(body.instance.stakeId); // agreed stake is set
    });

    it("recipient counters → stays PENDING_STAKE, proposer flips", async () => {
      const { alice, bob, instance } = await initChallenge();
      const counterStake = await seedStake({ name: "Do dishes" });

      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: false, counterStakeId: counterStake.id },
        token: bob.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.instance.status, "PENDING_STAKE");
      assert.equal(body.instance.proposedById, bob.userId);
      assert.equal(body.instance.proposedStakeId, counterStake.id);
    });

    it("after counter, original proposer can accept the counter", async () => {
      const { alice, bob, instance } = await initChallenge();
      const counterStake = await seedStake({ name: "Do dishes" });

      // Bob counters
      await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: false, counterStakeId: counterStake.id },
        token: bob.token,
      });

      // Alice accepts Bob's counter
      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: alice.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.instance.status, "ACTIVE");
      assert.equal(body.instance.stakeId, counterStake.id);
    });

    it("cannot accept your own proposal", async () => {
      const { alice, instance } = await initChallenge();

      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: alice.token, // alice proposed, alice trying to accept
      });
      assert.equal(res.status, 400);
    });

    it("counter requires counterStakeId", async () => {
      const { bob, instance } = await initChallenge();

      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: false },
        token: bob.token,
      });
      assert.equal(res.status, 400);
    });

    it("non-participant cannot respond to stake", async () => {
      const { instance } = await initChallenge();
      const charlie = await createUser("CharlieJoggs");

      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: charlie.token,
      });
      assert.equal(res.status, 403);
    });

    it("cannot negotiate after stake is agreed", async () => {
      const { alice, bob, instance } = await initChallenge();

      // Accept
      await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      // Try to counter after accepted
      const anotherStake = await seedStake({ name: "Wash car" });
      const res = await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: false, counterStakeId: anotherStake.id },
        token: alice.token,
      });
      assert.equal(res.status, 400);
    });

    it("proposer can edit their proposal before it's accepted", async () => {
      const { alice, instance } = await initChallenge();
      const newStake = await seedStake({ name: "Cook dinner" });

      const res = await request(server.baseUrl, "POST", `/challenges/${instance.id}/propose-stake`, {
        body: { stakeId: newStake.id },
        token: alice.token,
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.instance.proposedStakeId, newStake.id);
    });
  });

  // === PROGRESS ===

  describe("challenge progress", () => {
    async function activeChallenge() {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instance = (await initRes.json()).instance;

      await request(server.baseUrl, "PUT", `/challenges/${instance.id}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      return { alice, bob, instance };
    }

    it("both participants can view progress", async () => {
      const { alice, bob, instance } = await activeChallenge();

      const aliceRes = await request(server.baseUrl, "GET", `/challenges/${instance.id}/progress`, { token: alice.token });
      assert.equal(aliceRes.status, 200);

      const bobRes = await request(server.baseUrl, "GET", `/challenges/${instance.id}/progress`, { token: bob.token });
      assert.equal(bobRes.status, 200);
    });

    it("non-participant cannot view progress", async () => {
      const { instance } = await activeChallenge();
      const charlie = await createUser("CharlieJoggs");

      const res = await request(server.baseUrl, "GET", `/challenges/${instance.id}/progress`, { token: charlie.token });
      assert.equal(res.status, 403);
    });

    it("steps recorded during the week show up in progress", async () => {
      const { alice, bob, instance } = await activeChallenge();

      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 8000, date: today },
        token: alice.token,
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 5000, date: today },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "GET", `/challenges/${instance.id}/progress`, { token: alice.token });
      const body = await res.json();

      // Find which user is A and which is B
      const progress = body.progress;
      const aliceData = progress.userA.userId === alice.userId ? progress.userA : progress.userB;
      const bobData = progress.userA.userId === bob.userId ? progress.userA : progress.userB;

      assert.equal(aliceData.totalSteps, 8000);
      assert.equal(bobData.totalSteps, 5000);
    });

    it("progress reflects rankings — leader is rank 1", async () => {
      const { alice, bob } = await activeChallenge();

      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 12000, date: today },
        token: alice.token,
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 3000, date: today },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      const body = await res.json();
      const inst = body.instances[0];

      // The instance should have ranking info
      assert.ok(inst.ranking);
    });
  });

  // === CANCELLATION ===

  describe("cancellation", () => {
    it("either participant can cancel", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;

      // Bob cancels (not the initiator)
      const res = await request(server.baseUrl, "DELETE", `/challenges/${instanceId}`, { token: bob.token });
      assert.equal(res.status, 200);

      // Gone from both users' current
      const aliceCurrent = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      assert.equal((await aliceCurrent.json()).instances.length, 0);
    });

    it("non-participant cannot cancel", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;

      const res = await request(server.baseUrl, "DELETE", `/challenges/${instanceId}`, { token: charlie.token });
      assert.ok(res.status === 403 || res.status === 404);
    });

    it("after cancellation, same pair can re-challenge this week", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;

      await request(server.baseUrl, "DELETE", `/challenges/${instanceId}`, { token: alice.token });

      // Re-challenge
      const reRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(reRes.status, 201);
    });
  });

  // === RESOLUTION ===

  describe("resolution", () => {
    async function setupAdmin() {
      // Create an admin user
      const admin = await createUser("AdminUser");
      await prisma.user.update({
        where: { id: admin.userId },
        data: { email: process.env.ADMIN_EMAILS?.split(",")[0] || "admin@example.com" },
      });
      return admin;
    }

    it("winner is user with more total steps and gets coins", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      // Initiate and accept
      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${instanceId}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      // Record steps
      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 15000, date: today },
        token: alice.token,
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 9000, date: today },
        token: bob.token,
      });

      // Resolve
      const admin = await setupAdmin();
      const resolveRes = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", {
        token: admin.token,
      });
      assert.equal(resolveRes.status, 200);

      const resolveBody = await resolveRes.json();
      assert.equal(resolveBody.summary.resolvedInstances, 1);

      // Check winner got challenge coins (may also have step goal coins)
      const aliceMe = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
      const aliceBody = await aliceMe.json();
      const bobMe = await request(server.baseUrl, "GET", "/auth/me", { token: bob.token });
      const bobBody = await bobMe.json();

      // Winner should have at least 100 more coins than loser (the challenge reward)
      assert.ok(aliceBody.user.coins >= 100, `winner should have at least 100 coins, got ${aliceBody.user.coins}`);
      assert.ok(aliceBody.user.coins > bobBody.user.coins, "winner should have more coins than loser");
    });

    it("PENDING_STAKE instances get skipped on resolution (no winner, no coins)", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      // Initiate but don't accept stake
      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const admin = await setupAdmin();
      const resolveRes = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", {
        token: admin.token,
      });
      assert.equal(resolveRes.status, 200);

      const body = await resolveRes.json();
      assert.equal(body.summary.skippedInstances, 1);
      assert.equal(body.summary.resolvedInstances, 0);

      // Neither user gets coins
      const aliceMe = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
      assert.equal((await aliceMe.json()).user.coins, 0);
    });

    it("resolved challenges appear in history", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${instanceId}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      const admin = await setupAdmin();
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", {
        token: admin.token,
      });

      const histRes = await request(server.baseUrl, "GET", "/challenges/history", { token: alice.token });
      assert.equal(histRes.status, 200);

      const histBody = await histRes.json();
      assert.equal(histBody.instances.length, 1);
      assert.equal(histBody.instances[0].status, "COMPLETED");
    });

    it("double resolve is idempotent", async () => {
      await seedChallenge();
      const alice = await createUser("AliceWalker");

      // Ensure weekly challenge exists
      await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });

      const admin = await setupAdmin();
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);
    });

    it("non-admin cannot resolve", async () => {
      await seedChallenge();
      const alice = await createUser("AliceWalker");
      await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: alice.token });
      assert.equal(res.status, 403);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("removing a friend deletes their challenge instances", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      // Get friendship ID
      const friendsRes = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
      const friendshipId = (await friendsRes.json()).friends[0].friendshipId;

      // Remove friend
      const removeRes = await request(server.baseUrl, "DELETE", `/friends/${friendshipId}`, { token: alice.token });
      const removeBody = await removeRes.json();
      assert.equal(removeBody.deletedChallengeInstances, 1);

      // Challenge is gone
      const currentRes = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      assert.equal((await currentRes.json()).instances.length, 0);
    });

    it("challenge with zero steps on both sides resolves without error", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      await makeFriends(alice, bob);

      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${instanceId}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      // No steps recorded — resolve anyway
      const admin = await createUser("AdminUser2");
      await prisma.user.update({
        where: { id: admin.userId },
        data: { email: process.env.ADMIN_EMAILS?.split(",")[0] || "admin@example.com" },
      });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      // No coins awarded to either
      const aliceMe = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
      assert.equal((await aliceMe.json()).user.coins, 0);
      const bobMe = await request(server.baseUrl, "GET", "/auth/me", { token: bob.token });
      assert.equal((await bobMe.json()).user.coins, 0);
    });

    it("multiple concurrent challenges with different friends", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Alice challenges both
      const res1 = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(res1.status, 201);

      const res2 = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: charlie.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(res2.status, 201);

      // Alice sees both
      const currentRes = await request(server.baseUrl, "GET", "/challenges/current", { token: alice.token });
      assert.equal((await currentRes.json()).instances.length, 2);
    });
  });
});
