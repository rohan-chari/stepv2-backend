const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const {
  signHomeOpenFixtureToken,
} = require("../../../src/modules/loadTesting/homeOpenFixtures");

test("Home fixture tokens use the explicit isolated environment secret", () => {
  const secret = "isolated-capacity-secret";
  const previous = process.env.SESSION_TOKEN_SECRET;
  delete process.env.SESSION_TOKEN_SECRET;
  try {
    const token = signHomeOpenFixtureToken({
      userId: "capacity-user-id",
      appleId: "capacity-apple-id",
      env: { SESSION_TOKEN_SECRET: secret },
    });
    const payload = jwt.verify(token, secret, {
      issuer: "steps-tracker-api",
      algorithms: ["HS256"],
    });
    assert.equal(payload.sub, "capacity-user-id");
    assert.equal(payload.appleId, "capacity-apple-id");
  } finally {
    if (previous === undefined) delete process.env.SESSION_TOKEN_SECRET;
    else process.env.SESSION_TOKEN_SECRET = previous;
  }
});

test("Home fixture token generation fails closed without the isolated secret", () => {
  assert.throws(() => signHomeOpenFixtureToken({
    userId: "capacity-user-id",
    appleId: "capacity-apple-id",
    env: {},
  }), /isolated SESSION_TOKEN_SECRET/);
});
