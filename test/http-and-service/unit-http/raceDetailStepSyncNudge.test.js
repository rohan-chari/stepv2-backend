const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

// Bypass auth: requireAuth is injectable on the router via dependencies.
function depsWithStubAuth(overrides = {}) {
  return {
    requireAuth(req, _res, next) {
      req.user = { id: "user-1", appleId: "apple-sub-1", displayName: "Me" };
      req.clientFeatures = new Set(["seeded_race_buckets"]);
      next();
    },
    ...overrides,
  };
}

function get(baseUrl, raceId) {
  return fetch(`${baseUrl}/races/${raceId}`, {
    headers: { authorization: "Bearer x" },
  });
}

// A three-participant in-progress race detail. Opening any race must remain a
// read-only operation: normal device/background syncing owns freshness, rather
// than one viewer creating a fan-out of rival sync requests.
function inProgressDetail(overrides = {}) {
  return {
    id: "race-1",
    status: "ACTIVE",
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    completedAt: null,
    participants: [
      { userId: "user-1", status: "ACCEPTED" },
      { userId: "user-2", status: "ACCEPTED" },
      { userId: "user-3", status: "ACCEPTED" },
      { userId: "user-4", status: "DECLINED" },
      { userId: "user-5", status: "PENDING" },
    ],
    ...overrides,
  };
}

test("GET /races/:raceId does not request step syncs when an active race is opened", async () => {
  let syncRequested = false;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail();
      },
      async requestStepSyncForUsers() {
        syncRequested = true;
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "race-1");

    // Give any erroneously scheduled post-response work a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(syncRequested, false);
  } finally {
    await server.close();
  }
});
