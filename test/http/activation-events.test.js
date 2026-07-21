const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createApp } = require("../../src/app");

async function startServer(overrides = {}) {
  const insertedIds = new Set();
  const writes = [];
  const app = createApp({
    requireAuth(req, _res, next) {
      req.user = { id: "server-user" };
      next();
    },
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    prisma: {
      activationEvent: {
        async createMany({ data }) {
          writes.push(data);
          let count = 0;
          for (const event of data) {
            if (!insertedIds.has(event.id)) {
              insertedIds.add(event.id);
              count += 1;
            }
          }
          return { count };
        },
      },
    },
    ...overrides,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    writes,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const validEvent = {
  id: "device-event-1",
  onboardingSessionId: "session-1",
  name: "daily_opened",
  context: { source: "onboarding", race_state: "active" },
  appVersion: "2.0.0+42",
  platform: "ios",
  timestamp: "2026-07-20T11:59:00.000Z",
};

test("activation batch derives user ID and deduplicates client event IDs", async () => {
  const server = await startServer();
  try {
    for (const inserted of [1, 0]) {
      const response = await fetch(`${server.baseUrl}/analytics/activation-events`, {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ events: [validEvent] }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: 1, inserted });
    }
    assert.equal(server.writes[0][0].userId, "server-user");
    assert.equal(server.writes[0][0].occurredAt.toISOString(), validEvent.timestamp);
  } finally {
    await server.close();
  }
});

test("activation context rejects private or free-form fields", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/analytics/activation-events`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ ...validEvent, context: { raceId: "secret-race-id" } }],
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not allowed/);
    assert.equal(server.writes.length, 0);
  } finally {
    await server.close();
  }
});

test("activation batches are capped at 50", async () => {
  const server = await startServer();
  try {
    const events = Array.from({ length: 51 }, (_, index) => ({
      ...validEvent,
      id: `event-${index}`,
    }));
    const response = await fetch(`${server.baseUrl}/analytics/activation-events`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});
