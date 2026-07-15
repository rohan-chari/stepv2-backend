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
      next();
    },
    ...overrides,
  };
}

// A deferred that requestStepSyncForUsers resolves when it fires — lets a test
// await the fire-and-forget nudge without racing it.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Await a nudge, but fail (rather than hang the runner) if it never fires.
function withTimeout(promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("nudge was never fired")), ms)
    ),
  ]);
}

function get(baseUrl, raceId) {
  return fetch(`${baseUrl}/races/${raceId}`, {
    headers: { authorization: "Bearer x" },
  });
}

// A three-participant in-progress race detail: the viewer (user-1, ACCEPTED),
// two accepted rivals, plus a declined and a pending invitee that must be
// filtered out.
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

test("GET /races/:raceId nudges accepted rivals of an in-progress race, excluding the viewer", async () => {
  const fired = deferred();
  let receivedUserIds;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail();
      },
      async requestStepSyncForUsers(userIds) {
        receivedUserIds = userIds;
        fired.resolve();
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "race-1");

    await withTimeout(fired.promise);
    // Only ACCEPTED rivals, viewer excluded.
    assert.deepEqual([...receivedUserIds].sort(), ["user-2", "user-3"]);
  } finally {
    await server.close();
  }
});

test("GET /races/:raceId excludes declined and pending invitees from the nudge", async () => {
  const fired = deferred();
  let receivedUserIds;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail();
      },
      async requestStepSyncForUsers(userIds) {
        receivedUserIds = userIds;
        fired.resolve();
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    await withTimeout(fired.promise);
    assert.ok(!receivedUserIds.includes("user-4"), "declined excluded");
    assert.ok(!receivedUserIds.includes("user-5"), "pending excluded");
    assert.ok(!receivedUserIds.includes("user-1"), "viewer excluded");
  } finally {
    await server.close();
  }
});

test("GET /races/:raceId does NOT nudge for a completed race", async () => {
  let syncRequested = false;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail({
          status: "COMPLETED",
          completedAt: new Date().toISOString(),
        });
      },
      async requestStepSyncForUsers() {
        syncRequested = true;
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    // Give any (erroneously) scheduled fire-and-forget nudge a chance to run.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(syncRequested, false);
  } finally {
    await server.close();
  }
});

test("GET /races/:raceId does NOT nudge for a pending race", async () => {
  let syncRequested = false;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail({
          status: "PENDING",
          startedAt: null,
          endsAt: null,
        });
      },
      async requestStepSyncForUsers() {
        syncRequested = true;
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(syncRequested, false);
  } finally {
    await server.close();
  }
});

test("GET /races/:raceId does NOT nudge for an ACTIVE race already past endsAt", async () => {
  let syncRequested = false;

  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail({
          endsAt: new Date(Date.now() - 60 * 1000).toISOString(),
        });
      },
      async requestStepSyncForUsers() {
        syncRequested = true;
      },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(syncRequested, false);
  } finally {
    await server.close();
  }
});

test("GET /races/:raceId still returns 200 with the normal body when the push service rejects", async () => {
  const server = await startServer(
    depsWithStubAuth({
      async getRaceDetails() {
        return inProgressDetail();
      },
      async requestStepSyncForUsers() {
        throw new Error("push transport down");
      },
      // Swallow the expected error log so the test output stays clean.
      logger: { error() {} },
    })
  );

  try {
    const res = await get(server.baseUrl, "race-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "race-1");
    assert.equal(body.status, "ACTIVE");
    // Let the rejected fire-and-forget settle before tearing down.
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await server.close();
  }
});
