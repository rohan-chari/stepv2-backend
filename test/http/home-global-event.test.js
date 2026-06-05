const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// ---------------------------------------------------------------------------
// GET /home/race-card — additive top-level `globalEvent` field.
//
// The home card surfaces the currently-active GlobalStepEvent (if any) as a
// top-level field of the EXACT same shape getRaceProgress uses
// ({ active:true, multiplier, endsAt }) so the new app can render a "2x STEPS"
// banner. It's additive: when no event is active (or the lookup throws) the
// field is simply absent and the rest of the home card is unchanged, so older
// app builds that don't read it are unaffected.
//
// Written from the spec + the existing http test pattern, NOT by mirroring the
// route implementation.
// ---------------------------------------------------------------------------

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

async function getRaceCard(server) {
  return fetch(`${server.baseUrl}/home/race-card`, {
    method: "GET",
    headers: { authorization: "Bearer apple-token" },
  });
}

test("attaches globalEvent ({active,multiplier,endsAt}) when an event is active", async () => {
  const endsAt = new Date("2026-06-05T22:30:00Z");

  const server = await startServer(
    authMocks({
      async getHomeRaceCard() {
        return { state: "EMPTY", data: {} };
      },
      GlobalStepEvent: {
        async findActiveAt() {
          return { multiplier: 2, endsAt };
        },
      },
    })
  );

  try {
    const response = await getRaceCard(server);
    assert.equal(response.status, 200);
    const body = await response.json();

    // The base home card is untouched.
    assert.equal(body.state, "EMPTY");
    // Additive banner field, same shape as getRaceProgress.
    assert.deepEqual(body.globalEvent, {
      active: true,
      multiplier: 2,
      endsAt: endsAt.toISOString(),
    });
  } finally {
    await server.close();
  }
});

test("omits globalEvent when no event is active", async () => {
  const server = await startServer(
    authMocks({
      async getHomeRaceCard() {
        return { state: "EMPTY", data: {} };
      },
      GlobalStepEvent: {
        async findActiveAt() {
          return null;
        },
      },
    })
  );

  try {
    const response = await getRaceCard(server);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.state, "EMPTY");
    assert.equal("globalEvent" in body, false, "absent when no active event");
  } finally {
    await server.close();
  }
});

test("a DB hiccup in the event lookup never breaks the home card", async () => {
  const server = await startServer(
    authMocks({
      async getHomeRaceCard() {
        return { state: "EMPTY", data: {} };
      },
      GlobalStepEvent: {
        async findActiveAt() {
          throw new Error("db down");
        },
      },
    })
  );

  try {
    const response = await getRaceCard(server);
    // Home card still returns 200 with its normal payload; banner just omitted.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "EMPTY");
    assert.equal("globalEvent" in body, false);
  } finally {
    await server.close();
  }
});
