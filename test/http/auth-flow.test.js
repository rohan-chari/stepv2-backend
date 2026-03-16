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

test("POST /auth/apple provisions the signed-in user", async () => {
  let receivedPayload;

  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");

      return {
        sub: "apple-user-123",
        email: "walker@example.com",
      };
    },
    async ensureAppleUser(payload) {
      receivedPayload = payload;

      return {
        id: "user-1",
        appleId: payload.appleId,
        email: payload.email,
        name: payload.name,
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/apple`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identityToken: "apple-token",
        name: "Rohan Chari",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.user, {
      id: "user-1",
      appleId: "apple-user-123",
      email: "walker@example.com",
      name: "Rohan Chari",
      isAdmin: false,
    });
    assert.equal(typeof body.sessionToken, "string");
    assert.ok(body.sessionToken.length > 0);

    assert.deepEqual(receivedPayload, {
      appleId: "apple-user-123",
      email: "walker@example.com",
      name: "Rohan Chari",
      emitSignInEvent: true,
    });
  } finally {
    await server.close();
  }
});

test("GET /auth/me returns the authenticated user", async () => {
  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");

      return {
        sub: "apple-user-123",
        email: "walker@example.com",
      };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
      };
    },
    isAdminUser() {
      return true;
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
    assert.equal(body.user.id, "user-1");
    assert.equal(body.user.appleId, "apple-user-123");
    assert.equal(body.user.email, "walker@example.com");
    assert.equal(body.user.isAdmin, true);
    assert.equal(typeof body.user.incomingFriendRequests, "number");
  } finally {
    await server.close();
  }
});

test("POST /steps records steps for the authenticated user instead of trusting client userId", async () => {
  let recordedPayload;

  const server = await startServer({
    async verifyAppleIdentityToken() {
      return {
        sub: "apple-user-123",
      };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
      };
    },
    async recordSteps(payload) {
      recordedPayload = payload;

      return {
        id: "step-1",
        ...payload,
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/steps`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "spoofed-user",
        steps: 8765,
        date: "2026-03-11",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      record: {
        id: "step-1",
        userId: "user-1",
        steps: 8765,
        date: "2026-03-11",
      },
    });

    assert.deepEqual(recordedPayload, {
      userId: "user-1",
      steps: 8765,
      date: "2026-03-11",
    });
  } finally {
    await server.close();
  }
});

test("GET /steps returns 401 without an auth token", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/steps`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Authorization bearer token is required",
    });
  } finally {
    await server.close();
  }
});
