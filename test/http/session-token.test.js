const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");
const { signSessionToken } = require("../../src/services/sessionToken");

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

test("POST /auth/apple returns a sessionToken alongside user", async () => {
  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      return { sub: "apple-user-123", email: "walker@example.com" };
    },
    async ensureAppleUser(payload) {
      return {
        id: "user-1",
        appleId: payload.appleId,
        email: payload.email,
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/apple`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: "apple-token" }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, "user-1");
    assert.equal(typeof body.sessionToken, "string");
    assert.ok(body.sessionToken.length > 0);
  } finally {
    await server.close();
  }
});

test("API calls work with session token", async () => {
  const sessionToken = signSessionToken({
    userId: "user-1",
    appleId: "apple-user-123",
  });

  const server = await startServer({
    User: {
      async findById(id) {
        if (id === "user-1") {
          return {
            id: "user-1",
            appleId: "apple-user-123",
            email: "walker@example.com",
          };
        }
        return null;
      },
    },
    async getStepsByDate() {
      return { id: "step-1", steps: 5000, date: "2026-03-16" };
    },
    async getStepsHistory() {
      return [];
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/steps?date=2026-03-16`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.record, {
      id: "step-1",
      steps: 5000,
      date: "2026-03-16",
    });
  } finally {
    await server.close();
  }
});

test("returns 401 for expired session token", async () => {
  // Create a token that's already expired by manipulating jwt directly
  const jwt = require("jsonwebtoken");
  const secret = process.env.SESSION_TOKEN_SECRET || "dev-secret-change-in-production";
  const expiredToken = jwt.sign(
    { appleId: "apple-user-123" },
    secret,
    {
      subject: "user-1",
      issuer: "steps-tracker-api",
      expiresIn: "-1s",
      algorithm: "HS256",
    }
  );

  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/steps`, {
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, "Session token has expired");
  } finally {
    await server.close();
  }
});

test("returns 401 for tampered session token", async () => {
  const token = signSessionToken({
    userId: "user-1",
    appleId: "apple-user-123",
  });
  const tampered = token.slice(0, -5) + "XXXXX";

  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/steps`, {
      headers: { authorization: `Bearer ${tampered}` },
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, "Session token is invalid");
  } finally {
    await server.close();
  }
});

test("GET /auth/session returns fresh session token", async () => {
  const sessionToken = signSessionToken({
    userId: "user-1",
    appleId: "apple-user-123",
  });

  const server = await startServer({
    User: {
      async findById(id) {
        if (id === "user-1") {
          return {
            id: "user-1",
            appleId: "apple-user-123",
            email: "walker@example.com",
          };
        }
        return null;
      },
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.sessionToken, "string");
    assert.ok(body.sessionToken.length > 0);
    assert.equal(body.user.id, "user-1");
  } finally {
    await server.close();
  }
});

test("backward compatibility: Apple identity tokens still work for API calls", async () => {
  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "valid-apple-token");
      return { sub: "apple-user-123", email: "walker@example.com" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
      };
    },
    async getStepsByDate() {
      return { id: "step-1", steps: 3000, date: "2026-03-16" };
    },
    async getStepsHistory() {
      return [];
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/steps?date=2026-03-16`, {
      headers: { authorization: "Bearer valid-apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.record.steps, 3000);
  } finally {
    await server.close();
  }
});
