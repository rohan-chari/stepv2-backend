const test = require("node:test");
const assert = require("node:assert/strict");

const { networkPrefix, hashClientNet } = require("../../src/shared/lib/clientIp");

// Pure address math for tier 2 of the referral IP fallback. The behaviour that
// MATTERS is covered end-to-end in
// test/integration/referral_attribution_fallback.test.js (same-/24, same-/64
// mixed forms, v4-mapped, different-/24, null-hash skip); this file exists only
// because the case matrix — two IPv6 spellings, two v4-mapped spellings, zone
// ids, brackets, the ::/64 sink — is far denser than it is sensible to drive
// through HTTP one request at a time.
//
// The single invariant everything below serves: two spellings of the SAME
// network must produce the SAME string, and anything unparseable must produce
// null (never a value that could be used as a match key).

test("IPv4 collapses to its /24", () => {
  assert.equal(networkPrefix("203.0.113.7"), "203.0.113.0/24");
  assert.equal(networkPrefix("203.0.113.250"), "203.0.113.0/24");
  assert.equal(networkPrefix("203.0.113.0"), "203.0.113.0/24");
});

test("different /24s do not collide", () => {
  assert.notEqual(networkPrefix("203.0.113.7"), networkPrefix("203.0.114.7"));
  assert.notEqual(networkPrefix("203.0.113.7"), networkPrefix("198.51.100.7"));
});

test("IPv6 collapses to its /64, compressed and expanded forms agreeing", () => {
  const compressed = networkPrefix("2600:1:2:3::1");
  const expanded = networkPrefix("2600:0001:0002:0003:0000:0000:0000:0001");
  const otherHost = networkPrefix("2600:1:2:3:aaaa:bbbb:cccc:dddd");

  assert.equal(compressed, "2600:0001:0002:0003::/64");
  assert.equal(expanded, compressed, "expanded form must hash identically");
  assert.equal(otherHost, compressed, "the host half must not affect the /64");
});

test("IPv6 is case-insensitive", () => {
  assert.equal(networkPrefix("2600:ABCD::1"), networkPrefix("2600:abcd::1"));
});

test("a different /64 on the same /48 does not collide", () => {
  assert.notEqual(networkPrefix("2600:1:2:3::1"), networkPrefix("2600:1:2:4::1"));
});

test("IPv4-mapped IPv6 normalizes to the v4 /24 in BOTH spellings", () => {
  // The dotted form is what nginx/Node usually emit...
  assert.equal(networkPrefix("::ffff:203.0.113.7"), "203.0.113.0/24");
  // ...but the hex form (cb.00.71.07 == 203.0.113.7) is the same address and
  // must not degrade into a ::/64.
  assert.equal(networkPrefix("::ffff:cb00:7107"), "203.0.113.0/24");
  assert.equal(
    networkPrefix("::ffff:203.0.113.7"),
    networkPrefix("::ffff:cb00:7107"),
    "both spellings of one v4-mapped address must agree"
  );
  // And it must agree with the plain IPv4 client it actually is.
  assert.equal(networkPrefix("::ffff:203.0.113.7"), networkPrefix("203.0.113.7"));
});

test("addresses inside ::/64 are REFUSED rather than bucketed together", () => {
  // Loopback, unspecified and legacy IPv4-compatible forms all share a
  // first-four-hextets-zero prefix. Emitting one hash for that set would make
  // it an attribution key standing for unrelated clients.
  assert.equal(networkPrefix("::1"), null);
  assert.equal(networkPrefix("::"), null);
  assert.equal(networkPrefix("::203.0.113.7"), null);
});

test("brackets and zone ids are stripped before parsing", () => {
  assert.equal(networkPrefix("[2600:1:2:3::1]"), "2600:0001:0002:0003::/64");
  assert.equal(networkPrefix("2600:1:2:3::1%en0"), "2600:0001:0002:0003::/64");
});

test("unparseable input yields null, never a usable key", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "   ",
    "not-an-ip",
    "203.0.113",
    "203.0.113.7.9",
    "999.0.113.7",
    "2600:1:2:3::1::9", // two "::" runs
    "gggg::1",
    "203.0.113.7:8080", // host:port is not an address
  ]) {
    assert.equal(networkPrefix(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("hashClientNet hashes the prefix, and is null when there is no prefix", () => {
  const hashOf = (ip) => hashClientNet({ headers: { "x-forwarded-for": ip }, socket: {} });

  const a = hashOf("203.0.113.7");
  assert.match(a, /^[0-9a-f]{64}$/, "a SHA-256 hex digest");
  // Same network, different host -> same hash. That IS the tier.
  assert.equal(a, hashOf("203.0.113.200"));
  assert.notEqual(a, hashOf("198.51.100.7"));
  // The raw prefix must never be recoverable as the stored value.
  assert.notEqual(a, "203.0.113.0/24");

  assert.equal(hashOf("not-an-ip"), null);
  assert.equal(hashClientNet({ headers: {}, socket: {} }), null);
});

test("the first X-Forwarded-For entry wins, matching hashClientIp", () => {
  // nginx appends later hops; the client is the first entry. Tier 2 must
  // resolve the same address tier 1 does or the two tiers would disagree.
  const hash = hashClientNet({
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 172.16.0.1" },
    socket: { remoteAddress: "10.0.0.1" },
  });
  const direct = hashClientNet({
    headers: { "x-forwarded-for": "203.0.113.9" },
    socket: {},
  });
  assert.equal(hash, direct);
});
