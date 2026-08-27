const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const { AppError } = require("../../src/shared/errors/AppError");
const {
  cleanDatabase,
  createTestUser,
  request,
  startServer,
} = require("./setup");

describe("feedback email HTTP contract", () => {
  let server;
  let calls;
  let result;
  let failure;

  before(async () => {
    server = await startServer({
      sendFeedbackEmail: async (input) => {
        calls.push(input);
        if (failure) throw failure;
        return result;
      },
    });
  });

  after(async () => server.close());

  beforeEach(async () => {
    await cleanDatabase();
    calls = [];
    result = { ok: true, delivery: "email" };
    failure = null;
  });

  it("accepts additive replyToEmail and provenance while preserving old request compatibility", async () => {
    const { user, token } = await createTestUser({
      email: "stored@example.com",
      displayName: "Trail Walker",
    });

    const modern = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token,
      headers: { "X-App-Version": "3.2.1", "X-Platform": "ios" },
      body: {
        text: "  Please add trail maps  ",
        category: " feature ",
        replyToEmail: "person@example.com",
      },
    });
    assert.equal(modern.status, 201);
    assert.deepEqual(await modern.json(), { ok: true, delivery: "email" });
    assert.deepEqual(calls[0], {
      userId: user.id,
      text: "  Please add trail maps  ",
      category: " feature ",
      replyToEmail: "person@example.com",
      storedEmail: "stored@example.com",
      displayName: "Trail Walker",
      appVersion: "3.2.1",
      platform: "ios",
    });

    const legacy = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      token,
      body: { text: "Old app payload" },
    });
    assert.equal(legacy.status, 201);
    assert.deepEqual(await legacy.json(), { ok: true, delivery: "email" });
    assert.equal(calls[1].replyToEmail, undefined);
    assert.equal(calls[1].storedEmail, "stored@example.com");
  });

  it("requires authentication before invoking the command", async () => {
    const response = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      body: { text: "Anonymous feedback" },
    });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });

  for (const [status, code, message] of [
    [400, "INVALID_TEXT", "Feedback text is invalid"],
    [400, "INVALID_CATEGORY", "Feedback category is invalid"],
    [400, "INVALID_REPLY_TO_EMAIL", "Reply email is invalid"],
    [429, "DAILY_LIMIT_REACHED", "Daily feedback limit reached"],
    [503, "EMAIL_DELIVERY_UNAVAILABLE", "Email delivery is unavailable"],
    [503, "EMAIL_DELIVERY_UNCERTAIN", "Email delivery could not be confirmed"],
    [500, "INTERNAL_ERROR", "Internal server error"],
  ]) {
    it(`returns the locked ${status} ${code} error envelope`, async () => {
      const { token } = await createTestUser();
      failure = new AppError(message, code, status);

      const response = await request(server.baseUrl, "POST", "/feedback/suggestions", {
        token,
        body: { text: "Hello" },
      });

      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: message, code });
    });
  }
});
