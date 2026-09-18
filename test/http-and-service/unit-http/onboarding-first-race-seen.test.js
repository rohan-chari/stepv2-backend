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

test("POST /races/onboarding/first-race-seen marks the flag", async () => {
  const updates = [];
  const server = await startServer(
    depsWithStubAuth({
      User: {
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
      },
    })
  );

  try {
    const res = await fetch(
      `${server.baseUrl}/races/onboarding/first-race-seen`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer x",
          "content-type": "application/json",
        },
        body: "{}",
      }
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "user-1");
    assert.equal(updates[0].fields.firstRaceOnboardingSeen, true);
  } finally {
    await server.close();
  }
});

test("POST /races/onboarding/first-race-seen is idempotent (second call also OK)", async () => {
  const server = await startServer(
    depsWithStubAuth({
      User: {
        async update(id, fields) {
          return { id, ...fields };
        },
      },
    })
  );

  try {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(
        `${server.baseUrl}/races/onboarding/first-race-seen`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer x",
            "content-type": "application/json",
          },
          body: "{}",
        }
      );
      assert.equal(res.status, 200);
    }
  } finally {
    await server.close();
  }
});
