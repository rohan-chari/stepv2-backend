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
        server.close((error) => (error ? reject(error) : resolve()));
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

test("DELETE /challenges/:instanceId cancels a challenge the user participates in", async () => {
  const deletedIds = [];
  const server = await startServer({
    ...authMocks(),
    ChallengeInstance: {
      async findById(id) {
        return {
          id,
          userAId: "user-1",
          userBId: "user-2",
          status: "PENDING_STAKE",
        };
      },
      async deleteById(id) {
        deletedIds.push(id);
      },
    },
  });

  try {
    const res = await fetch(`${server.baseUrl}/challenges/inst-1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer apple-token" },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(deletedIds, ["inst-1"]);
  } finally {
    await server.close();
  }
});

test("DELETE /challenges/:instanceId returns 404 for non-existent instance", async () => {
  const server = await startServer({
    ...authMocks(),
    ChallengeInstance: {
      async findById() {
        return null;
      },
    },
  });

  try {
    const res = await fetch(`${server.baseUrl}/challenges/no-such-id`, {
      method: "DELETE",
      headers: { Authorization: "Bearer apple-token" },
    });

    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test("DELETE /challenges/:instanceId returns 403 if user is not a participant", async () => {
  const server = await startServer({
    ...authMocks(),
    ChallengeInstance: {
      async findById(id) {
        return {
          id,
          userAId: "other-user-a",
          userBId: "other-user-b",
          status: "ACTIVE",
        };
      },
    },
  });

  try {
    const res = await fetch(`${server.baseUrl}/challenges/inst-1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer apple-token" },
    });

    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test("DELETE /challenges/:instanceId works for userB too", async () => {
  const deletedIds = [];
  const server = await startServer({
    ...authMocks(),
    ChallengeInstance: {
      async findById(id) {
        return {
          id,
          userAId: "user-2",
          userBId: "user-1", // current user is userB
          status: "ACTIVE",
        };
      },
      async deleteById(id) {
        deletedIds.push(id);
      },
    },
  });

  try {
    const res = await fetch(`${server.baseUrl}/challenges/inst-2`, {
      method: "DELETE",
      headers: { Authorization: "Bearer apple-token" },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deletedIds, ["inst-2"]);
  } finally {
    await server.close();
  }
});
