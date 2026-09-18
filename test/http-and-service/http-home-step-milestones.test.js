const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// ---------------------------------------------------------------------------
// GET /home/race-card — additive top-level `stepMilestones` field.
//
// The claim-rewards card used to be the only home widget fed by its own
// request (GET /users/me/step-milestones/today), which made it pop in last on
// slow connections. New app builds pass `localDate=YYYY-MM-DD` on the
// race-card request and read `stepMilestones` (the EXACT shape the standalone
// endpoint returns) from the same response. Additive: old builds don't send
// localDate and the field is absent; the standalone endpoint stays for them.
// A milestone lookup failure never breaks the home card — the field is just
// omitted and the app falls back to the standalone fetch.
//
// Written from the spec + the home-global-event.test.js pattern.
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
    async getHomeRaceCard() {
      return { state: "EMPTY", data: {} };
    },
    GlobalStepEvent: {
      async findActiveAt() {
        return null;
      },
    },
    ...overrides,
  };
}

async function getRaceCard(server, query = "") {
  return fetch(`${server.baseUrl}/home/race-card${query}`, {
    method: "GET",
    headers: { authorization: "Bearer apple-token" },
  });
}

const MILESTONES_FIXTURE = {
  localDate: "2026-07-01",
  currentSteps: 6200,
  milestones: [
    { threshold: 5000, coins: 10, currentSteps: 6200, claimed: false, claimable: true },
  ],
  totalCoinsClaimed: 0,
};

test("attaches stepMilestones when the client passes localDate", async () => {
  const calls = [];
  const server = await startServer(
    authMocks({
      async getStepMilestonesToday(args) {
        calls.push(args);
        return MILESTONES_FIXTURE;
      },
    })
  );

  try {
    const response = await getRaceCard(server, "?localDate=2026-07-01");
    assert.equal(response.status, 200);
    const body = await response.json();

    // The base home card is untouched.
    assert.equal(body.state, "EMPTY");
    // Same shape as GET /users/me/step-milestones/today.
    assert.deepEqual(body.stepMilestones, MILESTONES_FIXTURE);
    // The query ran for this user + the client's local date.
    assert.deepEqual(calls, [{ userId: "user-1", localDate: "2026-07-01" }]);
  } finally {
    await server.close();
  }
});

test("omits stepMilestones when the client does not send localDate (old builds)", async () => {
  const server = await startServer(
    authMocks({
      async getStepMilestonesToday() {
        throw new Error("must not be called without localDate");
      },
    })
  );

  try {
    const response = await getRaceCard(server);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "EMPTY");
    assert.equal("stepMilestones" in body, false);
  } finally {
    await server.close();
  }
});

test("a milestone lookup failure never breaks the home card", async () => {
  const server = await startServer(
    authMocks({
      async getStepMilestonesToday() {
        throw new Error("db down");
      },
    })
  );

  try {
    const response = await getRaceCard(server, "?localDate=2026-07-01");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "EMPTY");
    assert.equal("stepMilestones" in body, false, "field omitted on failure");
  } finally {
    await server.close();
  }
});
