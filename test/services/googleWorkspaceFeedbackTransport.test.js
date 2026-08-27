const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");

const {
  GMAIL_SEND_SCOPE,
  GMAIL_SEND_URL,
  SUPPORT_ADDRESS,
  buildGoogleWorkspaceFeedbackTransport,
  classifyGmailResponse,
} = require("../../src/modules/feedback/services/googleWorkspaceFeedbackTransport");

const CLIENT_ID = "bara-feedback.apps.googleusercontent.com";
const CLIENT_SECRET = "oauth-client-secret-must-never-leak";
const REFRESH_TOKEN = "refresh-token-must-never-leak";
const ACCESS_TOKEN = "access-token-must-never-leak";

function message(overrides = {}) {
  return {
    text: "Plain text only",
    replyTo: "person@example.com",
    messageId: "<12345678-1234-4234-8234-123456789abc@barastep.com>",
    ...overrides,
  };
}

function successResponse(data = { id: "gmail-created-message-id" }, status = 200) {
  return { status, async json() { return data; } };
}

describe("Google Workspace Gmail API feedback transport", () => {
  let tempDir;
  let oauthFile;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bara-feedback-oauth-"));
    oauthFile = path.join(tempDir, "oauth.json");
    await fs.writeFile(oauthFile, JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
    }), { mode: 0o600 });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function rootOnlyStat(file) {
    const metadata = await fs.stat(file);
    return {
      isFile: () => metadata.isFile(),
      mode: metadata.mode,
      size: metadata.size,
      uid: 0,
    };
  }

  function build(overrides = {}) {
    const oauthCalls = [];
    const oauthClient = {
      setCredentials(credentials) { oauthCalls.push(["setCredentials", credentials]); },
      async getAccessToken() {
        oauthCalls.push(["getAccessToken"]);
        return { token: ACCESS_TOKEN };
      },
      async getTokenInfo(token) {
        oauthCalls.push(["getTokenInfo", token]);
        return { aud: CLIENT_ID, scopes: [GMAIL_SEND_SCOPE] };
      },
    };
    const fetchCalls = [];
    const fetch = async (...args) => {
      fetchCalls.push(args);
      return successResponse();
    };
    const transport = buildGoogleWorkspaceFeedbackTransport({
      oauthFile,
      stat: rootOnlyStat,
      oauthClientFactory(options) {
        oauthCalls.push(["factory", options]);
        return oauthClient;
      },
      fetch,
      ...overrides,
    });
    return { transport, oauthCalls, fetchCalls };
  }

  it("refreshes one-user OAuth, validates its client/scope, and posts one controlled MIME message", async () => {
    const { transport, oauthCalls, fetchCalls } = build();
    const result = await transport.send(message({
      from: "attacker@example.com",
      to: "attacker@example.com",
      subject: "overridden",
      headers: { Bcc: "victim@example.com" },
    }));

    assert.deepEqual(result, { accepted: [SUPPORT_ADDRESS], rejected: [] });
    assert.deepEqual(oauthCalls[0], ["factory", {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeout: 10_000,
    }]);
    assert.deepEqual(oauthCalls[1], ["setCredentials", { refresh_token: REFRESH_TOKEN }]);
    assert.deepEqual(oauthCalls.slice(2), [
      ["getAccessToken"],
      ["getTokenInfo", ACCESS_TOKEN],
    ]);
    assert.equal(fetchCalls.length, 1);
    const [url, options] = fetchCalls[0];
    assert.equal(url, GMAIL_SEND_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(JSON.parse(options.body)), ["raw"]);

    const raw = JSON.parse(options.body).raw;
    assert.match(raw, /^[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(raw, /[+/=]/);
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(mime, /^From: Bara Support <support@barastep\.com>\r?$/m);
    assert.match(mime, /^To: support@barastep\.com\r?$/m);
    assert.match(mime, /^Reply-To: person@example\.com\r?$/m);
    assert.match(mime, /^Message-ID: <12345678-1234-4234-8234-123456789abc@barastep\.com>\r?$/m);
    assert.match(mime, /^Content-Type: text\/plain; charset=utf-8\r?$/m);
    assert.match(mime, /Plain text only/);
    assert.doesNotMatch(mime, /attacker|victim|Bcc:/i);
    assert.match(mime, /^Subject: =\?UTF-8\?Q\?USER_FEEDBACK_=E2=80=A2_12345678\?=\r?$/m);
  });

  it("omits Reply-To when absent and rejects an invalid pre-generated Message-ID before dispatch", async () => {
    const { transport, fetchCalls } = build();
    await transport.send(message({ replyTo: undefined }));
    const mime = Buffer.from(JSON.parse(fetchCalls[0][1].body).raw, "base64url").toString("utf8");
    assert.doesNotMatch(mime, /^Reply-To:/m);

    await assert.rejects(
      transport.send(message({ messageId: "bad\r\nBcc: victim@example.com" })),
      (error) => error.feedbackDelivery === "unavailable"
    );
    await assert.rejects(
      transport.send(message({ replyTo: "Name<person@example.com>" })),
      (error) => error.feedbackDelivery === "unavailable"
    );
    assert.equal(fetchCalls.length, 1);
  });

  it("fails definitively before Gmail dispatch for missing/unsafe config, refresh failure, or invalid token identity", async () => {
    const cases = [
      { oauthFile: path.join(tempDir, "missing.json") },
      { oauthFile, readFile: async () => "not json" },
      { oauthFile, readFile: async () => JSON.stringify({ clientId: CLIENT_ID }) },
      { oauthFile, stat: async () => ({ isFile: () => true, mode: 0o100600, uid: 501 }) },
      { oauthFile, stat: async () => ({ isFile: () => true, mode: 0o100644 }) },
      { oauthFile, oauthClientFactory: () => ({
        setCredentials() {},
        async getAccessToken() { throw new Error(`invalid_grant ${REFRESH_TOKEN}`); },
      }) },
      { oauthFile, oauthClientFactory: () => ({
        setCredentials() {},
        async getAccessToken() { return { token: ACCESS_TOKEN }; },
        async getTokenInfo() {
          return { aud: "wrong-client", scopes: [GMAIL_SEND_SCOPE] };
        },
      }) },
      { oauthFile, oauthClientFactory: () => ({
        setCredentials() {},
        async getAccessToken() { return { token: ACCESS_TOKEN }; },
        async getTokenInfo() {
          return { aud: CLIENT_ID, scopes: [GMAIL_SEND_SCOPE, "openid"] };
        },
      }) },
    ];

    for (const dependencies of cases) {
      let fetched = false;
      const transport = buildGoogleWorkspaceFeedbackTransport({
        stat: rootOnlyStat,
        fetch: async () => { fetched = true; return successResponse(); },
        ...dependencies,
      });
      await assert.rejects(transport.send(message()), (error) => {
        assert.equal(error.feedbackDelivery, "unavailable");
        const serialized = JSON.stringify(error);
        assert.doesNotMatch(serialized, new RegExp([
          CLIENT_SECRET,
          REFRESH_TOKEN,
          ACCESS_TOKEN,
          "invalid_grant",
        ].join("|")));
        assert.doesNotMatch(error.message, /client|refresh|access|grant/i);
        return true;
      });
      assert.equal(fetched, false);
    }
  });

  it("bounds OAuth waits before dispatch and Gmail HTTPS waits after dispatch", async () => {
    let fetched = false;
    const oauthTimeoutTransport = buildGoogleWorkspaceFeedbackTransport({
      oauthFile,
      stat: rootOnlyStat,
      oauthTimeoutMs: 5,
      oauthClientFactory: () => ({
        setCredentials() {},
        async getAccessToken() { return new Promise(() => {}); },
        async getTokenInfo() { throw new Error("must not be reached"); },
      }),
      fetch: async () => { fetched = true; return successResponse(); },
    });
    await assert.rejects(
      oauthTimeoutTransport.send(message()),
      (error) => error.feedbackDelivery === "unavailable"
    );
    assert.equal(fetched, false);

    const { transport } = build({
      gmailTimeoutMs: 5,
      fetch: async (_url, options) => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    await assert.rejects(
      transport.send(message()),
      (error) => error.feedbackDelivery === "uncertain"
    );
  });

  it("keeps the Gmail deadline active while a 2xx response body stalls", async () => {
    let requestSignal;
    let fallback;
    const { transport } = build({
      gmailTimeoutMs: 5,
      fetch: async (_url, options) => {
        requestSignal = options.signal;
        return {
          status: 200,
          async json() {
            return new Promise((_, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(new Error("body aborted")),
                { once: true }
              );
              fallback = setTimeout(() => reject(new Error("test body did not abort")), 100);
            });
          },
        };
      },
    });

    try {
      await assert.rejects(
        transport.send(message()),
        (error) => error.feedbackDelivery === "uncertain"
      );
      assert.equal(requestSignal.aborted, true);
    } finally {
      clearTimeout(fallback);
    }
  });

  it("classifies all Gmail HTTP outcome classes exactly", () => {
    for (const status of [400, 401, 403, 404, 409, 418, 429]) {
      assert.equal(classifyGmailResponse(status), "unavailable", String(status));
    }
    for (const status of [100, 199, 300, 301, 307, 308, 408, 500, 502, 503, 504, 600]) {
      assert.equal(classifyGmailResponse(status), "uncertain", String(status));
    }
    for (const status of [200, 201, 202, 204, 299]) {
      assert.equal(classifyGmailResponse(status), "accepted", String(status));
    }
  });

  it("does not retry and redacts provider bodies for definitive Gmail rejection", async () => {
    const calls = [];
    const { transport } = build({
      fetch: async (...args) => {
        calls.push(args);
        return {
          status: 403,
          async json() { throw new Error("provider body must not be read"); },
          async text() { throw new Error("provider body must not be read"); },
        };
      },
    });
    await assert.rejects(transport.send(message()), (error) => {
      assert.equal(error.feedbackDelivery, "unavailable");
      assert.equal(error.safeStatusClass, "4xx");
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("treats 408, every 5xx, redirects, unexpected statuses, and post-invocation network loss as uncertain", async () => {
    const outcomes = [
      async () => ({ status: 408 }),
      async () => ({ status: 500 }),
      async () => ({ status: 503 }),
      async () => ({ status: 504 }),
      async () => ({ status: 302 }),
      async () => ({ status: 600 }),
      async () => { throw new Error(`socket closed ${ACCESS_TOKEN} provider-body`); },
    ];
    for (const fetch of outcomes) {
      let calls = 0;
      const { transport } = build({ fetch: async (...args) => { calls += 1; return fetch(...args); } });
      await assert.rejects(transport.send(message()), (error) => {
        assert.equal(error.feedbackDelivery, "uncertain");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(JSON.stringify(error), /access-token|provider-body/);
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it("treats malformed 2xx responses as uncertain and accepts only a non-empty Gmail message ID", async () => {
    for (const response of [
      successResponse(null),
      successResponse({}),
      successResponse({ id: "" }),
      successResponse({ id: "   " }),
      { status: 200, async json() { throw new Error("malformed provider JSON"); } },
    ]) {
      const { transport } = build({ fetch: async () => response });
      await assert.rejects(
        transport.send(message()),
        (error) => error.feedbackDelivery === "uncertain" && error.cause === undefined
      );
    }

    const { transport } = build({ fetch: async () => successResponse({ id: "gmail-id", threadId: "gmail-thread" }) });
    assert.deepEqual(await transport.send(message()), {
      accepted: [SUPPORT_ADDRESS],
      rejected: [],
    });
  });
});
