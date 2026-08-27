const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const { createSuggestion } = require("../../src/modules/feedback");
const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

describe("feedback A0 rolling-deploy advisory lock", () => {
  let server;

  before(async () => {
    // A0's command is retained as the rollback/rolling-deploy compatibility
    // path. Exercise it through the real authenticated route and real DB.
    server = await startServer({ sendFeedbackEmail: createSuggestion });
  });

  after(async () => server.close());
  beforeEach(cleanDatabase);

  it("allows only one of two simultaneous legacy writers to consume slot five", async () => {
    const { user, token } = await createTestUser();
    const submit = (text) =>
      request(server.baseUrl, "POST", "/feedback/suggestions", {
        token,
        body: { text },
      });

    for (let index = 0; index < 4; index += 1) {
      assert.equal((await submit(`legacy ${index}`)).status, 201);
    }
    const responses = await Promise.all([
      submit("simultaneous A"),
      submit("simultaneous B"),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 429]
    );
    assert.equal(
      await prisma.suggestion.count({ where: { userId: user.id } }),
      5
    );
    assert.equal(
      await prisma.feedbackThread.count({ where: { userId: user.id } }),
      5
    );
  });

  it("counts an A1 reservation while a mixed-version request is still in flight", async () => {
    let signalDispatch;
    let releaseDispatch;
    const dispatchStarted = new Promise((resolve) => { signalDispatch = resolve; });
    const dispatchReleased = new Promise((resolve) => { releaseDispatch = resolve; });
    const a1Server = await startServer({
      feedbackTransport: {
        async send() {
          signalDispatch();
          await dispatchReleased;
          return { accepted: ["support@barastep.com"], rejected: [] };
        },
      },
    });

    try {
      const { user, token } = await createTestUser();
      const legacySubmit = (text) =>
        request(server.baseUrl, "POST", "/feedback/suggestions", {
          token,
          body: { text },
        });
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await legacySubmit(`legacy mixed ${index}`)).status, 201);
      }

      const a1Submission = request(a1Server.baseUrl, "POST", "/feedback/suggestions", {
        token,
        body: { text: "email reservation" },
      });
      await dispatchStarted;

      const legacyResponse = await legacySubmit("legacy racing with reserved email");
      releaseDispatch();
      const a1Response = await a1Submission;

      assert.equal(a1Response.status, 201);
      assert.equal(legacyResponse.status, 429);
      assert.equal(
        await prisma.suggestion.count({ where: { userId: user.id } }),
        4
      );
      assert.equal(
        await prisma.feedbackEmailAttempt.count({ where: { userId: user.id } }),
        1
      );
    } finally {
      releaseDispatch();
      await a1Server.close();
    }
  });
});
