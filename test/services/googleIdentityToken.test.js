const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  verifyGoogleIdentityToken,
  GoogleIdentityTokenError,
} = require("../../src/modules/users/services/googleIdentityToken");

const WEB_CLIENT_ID = "web-client.apps.googleusercontent.com";
const IOS_CLIENT_ID = "ios-client.apps.googleusercontent.com";
const KEY_ID = "test-key-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signToken(payloadOverrides = {}) {
  const header = { alg: "RS256", kid: KEY_ID, typ: "JWT" };
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com",
    aud: WEB_CLIENT_ID,
    sub: "google-sub-123",
    exp: nowInSeconds + 300,
    iat: nowInSeconds,
    ...payloadOverrides,
  };
  const signedData = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload)
  )}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signedData), privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${signedData}.${signature}`;
}

const originalFetch = global.fetch;
const originalClientId = process.env.GOOGLE_AUTH_CLIENT_ID;

beforeEach(() => {
  const jwk = publicKey.export({ format: "jwk" });
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => "max-age=0" },
    json: async () => ({
      keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }],
    }),
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalClientId === undefined) {
    delete process.env.GOOGLE_AUTH_CLIENT_ID;
  } else {
    process.env.GOOGLE_AUTH_CLIENT_ID = originalClientId;
  }
});

test("accepts a token whose aud matches the single configured client id", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = WEB_CLIENT_ID;
  const payload = await verifyGoogleIdentityToken(signToken());
  assert.equal(payload.sub, "google-sub-123");
});

test("accepts each entry of a comma-separated audience allowlist", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = `${WEB_CLIENT_ID}, ${IOS_CLIENT_ID}`;

  const webPayload = await verifyGoogleIdentityToken(signToken());
  assert.equal(webPayload.sub, "google-sub-123");

  const iosPayload = await verifyGoogleIdentityToken(
    signToken({ aud: IOS_CLIENT_ID })
  );
  assert.equal(iosPayload.sub, "google-sub-123");
});

test("rejects a token whose aud is not in the allowlist", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = `${WEB_CLIENT_ID},${IOS_CLIENT_ID}`;
  await assert.rejects(
    verifyGoogleIdentityToken(signToken({ aud: "attacker-client-id" })),
    (error) =>
      error instanceof GoogleIdentityTokenError &&
      /audience/.test(error.message)
  );
});

test("rejects when GOOGLE_AUTH_CLIENT_ID is empty or whitespace-only", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = " , ";
  await assert.rejects(
    verifyGoogleIdentityToken(signToken()),
    (error) =>
      error instanceof GoogleIdentityTokenError &&
      /GOOGLE_AUTH_CLIENT_ID/.test(error.message)
  );
});

test("rejects an expired token", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = WEB_CLIENT_ID;
  const nowInSeconds = Math.floor(Date.now() / 1000);
  await assert.rejects(
    verifyGoogleIdentityToken(signToken({ exp: nowInSeconds - 10 })),
    (error) =>
      error instanceof GoogleIdentityTokenError && /expired/.test(error.message)
  );
});

test("rejects a bad issuer", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = WEB_CLIENT_ID;
  await assert.rejects(
    verifyGoogleIdentityToken(signToken({ iss: "https://evil.example.com" })),
    (error) =>
      error instanceof GoogleIdentityTokenError && /issuer/.test(error.message)
  );
});

test("rejects a tampered signature", async () => {
  process.env.GOOGLE_AUTH_CLIENT_ID = WEB_CLIENT_ID;
  const token = signToken();
  const [header, payload] = token.split(".");
  const forged = `${header}.${base64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: WEB_CLIENT_ID,
      sub: "someone-else",
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  )}.${token.split(".")[2]}`;
  await assert.rejects(
    verifyGoogleIdentityToken(forged),
    (error) =>
      error instanceof GoogleIdentityTokenError &&
      /signature/.test(error.message)
  );
});
