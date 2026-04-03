const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-admin-${++nextAppleId}`;
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

async function createAdmin(displayName) {
  const admin = await createUser(displayName);
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

async function seedChallenge() {
  return prisma.challenge.create({
    data: {
      title: "Admin Test Challenge",
      description: "Test challenge for admin",
      type: "HEAD_TO_HEAD",
      resolutionRule: "higher_total",
      active: true,
    },
  });
}

async function seedStake() {
  return prisma.stake.create({
    data: {
      name: "Test Stake",
      description: "Loser does dishes",
      category: "chores",
      relationshipTags: ["friend"],
      format: "EITHER",
      active: true,
    },
  });
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

describe("admin", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === ACCESS CONTROL ===

  describe("access control", () => {
    it("non-admin gets 403 on GET /admin/weekly-challenge", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/ensure-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/resolve-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/reset-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("unauthenticated request gets 401", async () => {
      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge");
      assert.equal(res.status, 401);
    });

    it("admin user can access admin endpoints", async () => {
      await seedChallenge();
      const admin = await createAdmin("AdminPerson");

      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge", { token: admin.token });
      assert.equal(res.status, 200);
    });

    it("isAdmin flag is true on sign-in for admin user", async () => {
      // Create user then set admin email
      const appleId = `apple-admin-flag-test`;
      const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
        body: { identityToken: appleId, email: ADMIN_EMAIL },
      });
      const body = await signInRes.json();
      assert.equal(body.user.isAdmin, true);
    });

    it("isAdmin flag is false for regular user", async () => {
      const appleId = `apple-regular-flag-test`;
      const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
        body: { identityToken: appleId, email: "nobody@example.com" },
      });
      const body = await signInRes.json();
      assert.equal(body.user.isAdmin, false);
    });

    it("GET /auth/me returns isAdmin flag", async () => {
      const admin = await createAdmin("AdminPerson");
      const res = await request(server.baseUrl, "GET", "/auth/me", { token: admin.token });
      const body = await res.json();
      assert.equal(body.user.isAdmin, true);
    });
  });

  // === GET /admin/weekly-challenge ===

  describe("GET /admin/weekly-challenge", () => {
    it("returns weekly challenge state with instance counts", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Ensure weekly challenge exists
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: admin.token });

      // Create an instance
      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(body.weeklyChallenge);
      assert.ok(body.instanceCounts);
      assert.equal(body.instanceCounts.total, 1);
      assert.equal(body.instanceCounts.pendingStake, 1);
      assert.equal(body.instanceCounts.active, 0);
      assert.equal(body.instanceCounts.completed, 0);
    });

    it("returns null/empty when no weekly challenge exists", async () => {
      const admin = await createAdmin("AdminPerson");

      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.weeklyChallenge, null);
      assert.deepEqual(body.instances, []);
    });
  });

  // === POST /admin/weekly-challenge/ensure-current ===

  describe("POST /admin/weekly-challenge/ensure-current", () => {
    it("creates weekly challenge if none exists", async () => {
      await seedChallenge();
      const admin = await createAdmin("AdminPerson");

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.created, true);
      assert.ok(body.weeklyChallenge);
      assert.ok(body.weeklyChallenge.weekOf);
    });

    it("returns existing if already created (idempotent)", async () => {
      await seedChallenge();
      const admin = await createAdmin("AdminPerson");

      await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: admin.token });
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.created, false);
    });
  });

  // === POST /admin/weekly-challenge/resolve-current ===

  describe("POST /admin/weekly-challenge/resolve-current", () => {
    it("resolves active instances — winner has more steps and gets coins", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Initiate and accept stake
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
        body: { steps: 20000, date: today },
        token: alice.token,
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 5000, date: today },
        token: bob.token,
      });

      // Resolve
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.resolved, true);
      assert.equal(body.summary.resolvedInstances, 1);
      assert.equal(body.summary.skippedInstances, 0);

      // Winner (alice) should have more coins than loser
      const aliceMe = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
      const bobMe = await request(server.baseUrl, "GET", "/auth/me", { token: bob.token });
      const aliceCoins = (await aliceMe.json()).user.coins;
      const bobCoins = (await bobMe.json()).user.coins;
      assert.ok(aliceCoins > bobCoins, `winner coins (${aliceCoins}) should exceed loser coins (${bobCoins})`);
    });

    it("skips PENDING_STAKE instances — no winner, no coins", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Initiate but don't accept stake
      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.summary.skippedInstances, 1);
      assert.equal(body.summary.resolvedInstances, 0);

      const aliceMe = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
      assert.equal((await aliceMe.json()).user.coins, 0);
    });

    it("already-resolved week returns resolved: false (idempotent)", async () => {
      await seedChallenge();
      const admin = await createAdmin("AdminPerson");

      await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: admin.token });
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.resolved, false);
    });

    it("returns 404 if no weekly challenge exists", async () => {
      const admin = await createAdmin("AdminPerson");

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 404);
    });

    it("resolves with tied steps — winner is null or tiebreaker applies", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
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

      // Both record exact same steps
      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 7000, date: today },
        token: alice.token,
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 7000, date: today },
        token: bob.token,
      });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.summary.resolvedInstances, 1);
      // Should not crash — either a winner via tiebreaker or null winner
    });

    it("mixed instances — some active, some pending — handled correctly", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const charlie = await createUser("CharlieJoggs");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Challenge 1: active (stake accepted)
      const init1 = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const id1 = (await init1.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${id1}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      // Challenge 2: pending (no stake response)
      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: charlie.userId, stakeId: stake.id },
        token: alice.token,
      });

      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 10000, date: today },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.summary.totalInstances, 2);
      assert.equal(body.summary.resolvedInstances, 1);
      assert.equal(body.summary.skippedInstances, 1);
    });
  });

  // === POST /admin/weekly-challenge/reset-current ===

  describe("POST /admin/weekly-challenge/reset-current", () => {
    it("deletes all instances and clears resolvedAt", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: admin.token });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.reset, true);
      assert.equal(body.deletedInstances, 1);
      assert.equal(body.weeklyChallenge.resolvedAt, null);
    });

    it("after reset, new challenges can be created for same week", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Create and resolve
      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${instanceId}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });

      // Reset
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: admin.token });

      // Should be able to create new challenge between same pair
      const reInit = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      assert.equal(reInit.status, 201);
    });

    it("returns 404 if no weekly challenge exists", async () => {
      const admin = await createAdmin("AdminPerson");

      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: admin.token });
      assert.equal(res.status, 404);
    });

    it("reset after resolve then re-resolve works", async () => {
      await seedChallenge();
      const stake = await seedStake();
      const admin = await createAdmin("AdminPerson");
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      await makeFriends(alice, bob);

      // Create, accept, resolve
      const initRes = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const instanceId = (await initRes.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${instanceId}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });

      // Reset
      await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: admin.token });

      // Create new instance, accept, and re-resolve
      const init2 = await request(server.baseUrl, "POST", "/challenges/initiate", {
        body: { friendUserId: bob.userId, stakeId: stake.id },
        token: alice.token,
      });
      const id2 = (await init2.json()).instance.id;
      await request(server.baseUrl, "PUT", `/challenges/${id2}/respond-stake`, {
        body: { accept: true },
        token: bob.token,
      });

      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 15000, date: today },
        token: alice.token,
      });

      const resolveRes = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: admin.token });
      assert.equal(resolveRes.status, 200);

      const body = await resolveRes.json();
      assert.equal(body.resolved, true);
      assert.equal(body.summary.resolvedInstances, 1);
    });
  });
});
