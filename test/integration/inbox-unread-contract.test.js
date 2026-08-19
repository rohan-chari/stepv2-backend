const assert = require("node:assert/strict");
const { afterEach, before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const INBOX_FEATURES = { "X-Client-Features": "inbox_v1" };

let server;

async function createAlert(userId, overrides = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.inboxAlert.create({
    data: {
      userId,
      type: "SYSTEM",
      title: "Inbox contract alert",
      body: "An integration-test alert.",
      sourceKey: `inbox-contract:${suffix}`,
      destination: { route: "home" },
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    },
  });
}

async function createUnreadSupportThread(baseUrl, token, userId) {
  const response = await request(baseUrl, "POST", "/feedback/suggestions", {
    token,
    body: { text: "Please help with this Inbox contract test." },
  });
  assert.equal(response.status, 201);
  return prisma.feedbackThread.findFirstOrThrow({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

describe("Inbox unread-count additive contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("apiInboxV1Enabled", true);
  });

  afterEach(async () => {
    await appSettings.setFlag("apiInboxV1Enabled", false);
  });

  it("adds a pagination-independent unreadCount without changing legacy list fields", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const now = Date.now();
    const newestCreatedAt = new Date(now - 60_000);
    const first = await createAlert(owner.user.id, {
      title: "Newest alert",
      createdAt: newestCreatedAt,
    });
    await createAlert(owner.user.id, {
      createdAt: new Date(now - 120_000),
    });
    await createAlert(owner.user.id, {
      createdAt: new Date(now - 180_000),
      readAt: new Date(now - 150_000),
    });
    await createAlert(owner.user.id, {
      createdAt: new Date(now - 240_000),
      expiresAt: new Date(now - 30_000),
    });
    await createAlert(other.user.id);
    const supportThread = await createUnreadSupportThread(
      server.baseUrl,
      owner.token,
      owner.user.id
    );

    const response = await request(server.baseUrl, "GET", "/inbox/alerts?limit=1", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "alerts", "nextCursor", "totalUnreadCount", "unreadCount",
    ]);
    // Preserve the shipped alert-only meaning for frozen clients. The new
    // shell badge total is additive and includes unread support threads.
    assert.equal(body.unreadCount, 2);
    assert.equal(body.totalUnreadCount, 3);
    assert.equal(body.alerts.length, 1);
    assert.deepEqual(body.alerts[0], {
      id: first.id,
      type: "SYSTEM",
      title: "Newest alert",
      body: "An integration-test alert.",
      destination: { route: "home" },
      createdAt: newestCreatedAt.toISOString(),
      readAt: null,
    });
    assert.equal(typeof body.nextCursor, "string");

    const homeResponse = await request(server.baseUrl, "GET", "/home/race-card", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });
    assert.equal(homeResponse.status, 200);
    assert.equal((await homeResponse.json()).inboxUnreadCount, 3);

    const openThread = await request(
      server.baseUrl,
      "GET",
      `/feedback/threads/${supportThread.id}`,
      { token: owner.token, headers: INBOX_FEATURES }
    );
    assert.equal(openThread.status, 200);

    const alertsAfterThreadRead = await request(
      server.baseUrl,
      "GET",
      "/inbox/alerts?limit=1",
      { token: owner.token, headers: INBOX_FEATURES }
    );
    assert.equal(alertsAfterThreadRead.status, 200);
    const afterThreadRead = await alertsAfterThreadRead.json();
    assert.equal(afterThreadRead.unreadCount, 2);
    assert.equal(afterThreadRead.totalUnreadCount, 2);

    const homeAfterThreadRead = await request(
      server.baseUrl,
      "GET",
      "/home/race-card",
      { token: owner.token, headers: INBOX_FEATURES }
    );
    assert.equal(homeAfterThreadRead.status, 200);
    assert.equal((await homeAfterThreadRead.json()).inboxUnreadCount, 2);
  });

  it("marks an owned alert read idempotently and returns the post-read unread count", async () => {
    const owner = await createTestUser();
    const target = await createAlert(owner.user.id);
    await createAlert(owner.user.id);
    await createUnreadSupportThread(server.baseUrl, owner.token, owner.user.id);

    const firstRead = await request(
      server.baseUrl,
      "POST",
      `/inbox/alerts/${target.id}/read`,
      { token: owner.token, headers: INBOX_FEATURES }
    );
    assert.equal(firstRead.status, 200);
    assert.deepEqual(await firstRead.json(), {
      read: true,
      unreadCount: 1,
      totalUnreadCount: 2,
    });

    const replay = await request(
      server.baseUrl,
      "POST",
      `/inbox/alerts/${target.id}/read`,
      { token: owner.token, headers: INBOX_FEATURES }
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      read: true,
      unreadCount: 1,
      totalUnreadCount: 2,
    });

    const persisted = await prisma.inboxAlert.findUnique({ where: { id: target.id } });
    assert.ok(persisted.readAt instanceof Date);
  });

  it("rejects missing and malformed alert ids before querying ownership", async () => {
    const owner = await createTestUser();

    for (const path of [
      "/inbox/alerts/read",
      "/inbox/alerts/not-a-uuid/read",
      "/inbox/alerts/00000000-0000-0000-0000-00000000000z/read",
    ]) {
      const response = await request(server.baseUrl, "POST", path, {
        token: owner.token,
        headers: INBOX_FEATURES,
      });
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), {
        error: "Invalid alert id",
        code: "INVALID_ID",
      });
    }
  });

  it("returns the same not-found response for foreign, expired, and unknown alerts", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const foreign = await createAlert(other.user.id);
    const expired = await createAlert(owner.user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const unknownId = "00000000-0000-0000-0000-000000000000";

    for (const id of [foreign.id, expired.id, unknownId]) {
      const response = await request(
        server.baseUrl,
        "POST",
        `/inbox/alerts/${id}/read`,
        { token: owner.token, headers: INBOX_FEATURES }
      );
      assert.equal(response.status, 404, id);
      assert.deepEqual(await response.json(), {
        error: "Alert not found",
        code: "NOT_FOUND",
      });
    }

    const foreignAfter = await prisma.inboxAlert.findUnique({ where: { id: foreign.id } });
    assert.equal(foreignAfter.readAt, null);
  });

  it("serializes the additive shell destinations through the public alerts endpoint", async () => {
    const owner = await createTestUser();
    for (const route of ["races", "inbox", "profile"]) {
      await createAlert(owner.user.id, {
        title: `Open ${route}`,
        destination: { route },
      });
    }

    const response = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      new Set(body.alerts.map((alert) => alert.destination.route)),
      new Set(["races", "inbox", "profile"])
    );
    assert.equal(body.unreadCount, 3);
  });

  it("keeps authentication and legacy capability gating unchanged", async () => {
    const owner = await createTestUser();
    const alert = await createAlert(owner.user.id);

    for (const [method, path] of [
      ["GET", "/inbox/alerts"],
      ["POST", `/inbox/alerts/${alert.id}/read`],
    ]) {
      const unauthenticated = await request(server.baseUrl, method, path, {
        headers: INBOX_FEATURES,
      });
      assert.equal(unauthenticated.status, 401, `${method} ${path}`);
      assert.deepEqual(await unauthenticated.json(), {
        error: "Authorization bearer token is required",
      });

      const legacyClient = await request(server.baseUrl, method, path, {
        token: owner.token,
      });
      assert.equal(legacyClient.status, 404, `${method} ${path}`);
      assert.deepEqual(await legacyClient.json(), {
        error: "Inbox is unavailable",
        code: "FEATURE_DISABLED",
      });
    }
  });
});
