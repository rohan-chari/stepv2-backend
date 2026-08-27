const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  authorizeFeedbackOAuth,
  oauthClientConfig,
} = require("../../scripts/authorize-google-workspace-feedback");

describe("feedback OAuth authorization helper", () => {
  it("accepts only a fixed localhost callback with an explicit port", () => {
    assert.deepEqual(oauthClientConfig({ web: {
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uris: [
        "https://example.com/callback",
        "http://127.0.0.1:53682/oauth2callback",
      ],
    } }), {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:53682/oauth2callback",
    });

    assert.equal(oauthClientConfig({ installed: {
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uris: ["http://localhost/callback"],
    } }), null);
  });

  it("uses PKCE, explicit account selection, one scope, and an exclusive mode-0600 secret write", async () => {
    const calls = [];
    const output = [];
    const clientDocument = JSON.stringify({ web: {
      client_id: "expected-client-id",
      client_secret: "client-secret-must-not-print",
      redirect_uris: ["http://127.0.0.1:53682/oauth2callback"],
    } });
    const oauthClient = {
      async generateCodeVerifierAsync() {
        calls.push(["pkce"]);
        return { codeVerifier: "verifier", codeChallenge: "challenge" };
      },
      generateAuthUrl(options) {
        calls.push(["generateAuthUrl", options]);
        return "https://accounts.google.test/authorize";
      },
      async getToken(options) {
        calls.push(["getToken", options]);
        return { tokens: {
          access_token: "access-token-must-not-print",
          refresh_token: "refresh-token-must-not-print",
        } };
      },
      async getTokenInfo(token) {
        calls.push(["getTokenInfo", token]);
        return {
          aud: "expected-client-id",
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
        };
      },
    };

    await authorizeFeedbackOAuth({
      clientPath: "/tmp/client.json",
      outputPath: "/tmp/feedback-oauth.json",
      readFile: async () => clientDocument,
      writeFile: async (...args) => { calls.push(["writeFile", ...args]); },
      chmod: async (...args) => { calls.push(["chmod", ...args]); },
      oauthClientFactory: (options) => {
        calls.push(["factory", options]);
        return oauthClient;
      },
      waitForAuthorizationCode: async (...args) => {
        calls.push(["waitForAuthorizationCode", ...args]);
        return "authorization-code";
      },
      randomState: () => "random-state",
      stdout: { write(value) { output.push(value); } },
    });

    const authOptions = calls.find(([name]) => name === "generateAuthUrl")[1];
    assert.equal(authOptions.access_type, "offline");
    assert.equal(authOptions.prompt, "consent select_account");
    assert.deepEqual(authOptions.scope, ["https://www.googleapis.com/auth/gmail.send"]);
    assert.equal(authOptions.code_challenge_method, "S256");
    assert.equal(authOptions.code_challenge, "challenge");
    assert.equal(authOptions.login_hint, "support@barastep.com");
    assert.equal(authOptions.hd, "barastep.com");

    const write = calls.find(([name]) => name === "writeFile");
    assert.equal(write[1], "/tmp/feedback-oauth.json");
    assert.deepEqual(write[3], { mode: 0o600, flag: "wx" });
    assert.deepEqual(calls.find(([name]) => name === "chmod").slice(1), [
      "/tmp/feedback-oauth.json",
      0o600,
    ]);
    const printed = output.join("");
    assert.doesNotMatch(printed, /client-secret|refresh-token|access-token/);
  });
});
