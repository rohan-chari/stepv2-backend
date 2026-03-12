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

test("PUT /auth/me/step-goal sets the goal", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setStepGoal(payload) {
        receivedPayload = payload;
        return { id: "user-1", stepGoal: payload.stepGoal };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/step-goal`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stepGoal: 10000 }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.stepGoal, 10000);

    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      stepGoal: 10000,
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/step-goal clears goal with null", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setStepGoal(payload) {
        receivedPayload = payload;
        return { id: "user-1", stepGoal: null };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/step-goal`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stepGoal: null }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      stepGoal: null,
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/step-goal returns 400 when stepGoal missing from body", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/step-goal`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "stepGoal is required");
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/step-goal returns 400 for invalid values", async () => {
  const server = await startServer(authMocks());

  try {
    for (const stepGoal of [-5, 0, "abc", 3.5]) {
      const response = await fetch(`${server.baseUrl}/auth/me/step-goal`, {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stepGoal }),
      });

      assert.equal(response.status, 400, `Expected 400 for stepGoal=${JSON.stringify(stepGoal)}`);
      const body = await response.json();
      assert.equal(body.error, "stepGoal must be a positive integer or null");
    }
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/step-goal returns 401 without auth token", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/step-goal`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ stepGoal: 10000 }),
    });

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /auth/me includes stepGoal in user", async () => {
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
        stepGoal: 10000,
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
    assert.equal(body.user.stepGoal, 10000);
  } finally {
    await server.close();
  }
});
