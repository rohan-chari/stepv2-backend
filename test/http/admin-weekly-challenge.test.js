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
      return { sub: "apple-user-123", email: "walker@example.com" };
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

test("admin weekly challenge endpoints return 403 for non-admin users", async () => {
  const server = await startServer(
    authMocks({
      isAdminUser() {
        return false;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/admin/weekly-challenge`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Admin access is required",
    });
  } finally {
    await server.close();
  }
});

test("GET /admin/weekly-challenge returns the current weekly state for admins", async () => {
  const server = await startServer(
    authMocks({
      isAdminUser() {
        return true;
      },
      async getWeeklyChallengeAdminState() {
        return {
          weeklyChallenge: {
            id: "weekly-1",
            weekOf: "2026-03-16",
            resolvedAt: null,
            challenge: {
              id: "challenge-1",
              title: "Beat Your Partner",
            },
          },
          instances: [{ id: "instance-1", status: "ACTIVE" }],
          instanceCounts: {
            total: 1,
            pendingStake: 0,
            active: 1,
            completed: 0,
          },
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/admin/weekly-challenge`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.weeklyChallenge.id, "weekly-1");
    assert.equal(body.instanceCounts.active, 1);
    assert.equal(body.instances.length, 1);
  } finally {
    await server.close();
  }
});

test("POST /admin/weekly-challenge/ensure-current triggers a weekly challenge drop for admins", async () => {
  const server = await startServer(
    authMocks({
      isAdminUser() {
        return true;
      },
      async ensureWeeklyChallengeForDate() {
        return {
          created: true,
          weeklyChallenge: {
            id: "weekly-1",
            weekOf: "2026-03-16",
            challenge: {
              id: "challenge-1",
              title: "Beat Your Partner",
            },
          },
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/admin/weekly-challenge/ensure-current`,
      {
        method: "POST",
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.created, true);
    assert.equal(body.weeklyChallenge.challenge.id, "challenge-1");
  } finally {
    await server.close();
  }
});

test("POST /admin/weekly-challenge/resolve-current resolves the current week for admins", async () => {
  const server = await startServer(
    authMocks({
      isAdminUser() {
        return true;
      },
      async resolveWeeklyChallengeForDate() {
        return {
          resolved: true,
          summary: { resolvedInstances: 2 },
          weeklyChallenge: {
            id: "weekly-1",
            weekOf: "2026-03-16",
            resolvedAt: "2026-03-23T03:59:00.000Z",
            challenge: {
              id: "challenge-1",
              title: "Beat Your Partner",
            },
          },
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/admin/weekly-challenge/resolve-current`,
      {
        method: "POST",
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resolved, true);
    assert.equal(body.summary.resolvedInstances, 2);
  } finally {
    await server.close();
  }
});

test("POST /admin/weekly-challenge/reset-current resets the current week for admins", async () => {
  const server = await startServer(
    authMocks({
      isAdminUser() {
        return true;
      },
      async resetWeeklyChallengeForDate() {
        return {
          reset: true,
          deletedInstances: 2,
          weeklyChallenge: {
            id: "weekly-1",
            weekOf: "2026-03-16",
            resolvedAt: null,
            challenge: {
              id: "challenge-1",
              title: "Beat Your Partner",
            },
          },
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/admin/weekly-challenge/reset-current`,
      {
        method: "POST",
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reset, true);
    assert.equal(body.deletedInstances, 2);
    assert.equal(body.weeklyChallenge.resolvedAt, null);
  } finally {
    await server.close();
  }
});
