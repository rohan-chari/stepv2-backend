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

// 5.1 — Relationship type required on accept
test("PUT /friends/request/:id requires relationshipType when accepting", async () => {
  const server = await startServer(
    authMocks({
      async respondToFriendRequest(payload) {
        if (!payload.relationshipType) {
          const error = new Error("relationshipType is required when accepting a friend request");
          error.name = "ValidationError";
          throw error;
        }
        return {
          id: "f-1",
          status: "ACCEPTED",
          relationshipType: payload.relationshipType,
        };
      },
    })
  );

  try {
    // Accept without relationshipType → 400
    const badResponse = await fetch(
      `${server.baseUrl}/friends/request/f-1`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true }),
      }
    );
    assert.equal(badResponse.status, 400);
    const badBody = await badResponse.json();
    assert.match(badBody.error, /relationshipType/);

    // Accept with relationshipType → 200
    const goodResponse = await fetch(
      `${server.baseUrl}/friends/request/f-1`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true, relationshipType: "partner" }),
      }
    );
    assert.equal(goodResponse.status, 200);
    const goodBody = await goodResponse.json();
    assert.equal(goodBody.friendship.status, "ACCEPTED");
    assert.equal(goodBody.friendship.relationshipType, "partner");
  } finally {
    await server.close();
  }
});

// 5.2 — Relationship type can be updated
test("PUT /friends/:friendshipId/relationship-type updates the relationship type", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async updateRelationshipType(payload) {
        receivedPayload = payload;
        return {
          id: "f-1",
          requesterId: "user-1",
          addresseeId: "user-2",
          status: "ACCEPTED",
          relationshipType: "family",
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/friends/f-1/relationship-type`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ relationshipType: "family" }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friendship.relationshipType, "family");
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      friendshipId: "f-1",
      relationshipType: "family",
    });
  } finally {
    await server.close();
  }
});

// 5.3 — Invalid relationship type rejected
test("PUT /friends/:friendshipId/relationship-type returns 400 for invalid type", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/friends/f-1/relationship-type`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ relationshipType: "coworker" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /invalid|must be one of/i);
  } finally {
    await server.close();
  }
});

// 5.6 — Last-write-wins for relationship type
test("Relationship type uses last-write-wins: User B can overwrite User A's choice", async () => {
  let currentType = "partner"; // User A set it to partner

  const server = await startServer(
    authMocks({
      async ensureAppleUser() {
        return {
          id: "user-2", // User B
          appleId: "apple-user-b",
          displayName: "User B",
        };
      },
      async updateRelationshipType(payload) {
        currentType = payload.relationshipType;
        return {
          id: "f-1",
          requesterId: "user-1",
          addresseeId: "user-2",
          status: "ACCEPTED",
          relationshipType: currentType,
        };
      },
    })
  );

  try {
    // User B updates to "friend", overwriting User A's "partner"
    const response = await fetch(
      `${server.baseUrl}/friends/f-1/relationship-type`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ relationshipType: "friend" }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.friendship.relationshipType, "friend");
    assert.equal(currentType, "friend");
  } finally {
    await server.close();
  }
});
