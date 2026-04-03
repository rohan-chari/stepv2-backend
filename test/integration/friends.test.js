const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

function authOverrides() {
  // Each call to POST /auth/apple will use the token's identity,
  // so we need a way to sign in as different users.
  // We'll create users directly in the DB and use session tokens.
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token, // use the token value as the apple ID
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-friend-test-${++nextAppleId}`;
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

describe("friend request flow", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === SEARCH ===

  it("search finds user by display name", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    const res = await request(server.baseUrl, "GET", "/friends/search?q=Alice", { token: bob.token });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.users.length, 1);
    assert.equal(body.users[0].id, alice.userId);
  });

  it("search does not return the searching user", async () => {
    const alice = await createUser("AliceWalker");

    const res = await request(server.baseUrl, "GET", "/friends/search?q=Alice", { token: alice.token });
    const body = await res.json();
    assert.equal(body.users.length, 0);
  });

  it("search does not return users without display names", async () => {
    await createUser(null); // user with no display name
    const bob = await createUser("BobRunner");

    const res = await request(server.baseUrl, "GET", "/friends/search?q=apple", { token: bob.token });
    const body = await res.json();
    assert.equal(body.users.length, 0);
  });

  // === SENDING REQUESTS ===

  it("send request → shows in sender's outgoing and recipient's incoming", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    assert.equal(sendRes.status, 201);

    // Check alice's view
    const aliceFriends = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    const aliceBody = await aliceFriends.json();
    assert.equal(aliceBody.pending.outgoing.length, 1);
    assert.equal(aliceBody.pending.outgoing[0].user.id, bob.userId);
    assert.equal(aliceBody.friends.length, 0);

    // Check bob's view
    const bobFriends = await request(server.baseUrl, "GET", "/friends", { token: bob.token });
    const bobBody = await bobFriends.json();
    assert.equal(bobBody.pending.incoming.length, 1);
    assert.equal(bobBody.pending.incoming[0].user.id, alice.userId);
    assert.equal(bobBody.friends.length, 0);
  });

  it("cannot send request without a display name", async () => {
    const noName = await createUser(null);
    const bob = await createUser("BobRunner");

    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: noName.token,
    });
    assert.equal(res.status, 403);
  });

  it("cannot send request to yourself", async () => {
    const alice = await createUser("AliceWalker");

    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: alice.userId },
      token: alice.token,
    });
    assert.equal(res.status, 409);
  });

  it("cannot send request to user without display name", async () => {
    const alice = await createUser("AliceWalker");
    const noName = await createUser(null);

    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: noName.userId },
      token: alice.token,
    });
    assert.equal(res.status, 409);
  });

  it("cannot send duplicate request", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });

    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    assert.equal(res.status, 409);
  });

  it("cannot send request to nonexistent user", async () => {
    const alice = await createUser("AliceWalker");

    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: "00000000-0000-0000-0000-000000000000" },
      token: alice.token,
    });
    assert.equal(res.status, 409);
  });

  // === ACCEPTING / DECLINING ===

  it("accept request → both appear in each other's friend list", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });

    // Get the friendship ID from bob's incoming
    const bobFriends = await request(server.baseUrl, "GET", "/friends", { token: bob.token });
    const friendshipId = (await bobFriends.json()).pending.incoming[0].friendshipId;

    const acceptRes = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: bob.token,
    });
    assert.equal(acceptRes.status, 200);

    // Both should see each other as friends now
    const aliceList = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    const aliceBody = await aliceList.json();
    assert.equal(aliceBody.friends.length, 1);
    assert.equal(aliceBody.friends[0].id, bob.userId);
    assert.equal(aliceBody.pending.outgoing.length, 0);

    const bobList = await request(server.baseUrl, "GET", "/friends", { token: bob.token });
    const bobBody = await bobList.json();
    assert.equal(bobBody.friends.length, 1);
    assert.equal(bobBody.friends[0].id, alice.userId);
    assert.equal(bobBody.pending.incoming.length, 0);
  });

  it("decline request → neither appears in friend list", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });

    const bobFriends = await request(server.baseUrl, "GET", "/friends", { token: bob.token });
    const friendshipId = (await bobFriends.json()).pending.incoming[0].friendshipId;

    const declineRes = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: false },
      token: bob.token,
    });
    assert.equal(declineRes.status, 200);

    const aliceList = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    const aliceBody = await aliceList.json();
    assert.equal(aliceBody.friends.length, 0);
    assert.equal(aliceBody.pending.outgoing.length, 0);
  });

  it("sender cannot accept their own outgoing request", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;

    const res = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: alice.token, // sender trying to accept
    });
    assert.equal(res.status, 409);
  });

  it("cannot respond to already accepted request", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;

    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: bob.token,
    });

    // Try to respond again
    const res = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: false },
      token: bob.token,
    });
    assert.equal(res.status, 409);
  });

  it("third party cannot respond to someone else's request", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");
    const charlie = await createUser("CharlieJoggs");

    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;

    const res = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: charlie.token, // charlie is not involved
    });
    assert.equal(res.status, 409);
  });

  // === AUTO-ACCEPT & RE-REQUEST ===

  it("mutual requests auto-accept: B requests A who already requested B", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Alice sends to Bob
    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });

    // Bob sends to Alice (should auto-accept)
    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: alice.userId },
      token: bob.token,
    });
    const body = await res.json();
    assert.equal(body.friendship.status, "ACCEPTED");

    // Verify both are friends
    const aliceList = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    assert.equal((await aliceList.json()).friends.length, 1);
  });

  it("re-request after decline resurrects as pending", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Send and decline
    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;

    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: false },
      token: bob.token,
    });

    // Alice re-requests
    const reRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    assert.equal(reRes.status, 201);

    const reBody = await reRes.json();
    assert.equal(reBody.friendship.status, "PENDING");
  });

  it("cannot re-request someone you are already friends with", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Become friends
    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: bob.token,
    });

    // Try to send again
    const res = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    assert.equal(res.status, 409);
  });

  // === REMOVING FRIENDS ===

  it("remove friend → both friend lists empty, can re-request after", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Become friends
    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: bob.token,
    });

    // Remove
    const removeRes = await request(server.baseUrl, "DELETE", `/friends/${friendshipId}`, {
      token: alice.token,
    });
    assert.equal(removeRes.status, 200);

    // Both empty
    const aliceList = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    assert.equal((await aliceList.json()).friends.length, 0);

    const bobList = await request(server.baseUrl, "GET", "/friends", { token: bob.token });
    assert.equal((await bobList.json()).friends.length, 0);

    // Can re-request
    const reRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    assert.equal(reRes.status, 201);
  });

  it("non-participant cannot remove a friendship", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");
    const charlie = await createUser("CharlieJoggs");

    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;

    const res = await request(server.baseUrl, "DELETE", `/friends/${friendshipId}`, {
      token: charlie.token,
    });
    assert.equal(res.status, 404);
  });

  // === FRIEND STEPS ===

  it("friend steps shows accepted friends with their step counts", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Become friends
    const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });
    const friendshipId = (await sendRes.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true },
      token: bob.token,
    });

    // Bob records steps
    const today = new Date().toISOString().slice(0, 10);
    await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 7500, date: today },
      token: bob.token,
    });

    // Alice checks friend steps
    const res = await request(server.baseUrl, "GET", `/friends/steps?date=${today}`, {
      token: alice.token,
    });
    const body = await res.json();
    assert.equal(body.friends.length, 1);
    assert.equal(body.friends[0].id, bob.userId);
    assert.equal(body.friends[0].steps, 7500);
  });

  it("pending friends do not appear in friend steps", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");

    // Send request but don't accept
    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: bob.userId },
      token: alice.token,
    });

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(server.baseUrl, "GET", `/friends/steps?date=${today}`, {
      token: alice.token,
    });
    const body = await res.json();
    assert.equal(body.friends.length, 0);
  });

  // === INCOMING REQUEST COUNT ===

  it("GET /auth/me reflects incoming friend request count", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobRunner");
    const charlie = await createUser("CharlieJoggs");

    // Two people send requests to alice
    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: alice.userId },
      token: bob.token,
    });
    await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: alice.userId },
      token: charlie.token,
    });

    const res = await request(server.baseUrl, "GET", "/auth/me", { token: alice.token });
    const body = await res.json();
    assert.equal(body.user.incomingFriendRequests, 2);
  });
});
