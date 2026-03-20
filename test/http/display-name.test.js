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
      };
    },
    ...overrides,
  };
}

test("PUT /auth/me/display-name sets the display name", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setDisplayName(payload) {
        receivedPayload = payload;
        return { id: "user-1", displayName: payload.displayName };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Trail Walker" }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.displayName, "Trail Walker");

    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      displayName: "Trail Walker",
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name clears with null", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setDisplayName(payload) {
        receivedPayload = payload;
        return { id: "user-1", displayName: null };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: null }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      displayName: null,
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name returns 400 when displayName missing from body", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "displayName is required");
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name returns 400 for invalid values", async () => {
  const server = await startServer(authMocks());

  try {
    for (const displayName of ["", "   ", 123]) {
      const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ displayName }),
      });

      assert.equal(response.status, 400, `Expected 400 for displayName=${JSON.stringify(displayName)}`);
      const body = await response.json();
      assert.equal(body.error, "displayName must be a non-empty string or null");
    }
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name returns 400 when too short", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Short" }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /at least 8 characters/);
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name returns 401 without auth token", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Trail Walker" }),
    });

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /auth/me includes displayName in user", async () => {
  const server = await startServer({
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
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/me`, {
      headers: {
        authorization: "Bearer apple-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.displayName, "Trail Walker");
  } finally {
    await server.close();
  }
});

test("GET /auth/me includes incomingFriendRequests count", async () => {
  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");
      return { sub: "apple-user-123" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
      };
    },
    async getIncomingFriendRequestCount(userId) {
      assert.equal(userId, "user-1");
      return 3;
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/me`, {
      headers: {
        authorization: "Bearer apple-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.incomingFriendRequests, 3);
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name returns 409 when display name is already taken", async () => {
  const error = new Error("That display name is already taken");
  error.name = "DisplayNameTakenError";

  const server = await startServer(
    authMocks({
      async setDisplayName() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Trail Walker" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /already taken/);
  } finally {
    await server.close();
  }
});

test("GET /auth/check-display-name returns available true when name is free", async () => {
  const server = await startServer(
    authMocks({
      User: {
        async findByDisplayNameInsensitive() {
          return null;
        },
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/auth/check-display-name?name=FreshName`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, true);
  } finally {
    await server.close();
  }
});

test("GET /auth/check-display-name returns available false when name is taken", async () => {
  const server = await startServer(
    authMocks({
      User: {
        async findByDisplayNameInsensitive() {
          return { id: "user-2", displayName: "TakenName" };
        },
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/auth/check-display-name?name=TakenName`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, false);
  } finally {
    await server.close();
  }
});

test("GET /auth/check-display-name returns unavailable for short names", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/auth/check-display-name?name=Short`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /at least 8 characters/);
  } finally {
    await server.close();
  }
});

test("GET /auth/check-display-name returns 400 without name param", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/auth/check-display-name`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/display-name trims whitespace", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setDisplayName(payload) {
        receivedPayload = payload;
        return { id: "user-1", displayName: payload.displayName };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/display-name`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "  Trail Walker  " }),
    });

    assert.equal(response.status, 200);
    assert.equal(receivedPayload.displayName, "Trail Walker");
  } finally {
    await server.close();
  }
});
