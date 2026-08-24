const assert = require("node:assert/strict");
const { afterEach, before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
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
      title: "Inbox read-all test alert",
      body: "An integration-test alert.",
      sourceKey: `inbox-read-all:${suffix}`,
      destination: { route: "home" },
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    },
  });
}

async function createSupportThread(user) {
  const response = await request(server.baseUrl, "POST", "/feedback/suggestions", {
    token: user.token,
    headers: INBOX_FEATURES,
    body: { text: "A read-all support thread." },
  });
  assert.equal(response.status, 201);
  return prisma.feedbackThread.findFirstOrThrow({
    where: { userId: user.user.id },
    orderBy: { createdAt: "desc" },
  });
}

describe("POST /inbox/read-all", () => {
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

  it("marks active unread alerts and support threads for only the authenticated user", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();

    const ownerAlerts = await Promise.all([
      createAlert(owner.user.id),
      createAlert(owner.user.id),
      createAlert(owner.user.id),
    ]);
    const alreadyRead = await createAlert(owner.user.id, {
      readAt: new Date(Date.now() - 1_000),
    });
    const expiredAlert = await createAlert(owner.user.id, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const foreignAlert = await createAlert(other.user.id);

    const ownerThreads = await Promise.all([
      createSupportThread(owner),
      createSupportThread(owner),
    ]);
    const expiredThread = await createSupportThread(owner);
    await prisma.feedbackThread.update({
      where: { id: expiredThread.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const foreignThread = await createSupportThread(other);

    const homeBefore = await request(server.baseUrl, "GET", "/home/race-card", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });
    assert.equal(homeBefore.status, 200);
    assert.equal((await homeBefore.json()).inboxUnreadCount, 5);

    const response = await request(server.baseUrl, "POST", "/inbox/read-all", {
      token: owner.token,
      headers: INBOX_FEATURES,
      body: {},
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      readAlertCount: 3,
      readThreadCount: 2,
      unreadCount: 0,
      totalUnreadCount: 0,
    });

    const homeAfter = await request(server.baseUrl, "GET", "/home/race-card", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });
    assert.equal(homeAfter.status, 200);
    assert.equal((await homeAfter.json()).inboxUnreadCount, 0);

    const persistedAlerts = await prisma.inboxAlert.findMany({
      where: { id: { in: [...ownerAlerts.map((row) => row.id), alreadyRead.id, expiredAlert.id, foreignAlert.id] } },
    });
    const byAlertId = new Map(persistedAlerts.map((row) => [row.id, row]));
    for (const alert of ownerAlerts) assert.ok(byAlertId.get(alert.id).readAt instanceof Date);
    assert.ok(byAlertId.get(alreadyRead.id).readAt instanceof Date);
    assert.equal(byAlertId.get(expiredAlert.id).readAt, null);
    assert.equal(byAlertId.get(foreignAlert.id).readAt, null);

    const persistedThreads = await prisma.feedbackThread.findMany({
      where: { id: { in: [...ownerThreads.map((row) => row.id), expiredThread.id, foreignThread.id] } },
    });
    const byThreadId = new Map(persistedThreads.map((row) => [row.id, row]));
    for (const thread of ownerThreads) assert.ok(byThreadId.get(thread.id).userReadAt instanceof Date);
    assert.equal(byThreadId.get(expiredThread.id).userReadAt, null);
    assert.equal(byThreadId.get(foreignThread.id).userReadAt, null);
  });

  it("is idempotent and accepts an absent request body", async () => {
    const owner = await createTestUser();
    await createAlert(owner.user.id);
    await createSupportThread(owner);

    const first = await request(server.baseUrl, "POST", "/inbox/read-all", {
      token: owner.token,
      headers: INBOX_FEATURES,
      body: {},
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      readAlertCount: 1,
      readThreadCount: 1,
      unreadCount: 0,
      totalUnreadCount: 0,
    });

    const replay = await request(server.baseUrl, "POST", "/inbox/read-all", {
      token: owner.token,
      headers: INBOX_FEATURES,
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      readAlertCount: 0,
      readThreadCount: 0,
      unreadCount: 0,
      totalUnreadCount: 0,
    });
  });

  it("keeps authentication and Inbox capability gating unchanged", async () => {
    const owner = await createTestUser();

    const unauthenticated = await request(server.baseUrl, "POST", "/inbox/read-all", {
      headers: INBOX_FEATURES,
    });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), {
      error: "Authorization bearer token is required",
    });

    const legacyClient = await request(server.baseUrl, "POST", "/inbox/read-all", {
      token: owner.token,
    });
    assert.equal(legacyClient.status, 404);
    assert.deepEqual(await legacyClient.json(), {
      error: "Inbox is unavailable",
      code: "FEATURE_DISABLED",
    });
  });

  it("maps an unexpected command failure to the Inbox 500 contract", async () => {
    const owner = await createTestUser();
    const failingServer = await startServer({
      markInboxReadAll: async () => {
        throw new Error("simulated read-all failure");
      },
    });

    try {
      const response = await request(failingServer.baseUrl, "POST", "/inbox/read-all", {
        token: owner.token,
        headers: INBOX_FEATURES,
        body: {},
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      });
    } finally {
      await failingServer.close();
    }
  });

  it("rejects null and malformed JSON bodies without touching the inbox", async () => {
    const owner = await createTestUser();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner.token}`,
      ...INBOX_FEATURES,
    };
    const nullBody = await fetch(`${server.baseUrl}/inbox/read-all`, {
      method: "POST",
      headers,
      body: "null",
    });
    assert.equal(nullBody.status, 400);
    assert.deepEqual(await nullBody.json(), {
      error: "Invalid request body",
      code: "INVALID_BODY",
    });

    const malformed = await fetch(`${server.baseUrl}/inbox/read-all`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "Invalid request body",
      code: "INVALID_BODY",
    });
  });
});
