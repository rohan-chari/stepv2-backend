const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// T8 route: PUT /auth/me/leaderboard-visibility { hidden: <bool> } -> { user },
// and GET /auth/me must surface hiddenFromLeaderboard so clients can read state.

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
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
        hiddenFromLeaderboard: false,
      };
    },
    ...overrides,
  };
}

test("PUT /auth/me/leaderboard-visibility persists hidden=true and returns the user", async () => {
  let updateArgs;
  const server = await startServer(
    authMocks({
      User: {
        async update(id, fields) {
          updateArgs = { id, fields };
          return { id, hiddenFromLeaderboard: fields.hiddenFromLeaderboard };
        },
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/leaderboard-visibility`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hidden: true }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.hiddenFromLeaderboard, true);
    assert.deepEqual(updateArgs, {
      id: "user-1",
      fields: { hiddenFromLeaderboard: true },
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/leaderboard-visibility persists hidden=false", async () => {
  let updateArgs;
  const server = await startServer(
    authMocks({
      User: {
        async update(id, fields) {
          updateArgs = { id, fields };
          return { id, hiddenFromLeaderboard: fields.hiddenFromLeaderboard };
        },
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/leaderboard-visibility`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hidden: false }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.hiddenFromLeaderboard, false);
    assert.deepEqual(updateArgs.fields, { hiddenFromLeaderboard: false });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/leaderboard-visibility returns 400 for a non-boolean / missing hidden", async () => {
  let updateCalled = false;
  const server = await startServer(
    authMocks({
      User: {
        async update() {
          updateCalled = true;
          return {};
        },
      },
    })
  );

  try {
    for (const payload of [{}, { hidden: "true" }, { hidden: 1 }, { hidden: null }]) {
      const response = await fetch(`${server.baseUrl}/auth/me/leaderboard-visibility`, {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
    assert.equal(updateCalled, false, "must not persist on invalid input");
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/leaderboard-visibility returns 401 without auth", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/auth/me/leaderboard-visibility`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: true }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /auth/me includes hiddenFromLeaderboard", async () => {
  const server = await startServer(
    authMocks({
      async ensureAppleUser() {
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: "walker@example.com",
          hiddenFromLeaderboard: true,
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me`, {
      headers: { authorization: "Bearer apple-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.hiddenFromLeaderboard, true);
  } finally {
    await server.close();
  }
});

test("GET /auth/me defaults hiddenFromLeaderboard to false when absent", async () => {
  const server = await startServer(
    authMocks({
      async ensureAppleUser() {
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: "walker@example.com",
          // hiddenFromLeaderboard intentionally omitted (older row)
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me`, {
      headers: { authorization: "Bearer apple-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.hiddenFromLeaderboard, false);
  } finally {
    await server.close();
  }
});
