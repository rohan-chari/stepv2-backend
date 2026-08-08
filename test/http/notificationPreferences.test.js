const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    },
  };
}

// A User fake backing just the preference methods the router calls. requireAuth's
// other User methods are unused on the Apple-token path (and are typeof-guarded).
function prefUser(initial = true, milestoneInitial = true) {
  const store = { enabled: initial, milestoneEnabled: milestoneInitial };
  return {
    store,
    async getNotificationPreferences() {
      return {
        dailyRewardRemindersEnabled: store.enabled,
        stepMilestoneRemindersEnabled: store.milestoneEnabled,
      };
    },
    async setDailyRewardRemindersEnabled(id, value) {
      store.enabled = value;
      return { dailyRewardRemindersEnabled: store.enabled };
    },
    // Batch 2026-08-08 item 3 — additive second preference.
    async setStepMilestoneRemindersEnabled(id, value) {
      store.milestoneEnabled = value;
      return { stepMilestoneRemindersEnabled: store.milestoneEnabled };
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
      return { id: "user-1", appleId: "apple-user-123", displayName: "Walker" };
    },
    ...overrides,
  };
}

const AUTH = { authorization: "Bearer apple-token", "content-type": "application/json" };

test("GET /notifications/preferences returns the stored value (defaults true)", async () => {
  const server = await startServer(authMocks({ User: prefUser(true) }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      dailyRewardRemindersEnabled: true,
      stepMilestoneRemindersEnabled: true,
    });
  } finally {
    await server.close();
  }
});

test("GET /notifications/preferences requires auth (401)", async () => {
  const server = await startServer(authMocks({ User: prefUser(true) }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, {
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});

test("PATCH /notifications/preferences persists false and returns it", async () => {
  const user = prefUser(true);
  const server = await startServer(authMocks({ User: user }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ dailyRewardRemindersEnabled: false }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      dailyRewardRemindersEnabled: false,
      stepMilestoneRemindersEnabled: true,
    });
    assert.equal(user.store.enabled, false);
  } finally {
    await server.close();
  }
});

test("PATCH ignores unknown fields (echoes current value)", async () => {
  const user = prefUser(true);
  const server = await startServer(authMocks({ User: user }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ somethingElse: 5 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      dailyRewardRemindersEnabled: true,
      stepMilestoneRemindersEnabled: true,
    });
    assert.equal(user.store.enabled, true, "unchanged");
  } finally {
    await server.close();
  }
});

test("PATCH with a non-boolean field is 400", async () => {
  const server = await startServer(authMocks({ User: prefUser(true) }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ dailyRewardRemindersEnabled: "yes" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test("PATCH requires auth (401)", async () => {
  const server = await startServer(authMocks({ User: prefUser(true) }));
  try {
    const res = await fetch(`${server.baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyRewardRemindersEnabled: false }),
    });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});
