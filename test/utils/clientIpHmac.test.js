const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { hmacClientIpHashes } = require("../../src/shared/lib/clientIp");

function request(ip) {
  return { headers: { "x-forwarded-for": ip }, socket: {} };
}

describe("referral IP HMAC writer", () => {
  it("writes versioned deterministic exact and network hashes without raw IP", () => {
    const env = {
      REFERRAL_IP_HMAC_ACTIVE_VERSION: "3",
      REFERRAL_IP_HMAC_SECRET_V3: "a sufficiently long test secret for version three",
    };
    const first = hmacClientIpHashes(request("203.0.113.42"), { env });
    const second = hmacClientIpHashes(request("203.0.113.42"), { env });
    assert.deepEqual(first, second);
    assert.equal(first.version, 3);
    assert.match(first.ipHash, /^[0-9a-f]{64}$/);
    assert.match(first.ipNetHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(first).includes("203.0.113.42"), false);
  });

  it("returns all-null hash/version state when configuration is missing", () => {
    assert.deepEqual(hmacClientIpHashes(request("203.0.113.42"), { env: {} }), {
      ipHash: null,
      ipNetHash: null,
      version: null,
    });
  });

  it("canonicalizes equivalent IPv6 spellings before HMAC", () => {
    const env = {
      REFERRAL_IP_HMAC_ACTIVE_VERSION: "1",
      REFERRAL_IP_HMAC_SECRET_V1: "another sufficiently long test hmac secret",
    };
    assert.deepEqual(
      hmacClientIpHashes(request("2600:1:2:3::4"), { env }),
      hmacClientIpHashes(request("2600:0001:0002:0003:0:0:0:4"), { env })
    );
  });
});
