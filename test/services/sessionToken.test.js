const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || "test-secret";

const {
  signSessionToken,
  verifySessionToken,
  SessionTokenError,
} = require("../../src/services/sessionToken");

test("signSessionToken returns a JWT string", () => {
  const token = signSessionToken({ userId: "user-1", appleId: "apple-123" });
  assert.equal(typeof token, "string");

  const parts = token.split(".");
  assert.equal(parts.length, 3);
});

test("verifySessionToken returns payload for valid token", () => {
  const token = signSessionToken({ userId: "user-1", appleId: "apple-123" });
  const payload = verifySessionToken(token);

  assert.equal(payload.sub, "user-1");
  assert.equal(payload.appleId, "apple-123");
  assert.equal(payload.iss, "steps-tracker-api");
  assert.equal(typeof payload.exp, "number");
  assert.equal(typeof payload.iat, "number");
});

test("verifySessionToken rejects tampered token", () => {
  const token = signSessionToken({ userId: "user-1", appleId: "apple-123" });
  const tampered = token.slice(0, -5) + "XXXXX";

  assert.throws(() => verifySessionToken(tampered), SessionTokenError);
});

test("verifySessionToken rejects token with wrong secret", () => {
  // Sign with real secret, then temporarily change env and verify
  const token = signSessionToken({ userId: "user-1", appleId: "apple-123" });

  const originalSecret = process.env.SESSION_TOKEN_SECRET;
  process.env.SESSION_TOKEN_SECRET = "different-secret";

  try {
    assert.throws(() => verifySessionToken(token), SessionTokenError);
  } finally {
    process.env.SESSION_TOKEN_SECRET = originalSecret;
  }
});

test("signSessionToken includes correct claims", () => {
  const token = signSessionToken({ userId: "user-42", appleId: "apple-xyz" });
  const payload = verifySessionToken(token);

  assert.equal(payload.sub, "user-42");
  assert.equal(payload.appleId, "apple-xyz");
  assert.equal(payload.iss, "steps-tracker-api");

  // Expiry should be ~90 days from now
  const ninetyDaysInSeconds = 90 * 24 * 60 * 60;
  const expectedExp = Math.floor(Date.now() / 1000) + ninetyDaysInSeconds;
  assert.ok(Math.abs(payload.exp - expectedExp) < 5);
});
