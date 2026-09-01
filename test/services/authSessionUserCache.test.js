const test = require("node:test");
const assert = require("node:assert/strict");

const cache = require("../../src/modules/users/services/authSessionUserCache");

test("auth session user cache coalesces and reuses a launch burst", async () => {
  cache.clear();
  let reads = 0;
  const load = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: "burst-user", createdAt: new Date() };
  };
  const users = await Promise.all(Array.from({ length: 20 }, () =>
    cache.read("burst-user", load)));
  assert.equal(reads, 1);
  assert.equal(users.length, 20);
  assert.ok(users.every((user) => user === users[0]));
  assert.ok(users[0].createdAt instanceof Date);
});

test("auth session user cache batches different cold users into one model read", async () => {
  cache.clear();
  const batches = [];
  const loadMany = async (ids) => {
    batches.push([...ids]);
    return ids.map((userId) => ({ id: userId }));
  };
  const users = await Promise.all(Array.from({ length: 100 }, (_, index) => {
    const id = `cold-user-${index}`;
    return cache.read(
      id,
      async () => { throw new Error("individual loader should not run"); },
      loadMany,
    );
  }));

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 100);
  assert.deepEqual(users.map((user) => user.id), batches[0]);
});

test("auth session cache covers the complete bounded app-open request graph", () => {
  assert.equal(cache.TTL_MS, 60_000);
  assert.ok(cache.MAX_ENTRIES >= 10_000);
});

test("auth session user cache does not cache a missing account", async () => {
  cache.clear();
  let reads = 0;
  const load = async () => { reads += 1; return null; };
  assert.equal(await cache.read("missing-user", load), null);
  assert.equal(await cache.read("missing-user", load), null);
  assert.equal(reads, 2);
});

test("an auth-me invalidation evicts only the mutated user", async () => {
  cache.clear();
  let aReads = 0;
  let bReads = 0;
  const loadA = async () => ({ id: "user-a", revision: ++aReads });
  const loadB = async () => ({ id: "user-b", revision: ++bReads });
  await cache.read("user-a", loadA);
  await cache.read("user-b", loadB);

  cache.handleInvalidation({ key: "capacity:run:v1:user:authme:user-a:shell-v1:1" });

  assert.equal((await cache.read("user-a", loadA)).revision, 2);
  assert.equal((await cache.read("user-b", loadB)).revision, 1);
  assert.equal(aReads, 2);
  assert.equal(bReads, 1);
});

test("subscriber reconnect still clears every local auth entry", async () => {
  cache.clear();
  let reads = 0;
  const load = async () => ({ id: "user-a", revision: ++reads });
  await cache.read("user-a", load);
  cache.handleInvalidation();
  assert.equal((await cache.read("user-a", load)).revision, 2);
});

test("a same-process user mutation evicts the local auth entry immediately", async () => {
  cache.clear();
  let reads = 0;
  const load = async () => ({ id: "user-a", revision: ++reads });
  await cache.read("user-a", load);
  cache.invalidate("user-a");
  assert.equal((await cache.read("user-a", load)).revision, 2);
});

test("invalidation fences an already-running loader from repopulating stale state", async () => {
  cache.clear();
  let release;
  const staleLoad = new Promise((resolve) => { release = resolve; });
  const staleRead = cache.read("user-a", () => staleLoad);
  await new Promise((resolve) => setImmediate(resolve));
  cache.invalidate("user-a");
  release({ id: "user-a", revision: 1 });
  assert.equal((await staleRead).revision, 1);
  assert.equal((await cache.read("user-a", async () => ({ id: "user-a", revision: 2 }))).revision, 2);
});

test("peer invalidation fences an already-running loader", async () => {
  cache.clear();
  let release;
  const staleLoad = new Promise((resolve) => { release = resolve; });
  const staleRead = cache.read("user-a", () => staleLoad);
  await new Promise((resolve) => setImmediate(resolve));
  cache.handleInvalidation({ key: "v1:user:authme:user-a:shell-v1:1" });
  release({ id: "user-a", revision: 1 });
  await staleRead;
  assert.equal((await cache.read("user-a", async () => ({ id: "user-a", revision: 2 }))).revision, 2);
});

test("global reconnect fencing prevents an active loader from repopulating", async () => {
  cache.clear();
  let release;
  const staleRead = cache.read("user-a", () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  cache.handleInvalidation();
  release({ id: "user-a", revision: 1 });
  await staleRead;
  assert.equal((await cache.read("user-a", async () => ({ id: "user-a", revision: 2 }))).revision, 2);
});

test("global reconnect preserves queued cold-batch waiters and fences their cache write", async () => {
  cache.clear();
  let batchReads = 0;
  const loadMany = async (ids) => {
    batchReads += 1;
    return ids.map((id) => ({ id, revision: 1 }));
  };
  const pending = cache.read("user-a", async () => null, loadMany);
  cache.handleInvalidation();
  assert.equal((await pending).revision, 1);
  assert.equal(batchReads, 1);
  assert.equal((await cache.read("user-a", async () => ({ id: "user-a", revision: 2 }))).revision, 2);
});

for (const [label, invalidate] of [
  ["targeted invalidation", () => cache.invalidate("user-a")],
  ["global invalidation", () => cache.clear()],
]) {
  test(`${label} does not orphan either cold-batch reader`, async () => {
    cache.clear();
    let batchReads = 0;
    const loadMany = async (ids) => {
      batchReads += 1;
      return ids.map((id) => ({ id, revision: batchReads }));
    };
    const first = cache.read("user-a", async () => null, loadMany);
    invalidate();
    const second = cache.read("user-a", async () => null, loadMany);
    const [firstValue, secondValue] = await Promise.all([first, second]);
    assert.equal(firstValue.id, "user-a");
    assert.equal(secondValue.id, "user-a");
    assert.equal(batchReads, 1);
  });
}
