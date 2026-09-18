const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const { startServer, request } = require("./setup");

// The version-policy endpoint is public (no auth) and config-driven. We start a
// dedicated server with an injected policy so the floor/latest are deterministic
// regardless of the deployed env defaults.
const APP_VERSION_CONFIG = {
  minSupportedVersion: "1.4.0",
  latestVersion: "1.4.2",
  iosUpdateUrl: "https://apps.apple.com/app/bara",
  androidUpdateUrl: "https://play.google.com/store/apps/details?id=bara",
};

describe("GET /app-version/policy", () => {
  let server;

  before(async () => {
    server = await startServer({ appVersionConfig: APP_VERSION_CONFIG });
  });

  after(async () => {
    await server.close();
  });

  it("returns the policy without authentication", async () => {
    const res = await request(server.baseUrl, "GET", "/app-version/policy");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.minSupportedVersion, "1.4.0");
    assert.equal(body.latestVersion, "1.4.2");
    assert.equal(body.updateUrl.ios, APP_VERSION_CONFIG.iosUpdateUrl);
    assert.equal(body.updateUrl.android, APP_VERSION_CONFIG.androidUpdateUrl);
  });

  it("flags updateRequired for a client below the floor", async () => {
    const res = await request(server.baseUrl, "GET", "/app-version/policy", {
      headers: { "X-App-Version": "1.3.6" },
    });
    const body = await res.json();
    assert.equal(body.updateRequired, true);
    assert.equal(body.updateAvailable, true);
  });

  it("flags only updateAvailable for a client between floor and latest", async () => {
    const res = await request(server.baseUrl, "GET", "/app-version/policy", {
      headers: { "X-App-Version": "1.4.0" },
    });
    const body = await res.json();
    assert.equal(body.updateRequired, false);
    assert.equal(body.updateAvailable, true);
  });

  it("clears both flags for a client on the latest version", async () => {
    const res = await request(server.baseUrl, "GET", "/app-version/policy", {
      headers: { "X-App-Version": "1.4.2" },
    });
    const body = await res.json();
    assert.equal(body.updateRequired, false);
    assert.equal(body.updateAvailable, false);
  });

  it("fails open when no X-App-Version header is sent", async () => {
    const res = await request(server.baseUrl, "GET", "/app-version/policy");
    const body = await res.json();
    // Policy is still returned so the client can self-evaluate, but the
    // server-side convenience flags never lock out an unknown client.
    assert.equal(body.updateRequired, false);
  });
});
