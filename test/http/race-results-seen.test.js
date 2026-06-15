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
      req.user = { id: "user-1", appleId: "apple-sub-1" };
      next();
    },
    ...overrides,
  };
}

function post(baseUrl, body) {
  return fetch(`${baseUrl}/races/results/seen`, {
    method: "POST",
    headers: {
      authorization: "Bearer x",
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /races/results/seen acks the caller's races", async () => {
  const calls = [];
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async (args) => {
        calls.push(args);
        return { count: args.raceIds.length };
      },
    })
  );

  try {
    const res = await post(server.baseUrl, { raceIds: ["race-1", "race-2"] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, "user-1");
    assert.deepEqual(calls[0].raceIds, ["race-1", "race-2"]);
  } finally {
    await server.close();
  }
});

test("POST /races/results/seen is idempotent (second call also OK)", async () => {
  let count = 0;
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async () => {
        count += 1;
        return { count: 1 };
      },
    })
  );

  try {
    const first = await post(server.baseUrl, { raceIds: ["race-1"] });
    const second = await post(server.baseUrl, { raceIds: ["race-1"] });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).success, true);
    assert.equal(count, 2);
  } finally {
    await server.close();
  }
});

test("POST /races/results/seen rejects empty body", async () => {
  let called = false;
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async () => {
        called = true;
        return { count: 0 };
      },
    })
  );

  try {
    const res = await post(server.baseUrl, "{}");
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test("POST /races/results/seen rejects empty array", async () => {
  let called = false;
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async () => {
        called = true;
        return { count: 0 };
      },
    })
  );

  try {
    const res = await post(server.baseUrl, { raceIds: [] });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test("POST /races/results/seen rejects non-string entries", async () => {
  let called = false;
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async () => {
        called = true;
        return { count: 0 };
      },
    })
  );

  try {
    const res = await post(server.baseUrl, { raceIds: ["race-1", 42] });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test("POST /races/results/seen surfaces command validation errors", async () => {
  const { MarkRaceResultsSeenError } = require("../../src/commands/markRaceResultsSeen");
  const server = await startServer(
    depsWithStubAuth({
      markRaceResultsSeen: async () => {
        throw new MarkRaceResultsSeenError("boom", 400);
      },
    })
  );

  try {
    const res = await post(server.baseUrl, { raceIds: ["race-1"] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "boom");
  } finally {
    await server.close();
  }
});
