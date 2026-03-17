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

test("POST /notifications/device-token registers token", async () => {
  let savedArgs;

  const server = await startServer(
    authMocks({
      DeviceToken: {
        async saveToken(args) {
          savedArgs = args;
        },
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceToken: "abc123",
          platform: "ios",
        }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true });
    assert.deepEqual(savedArgs, {
      userId: "user-1",
      token: "abc123",
      platform: "ios",
    });
  } finally {
    await server.close();
  }
});

test("POST /notifications/device-token returns 400 without deviceToken", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ platform: "ios" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "deviceToken is required");
  } finally {
    await server.close();
  }
});

test("POST /notifications/device-token returns 400 without platform", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceToken: "abc123" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "platform must be 'ios' or 'android'");
  } finally {
    await server.close();
  }
});

test("POST /notifications/device-token returns 400 for invalid platform", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceToken: "abc123", platform: "web" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "platform must be 'ios' or 'android'");
  } finally {
    await server.close();
  }
});

test("POST /notifications/device-token returns 401 without auth", async () => {
  const server = await startServer();

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceToken: "abc123", platform: "ios" }),
      }
    );

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("DELETE /notifications/device-token removes token", async () => {
  let deletedArgs;

  const server = await startServer(
    authMocks({
      DeviceToken: {
        async deleteToken(args) {
          deletedArgs = args;
        },
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceToken: "abc123" }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true });
    assert.deepEqual(deletedArgs, {
      userId: "user-1",
      token: "abc123",
    });
  } finally {
    await server.close();
  }
});

test("DELETE /notifications/device-token returns 400 without deviceToken", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "deviceToken is required");
  } finally {
    await server.close();
  }
});

test("DELETE /notifications/device-token returns 401 without auth", async () => {
  const server = await startServer();

  try {
    const response = await fetch(
      `${server.baseUrl}/notifications/device-token`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceToken: "abc123" }),
      }
    );

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});
