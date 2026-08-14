const assert = require("node:assert/strict");
const test = require("node:test");
const keys = require("../../src/shared/cache/cacheKeys");

test("social ranking keys normalize boundaries and isolate epochs/viewers", () => {
  assert.equal(
    keys.leaderboardGlobal({ eligibilityEpoch: 4, period: "today", boundary: "2026-08-13" }),
    "v1:leaderboard:steps:global:4:today:2026-08-13"
  );
  assert.equal(
    keys.leaderboardGlobal({ eligibilityEpoch: 4, period: "allTime", boundary: "all" }),
    "v1:leaderboard:steps:global:4:allTime:all"
  );
  assert.throws(() => keys.leaderboardGlobal({
    eligibilityEpoch: 4, period: "today", boundary: "America/New_York",
  }));
  assert.throws(() => keys.leaderboardGlobal({
    eligibilityEpoch: 4, period: "allTime", boundary: "2026-08-13",
  }));
  const hash = keys.acceptedFriendSetHash(["b", "a", "a"]);
  assert.equal(hash, keys.acceptedFriendSetHash(["a", "b"]));
  assert.match(keys.leaderboardFriends({
    viewerId: "viewer", eligibilityEpoch: 2, acceptedSetHash: hash,
    period: "week", boundary: "2026-08-10",
  }), /^v1:leaderboard:steps:friends:viewer:2:[a-f0-9]{64}:week:2026-08-10$/);
});

test("search rate key accepts only user and UTC minute, never raw query text", () => {
  const key = keys.friendSearchRate("user-1", 123456);
  assert.equal(key, "v1:user:friendsearchrate:user-1:123456");
  assert.equal(key.includes("river"), false);
  assert.throws(() => keys.friendSearchRate("user-1", "river"));
  assert.throws(() => keys.friendSearchRate("", 123456));
});

test("leaderboard lock hashes the raw key", () => {
  const lock = keys.leaderboardLock("v1:leaderboard:steps:global:0:today:2026-08-13");
  assert.match(lock, /^v1:lock:leaderboard:[a-f0-9]{64}$/);
  assert.equal(lock.includes("2026-08-13"), false);
});
