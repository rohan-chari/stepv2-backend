const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

function fakeTransport() {
  const sent = [];
  const failures = [];
  return {
    sent,
    failures,
    async send(message) {
      sent.push(message);
      const failure = failures.shift();
      if (failure) throw failure;
      return { accepted: ["support@barastep.com"], rejected: [] };
    },
  };
}

function deliveryError(kind) {
  const error = new Error("provider detail must never reach the client");
  error.feedbackDelivery = kind;
  return error;
}

describe("feedback email delivery", () => {
  let server;
  let transport;

  before(async () => {
    transport = fakeTransport();
    server = await startServer({ feedbackTransport: transport });
  });

  after(async () => server.close());

  beforeEach(async () => {
    await cleanDatabase();
    transport.sent.length = 0;
    transport.failures.length = 0;
  });

  async function submit(token, body, headers) {
    return request(server.baseUrl, "POST", "/feedback/suggestions", {
      token,
      body,
      headers,
    });
  }

  it("emails the locked envelope and stores content-free ACCEPTED metadata only", async () => {
    const { user, token } = await createTestUser({
      email: "stored@example.com",
      displayName: "Trail Walker",
    });

    const response = await submit(
      token,
      {
        text: "  Please add a trail map  ",
        category: " feature ",
        replyToEmail: "person@example.com",
      },
      { "X-App-Version": "3.2.1", "X-Platform": "ios" }
    );

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, delivery: "email" });
    assert.equal(transport.sent.length, 1);
    const message = transport.sent[0];
    assert.equal(message.from, "Bara Support <support@barastep.com>");
    assert.equal(message.to, "support@barastep.com");
    assert.match(message.subject, /^USER FEEDBACK • [0-9A-F]{8}$/);
    assert.equal(message.replyTo, "person@example.com");
    assert.deepEqual(message.envelope, {
      from: "feedback-bounces@barastep.com",
      to: ["support@barastep.com"],
    });
    assert.match(message.messageId, /^<[0-9a-f-]+@barastep\.com>$/);
    assert.match(message.text, /Please add a trail map/);
    assert.match(message.text, /Category: feature/);
    assert.match(message.text, /Display name: Trail Walker/);
    assert.match(message.text, /App version: 3\.2\.1/);
    assert.match(message.text, /Platform: ios/);
    assert.match(message.text, /Reply-To present: yes/);
    assert.doesNotMatch(message.text, new RegExp(user.id));
    assert.doesNotMatch(message.text, /stored@example\.com/);

    assert.equal(await prisma.suggestion.count(), 0);
    assert.equal(await prisma.feedbackThread.count(), 0);
    assert.equal(await prisma.feedbackMessage.count(), 0);
    const attempts = await prisma.feedbackEmailAttempt.findMany();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].userId, user.id);
    assert.equal(attempts[0].state, "ACCEPTED");
    assert.equal(attempts[0].messageId, message.messageId);
    const serialized = JSON.stringify(attempts[0]);
    assert.doesNotMatch(serialized, /trail map|person@example|Trail Walker|feature/);
  });

  it("uses a unique feedback subject for each independent submission", async () => {
    const { token } = await createTestUser({ email: "stored@example.com" });

    assert.equal((await submit(token, { text: "First subject" })).status, 201);
    assert.equal((await submit(token, { text: "Second subject" })).status, 201);

    assert.equal(transport.sent.length, 2);
    assert.match(transport.sent[0].subject, /^USER FEEDBACK • [0-9A-F]{8}$/);
    assert.match(transport.sent[1].subject, /^USER FEEDBACK • [0-9A-F]{8}$/);
    assert.notEqual(transport.sent[0].subject, transport.sent[1].subject);
  });

  it("uses a valid stored account email as fallback Reply-To", async () => {
    const { token } = await createTestUser({ email: "stored@example.com" });
    const response = await submit(token, { text: "Fallback please" });
    assert.equal(response.status, 201);
    assert.equal(transport.sent[0].replyTo, "stored@example.com");
  });

  it("omits an invalid stored fallback without blocking feedback", async () => {
    const { token } = await createTestUser({ email: "not a mailbox" });
    const response = await submit(token, { text: "No valid return address" });
    assert.equal(response.status, 201);
    assert.equal("replyTo" in transport.sent[0], false);
    assert.match(transport.sent[0].text, /^NO REPLY ADDRESS — DO NOT REPLY/);
    assert.match(transport.sent[0].text, /Reply-To present: no/);
  });

  it("rejects unsafe entered Reply-To values but permits null and blank", async () => {
    const { token } = await createTestUser({ email: null });
    for (const replyToEmail of [
      "Name <person@example.com>",
      "a@example.com,b@example.com",
      "a@example.com;b@example.com",
      "person@example.com\r\nBcc: victim@example.com",
      "not a mailbox",
      "a".repeat(255),
      42,
    ]) {
      const response = await submit(token, { text: "Hello", replyToEmail });
      assert.equal(response.status, 400, String(replyToEmail));
      assert.deepEqual(await response.json(), {
        error: "Reply email is invalid",
        code: "INVALID_REPLY_TO_EMAIL",
      });
    }

    assert.equal((await submit(token, { text: "Null", replyToEmail: null })).status, 201);
    assert.equal((await submit(token, { text: "Blank", replyToEmail: "  " })).status, 201);
  });

  it("returns coded validation errors and never dispatches invalid content", async () => {
    const { token } = await createTestUser();
    for (const [body, code] of [
      [{}, "INVALID_TEXT"],
      [{ text: " " }, "INVALID_TEXT"],
      [{ text: "x".repeat(2001) }, "INVALID_TEXT"],
      [{ text: "ok", category: 7 }, "INVALID_CATEGORY"],
      [{ text: "ok", category: "x".repeat(65) }, "INVALID_CATEGORY"],
    ]) {
      const response = await submit(token, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, code);
    }
    assert.equal(transport.sent.length, 0);
    assert.equal(await prisma.feedbackEmailAttempt.count(), 0);
  });

  it("ignores unknown or oversized provenance and only accepts known platforms", async () => {
    const { token } = await createTestUser();
    const response = await submit(
      token,
      { text: "Unknown client" },
      { "X-App-Version": "x".repeat(33), "X-Platform": "toaster" }
    );
    assert.equal(response.status, 201);
    assert.doesNotMatch(transport.sent[0].text, /App version:/);
    assert.doesNotMatch(transport.sent[0].text, /Platform:/);
  });

  it("counts same-day legacy suggestions and email attempts in one quota", async () => {
    const { user, token } = await createTestUser();
    for (let i = 0; i < 4; i += 1) {
      await prisma.suggestion.create({ data: { userId: user.id, text: `legacy ${i}` } });
    }

    assert.equal((await submit(token, { text: "the fifth slot" })).status, 201);
    const sixth = await submit(token, { text: "blocked" });
    assert.equal(sixth.status, 429);
    assert.deepEqual(await sixth.json(), {
      error: "Daily feedback limit reached",
      code: "DAILY_LIMIT_REACHED",
    });
    assert.equal(transport.sent.length, 1);
  });

  it("reserves at most five attempts across two server instances", async () => {
    const secondTransport = fakeTransport();
    const second = await startServer({ feedbackTransport: secondTransport });
    try {
      const { token } = await createTestUser();
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          request(index % 2 ? second.baseUrl : server.baseUrl, "POST", "/feedback/suggestions", {
            token,
            body: { text: `parallel ${index}` },
          })
        )
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [201, 201, 201, 201, 201, 429]
      );
      assert.equal(await prisma.feedbackEmailAttempt.count(), 5);
      assert.equal(transport.sent.length + secondTransport.sent.length, 5);
    } finally {
      await second.close();
    }
  });

  it("releases quota on definitive failure and preserves it on uncertain delivery", async () => {
    const { token } = await createTestUser();

    transport.failures.push(deliveryError("unavailable"));
    const rejected = await submit(token, { text: "Definitive rejection" });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).code, "EMAIL_DELIVERY_UNAVAILABLE");
    assert.equal(
      await prisma.feedbackEmailAttempt.count({ where: { state: "FAILED" } }),
      1
    );

    transport.failures.push(deliveryError("uncertain"));
    const uncertain = await submit(token, { text: "Ambiguous timeout" });
    assert.equal(uncertain.status, 503);
    assert.equal((await uncertain.json()).code, "EMAIL_DELIVERY_UNCERTAIN");
    const reservedAttempt = await prisma.feedbackEmailAttempt.findFirst({
      where: { state: "RESERVED" },
    });
    assert.equal(reservedAttempt?.lastErrorCode, "EMAIL_DELIVERY_UNCERTAIN");

    for (let i = 0; i < 4; i += 1) {
      assert.equal((await submit(token, { text: `accepted ${i}` })).status, 201);
    }
    assert.equal((await submit(token, { text: "over quota" })).status, 429);
  });

  it("keeps the uncertain 503 when best-effort ambiguity metadata cannot persist", async () => {
    const uncertainTransport = fakeTransport();
    uncertainTransport.failures.push(deliveryError("uncertain"));
    let ambiguityWriteAttempted = false;
    const faultingAttemptDelegate = new Proxy(prisma.feedbackEmailAttempt, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args) => {
            if (args?.data?.lastErrorCode === "EMAIL_DELIVERY_UNCERTAIN") {
              ambiguityWriteAttempted = true;
              throw new Error("injected ambiguity metadata outage");
            }
            return target.updateMany(args);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const faultingPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === "feedbackEmailAttempt") return faultingAttemptDelegate;
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const uncertaintyServer = await startServer({
      prisma: faultingPrisma,
      feedbackTransport: uncertainTransport,
      logger: { log() {}, error() {} },
    });

    try {
      const { token } = await createTestUser();
      const response = await request(
        uncertaintyServer.baseUrl,
        "POST",
        "/feedback/suggestions",
        { token, body: { text: "Ambiguous despite metadata outage" } }
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "EMAIL_DELIVERY_UNCERTAIN");
      assert.equal(ambiguityWriteAttempted, true);
      assert.equal(
        await prisma.feedbackEmailAttempt.count({ where: { state: "RESERVED" } }),
        1
      );
    } finally {
      await uncertaintyServer.close();
    }
  });

  it("cascades content-free attempts on account deletion", async () => {
    const { user, token } = await createTestUser();
    assert.equal((await submit(token, { text: "Before deletion" })).status, 201);
    assert.equal(
      await prisma.feedbackEmailAttempt.count({ where: { userId: user.id } }),
      1
    );

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", { token });
    assert.equal(deleted.status, 204);
    assert.equal(
      await prisma.feedbackEmailAttempt.count({ where: { userId: user.id } }),
      0
    );
  });

  it("returns 201 after known SMTP acceptance even when ACCEPTED finalization exhausts retries", async () => {
    const acceptedTransport = fakeTransport();
    const logs = [];
    const faultingAttemptDelegate = new Proxy(prisma.feedbackEmailAttempt, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args) => {
            if (args?.data?.state === "ACCEPTED") {
              const error = new Error("injected finalize outage");
              error.code = "TEST_FINALIZE_DOWN";
              throw error;
            }
            return target.updateMany(args);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const faultingPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === "feedbackEmailAttempt") return faultingAttemptDelegate;
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const finalizeServer = await startServer({
      prisma: faultingPrisma,
      feedbackTransport: acceptedTransport,
      logger: { log() {}, error(message, metadata) { logs.push([message, metadata]); } },
    });
    try {
      const { token } = await createTestUser();
      const response = await request(
        finalizeServer.baseUrl,
        "POST",
        "/feedback/suggestions",
        { token, body: { text: "Accepted before metadata outage" } }
      );
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { ok: true, delivery: "email" });
      assert.equal(acceptedTransport.sent.length, 1);
      assert.equal(
        await prisma.feedbackEmailAttempt.count({ where: { state: "RESERVED" } }),
        1
      );
      assert.equal(logs.length, 1);
      assert.equal(logs[0][0], "Accepted feedback email metadata finalization failed");
      assert.equal(logs[0][1].code, "TEST_FINALIZE_DOWN");
    } finally {
      await finalizeServer.close();
    }
  });
});
