const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function authMocks(overrides = {}) {
  return {
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");
      return { sub: "apple-user-123" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
        displayName: "Trail Walker",
      };
    },
    ...overrides,
  };
}

test("GET /friends returns friends and pending requests", async () => {
  const server = await startServer(
    authMocks({
      async getFriendsList() {
        return [{ id: "user-2", displayName: "Trail Buddy" }];
      },
      async getPendingRequests() {
        return {
          incoming: [{ friendshipId: "f-1", user: { id: "user-3", displayName: "Hiker" } }],
          outgoing: [{ friendshipId: "f-2", user: { id: "user-4", displayName: "Walker" } }],
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friends.length, 1);
    assert.equal(body.friends[0].displayName, "Trail Buddy");
    assert.equal(body.pending.incoming.length, 1);
    assert.equal(body.pending.outgoing.length, 1);
  } finally {
    await server.close();
  }
});

test("GET /friends/search?q=trail returns matching users", async () => {
  const server = await startServer(
    authMocks({
      async searchUsersByDisplayName(query, excludeUserId) {
        assert.equal(query, "trail");
        assert.equal(excludeUserId, "user-1");
        return [{ id: "user-2", displayName: "Trail Buddy" }];
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/search?q=trail`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.users.length, 1);
    assert.equal(body.users[0].displayName, "Trail Buddy");
  } finally {
    await server.close();
  }
});

test("GET /friends/search without query returns 400", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/friends/search`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "Search query is required");
  } finally {
    await server.close();
  }
});

test("POST /friends/request creates a friend request", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async sendFriendRequest(payload) {
        receivedPayload = payload;
        return { id: "f-1", requesterId: "user-1", addresseeId: "user-2", status: "PENDING" };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ addresseeId: "user-2" }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.friendship.status, "PENDING");
    assert.deepEqual(receivedPayload, { userId: "user-1", addresseeId: "user-2" });
  } finally {
    await server.close();
  }
});

test("POST /friends/request auto-accepts when other user has a pending request", async () => {
  const server = await startServer(
    authMocks({
      async sendFriendRequest(payload) {
        assert.deepEqual(payload, { userId: "user-1", addresseeId: "user-2" });
        return { id: "f-1", requesterId: "user-2", addresseeId: "user-1", status: "ACCEPTED" };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ addresseeId: "user-2" }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.friendship.status, "ACCEPTED");
  } finally {
    await server.close();
  }
});

test("POST /friends/request returns 409 for duplicate", async () => {
  const error = new Error("A friend request already exists");
  error.name = "FriendRequestError";

  const server = await startServer(
    authMocks({
      async sendFriendRequest() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ addresseeId: "user-2" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /already exists/);
  } finally {
    await server.close();
  }
});

test("POST /friends/request returns 400 without addresseeId", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "addresseeId is required");
  } finally {
    await server.close();
  }
});

test("PUT /friends/request/:id accepts a friend request", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async respondToFriendRequest(payload) {
        receivedPayload = payload;
        return { id: "f-1", status: "ACCEPTED" };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request/f-1`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ accept: true }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friendship.status, "ACCEPTED");
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      friendshipId: "f-1",
      accept: true,
    });
  } finally {
    await server.close();
  }
});

test("PUT /friends/request/:id declines a friend request", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async respondToFriendRequest(payload) {
        receivedPayload = payload;
        return { id: "f-1", status: "DECLINED" };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request/f-1`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ accept: false }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friendship.status, "DECLINED");
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      friendshipId: "f-1",
      accept: false,
    });
  } finally {
    await server.close();
  }
});

test("PUT /friends/request/:id returns 409 for wrong user", async () => {
  const error = new Error("You are not the recipient of this request");
  error.name = "FriendResponseError";

  const server = await startServer(
    authMocks({
      async respondToFriendRequest() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request/f-1`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ accept: true }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /not the recipient/);
  } finally {
    await server.close();
  }
});

test("GET /friends/steps returns friends with today's steps and goal", async () => {
  const server = await startServer(
    authMocks({
      async getFriendsWithSteps(userId, date) {
        assert.equal(userId, "user-1");
        assert.equal(date, "2026-03-12");
        return [
          { id: "user-2", displayName: "Trail Buddy", steps: 8500, stepGoal: 10000 },
          { id: "user-3", displayName: "Hiker", steps: 0, stepGoal: null },
        ];
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/steps?date=2026-03-12`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friends.length, 2);
    assert.equal(body.friends[0].displayName, "Trail Buddy");
    assert.equal(body.friends[0].steps, 8500);
    assert.equal(body.friends[0].stepGoal, 10000);
    assert.equal(body.friends[1].steps, 0);
    assert.equal(body.friends[1].stepGoal, null);
  } finally {
    await server.close();
  }
});

test("GET /friends/steps requests background sync for today's friend ids", async () => {
  let receivedUserIds;

  const server = await startServer(
    authMocks({
      async getFriendsWithSteps() {
        return [
          { id: "user-2", displayName: "Trail Buddy", steps: 8500, stepGoal: 10000 },
          { id: "user-3", displayName: "Hiker", steps: 0, stepGoal: null },
        ];
      },
      async requestStepSyncForUsers(userIds) {
        receivedUserIds = userIds;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/steps`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(receivedUserIds, ["user-2", "user-3"]);
  } finally {
    await server.close();
  }
});

test("GET /friends/steps does not request background sync for historical dates", async () => {
  let syncRequested = false;

  const server = await startServer(
    authMocks({
      async getFriendsWithSteps() {
        return [{ id: "user-2", displayName: "Trail Buddy", steps: 8500, stepGoal: 10000 }];
      },
      async requestStepSyncForUsers() {
        syncRequested = true;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/steps?date=2026-03-12`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    assert.equal(syncRequested, false);
  } finally {
    await server.close();
  }
});

test("GET /friends/steps defaults to today when no date param", async () => {
  let receivedDate;

  const server = await startServer(
    authMocks({
      async getFriendsWithSteps(userId, date) {
        receivedDate = date;
        return [];
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/steps`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.friends, []);

    // Should default to today's date
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(receivedDate, today);
  } finally {
    await server.close();
  }
});

test("GET /friends/steps does not return non-friends", async () => {
  const server = await startServer(
    authMocks({
      async getFriendsWithSteps(userId) {
        assert.equal(userId, "user-1");
        // Only accepted friends are returned — user-5 is not a friend
        return [
          { id: "user-2", displayName: "Trail Buddy", steps: 5000, stepGoal: 10000 },
        ];
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/steps?date=2026-03-12`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friends.length, 1);

    const ids = body.friends.map((f) => f.id);
    assert.ok(!ids.includes("user-5"), "Non-friend should not appear in results");
  } finally {
    await server.close();
  }
});

test("POST /friends/request returns 403 when sender has no display name", async () => {
  const server = await startServer(
    authMocks({
      async ensureAppleUser() {
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: "walker@example.com",
          displayName: null,
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ addresseeId: "user-2" }),
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /display name/);
  } finally {
    await server.close();
  }
});

test("POST /friends/request returns 409 when addressee has no display name", async () => {
  const error = new Error(
    "Cannot send a friend request to a user without a display name"
  );
  error.name = "FriendRequestError";

  const server = await startServer(
    authMocks({
      async ensureAppleUser() {
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: "walker@example.com",
          displayName: "Trail Walker",
        };
      },
      async sendFriendRequest() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/friends/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ addresseeId: "user-no-name" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /display name/);
  } finally {
    await server.close();
  }
});

test("GET /friends returns 401 without auth", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/friends`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Authorization bearer token is required",
    });
  } finally {
    await server.close();
  }
});
