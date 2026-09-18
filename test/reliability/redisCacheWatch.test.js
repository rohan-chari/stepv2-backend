// Tests for the ADDITIVE Phase C helpers on the Phase A wrapper: `evalLua` and
// `withWatch` (spec §3 key table's msgver row, §5 Phase C).
//
// Deliberately a NEW file rather than an addition to redisCache.test.js — the
// Phase A suite is existing work and must not be modified.
//
// Scope note, same as the Phase A suite: these helpers have no HTTP surface of
// their own (the surface that uses them is covered end-to-end in
// redis-cache-c2-chat.test.js). What is proven here is the wrapper contract the
// chat cache depends on — in particular that a WATCHed key touched by ANY other
// connection aborts the EXEC, including the nil -> set -> nil ABA case that a
// value-comparison CAS would wrongly pass.
const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const IORedis = require("ioredis");

const { startTestRedis } = require("./redisTestServer");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const cache = require("../../src/shared/cache/redisCache");

let live = null;
let skipReason = null;

before(async () => {
  live = await startTestRedis();
  if (!live) {
    skipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  await cache.close();
  if (live) await live.close();
});

async function withEnabledCache(fn) {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  const probe = new IORedis(live.url);
  await probe.flushdb();
  try {
    return await fn(probe);
  } finally {
    await probe.quit().catch(() => {});
    await cache.close();
    delete process.env.REDIS_URL;
  }
}

describe("redisCache.evalLua / withWatch — inert with REDIS_URL unset", () => {
  before(async () => {
    delete process.env.REDIS_URL;
    await cache.close();
  });

  it("evalLua reports disabled, never throws, constructs no client", async () => {
    const result = await cache.evalLua('return redis.call("set", KEYS[1], "x")', [
      "v1:probe",
    ]);
    assert.deepEqual(result, { ok: false, disabled: true, result: null });
    assert.equal(cache.diagnostics().clientCreated, false);
  });

  it("withWatch reports disabled and never runs the critical section", async () => {
    let ran = false;
    const result = await cache.withWatch(["v1:probe"], async () => {
      ran = true;
      return { sets: [{ key: "v1:probe", value: 1 }] };
    });
    assert.equal(ran, false);
    assert.equal(result.disabled, true);
    assert.equal(result.installed, false);
    assert.equal(cache.diagnostics().clientCreated, false);
  });
});

describe("redisCache.evalLua — live", () => {
  it("runs a script atomically with env-prefixed KEYS and verbatim ARGV", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      await probe.set(`${ENV_PREFIX}v1:list`, "stale");
      const result = await cache.evalLua(
        `redis.call("set", KEYS[1], ARGV[1])
         redis.call("del", KEYS[2])
         return 1`,
        ["v1:ver", "v1:list"],
        ["marker-7"]
      );
      assert.equal(result.ok, true);
      assert.equal(result.disabled, false);
      assert.equal(result.result, 1);
      // KEYS are prefixed for the caller...
      assert.equal(await probe.get(`${ENV_PREFIX}v1:ver`), "marker-7");
      assert.equal(await probe.get(`${ENV_PREFIX}v1:list`), null);
      // ...and nothing was written outside the env namespace.
      assert.equal(await probe.get("v1:ver"), null);
    });
  });

  it("a script error is swallowed and reported as a non-disabled failure", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      const result = await cache.evalLua("this is not lua", ["v1:x"]);
      // ok:false + disabled:false is precisely the signal that opens the
      // per-prefix read-bypass breaker (§3 "Failed invalidation").
      assert.deepEqual(result, { ok: false, disabled: false, result: null });
    });
  });
});

describe("redisCache.withWatch — live", () => {
  it("installs the sets when no watched key was touched", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const result = await cache.withWatch(["v1:ver"], async (ctx) => {
        assert.equal(await ctx.get("v1:ver"), null);
        return {
          sets: [
            { key: "v1:list", value: { rows: [1, 2] }, ttlSeconds: 60 },
            { key: "v1:ver", value: "m1" },
          ],
        };
      });
      assert.equal(result.installed, true);
      assert.equal(result.aborted, false);
      assert.deepEqual(await cache.getJSON("v1:list"), { rows: [1, 2] });
      assert.equal(await cache.getJSON("v1:ver"), "m1");
      // The TTL was applied to the one that asked for it, and not the other.
      assert.ok((await probe.ttl(`${ENV_PREFIX}v1:list`)) > 0);
      assert.equal(await probe.ttl(`${ENV_PREFIX}v1:ver`), -1);
    });
  });

  it("ctx.get reads through the watched connection and parses JSON", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      await cache.setJSON("v1:ver", "existing");
      let seen = "unset";
      await cache.withWatch(["v1:ver"], async (ctx) => {
        seen = await ctx.get("v1:ver");
        return null;
      });
      assert.equal(seen, "existing");
    });
  });

  it("returning null/empty cancels: UNWATCH, nothing written", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const result = await cache.withWatch(["v1:ver"], async () => null);
      assert.equal(result.cancelled, true);
      assert.equal(result.installed, false);
      assert.deepEqual(await probe.keys(`${ENV_PREFIX}*`), []);
    });
  });

  it("ABORTS when another connection MODIFIES the watched key mid-flight", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const result = await cache.withWatch(["v1:ver"], async () => {
        // Simulates a concurrent post's atomic SET msgver + DEL list.
        await probe.set(`${ENV_PREFIX}v1:ver`, '"m2"');
        return { sets: [{ key: "v1:list", value: { rows: ["stale"] } }] };
      });
      assert.equal(result.aborted, true);
      assert.equal(result.installed, false);
      assert.equal(
        await probe.get(`${ENV_PREFIX}v1:list`),
        null,
        "the stale list must NOT have been installed"
      );
    });
  });

  it("ABORTS on the nil -> set -> deleted ABA that a value CAS would pass", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const result = await cache.withWatch(["v1:ver"], async (ctx) => {
        assert.equal(await ctx.get("v1:ver"), null);
        // The key ends back at exactly the value we read (absent). Comparing
        // values would conclude "nothing changed" and install a stale list;
        // WATCH must abort on the modification itself.
        await probe.set(`${ENV_PREFIX}v1:ver`, '"transient"');
        await probe.del(`${ENV_PREFIX}v1:ver`);
        assert.equal(await probe.get(`${ENV_PREFIX}v1:ver`), null);
        return { sets: [{ key: "v1:list", value: { rows: ["stale"] } }] };
      });
      assert.equal(
        result.aborted,
        true,
        "eviction-and-back-to-nil must still invalidate the transaction"
      );
      assert.equal(await probe.get(`${ENV_PREFIX}v1:list`), null);
    });
  });

  it("does not leak a connection per call", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const before = Number(
        (await probe.info("clients")).match(/connected_clients:(\d+)/)[1]
      );
      for (let i = 0; i < 12; i += 1) {
        await cache.withWatch(["v1:ver"], async () => ({
          sets: [{ key: `v1:list:${i}`, value: i }],
        }));
      }
      // Give the quits a moment to land server-side.
      await new Promise((r) => setTimeout(r, 250));
      const after = Number(
        (await probe.info("clients")).match(/connected_clients:(\d+)/)[1]
      );
      assert.ok(
        after <= before + 2,
        `withWatch leaked connections: ${before} -> ${after}`
      );
    });
  });

  it("an error thrown by the caller's fn propagates and still releases the connection", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const before = Number(
        (await probe.info("clients")).match(/connected_clients:(\d+)/)[1]
      );
      await assert.rejects(
        () =>
          cache.withWatch(["v1:ver"], async () => {
            throw new Error("caller exploded");
          }),
        /caller exploded/
      );
      await new Promise((r) => setTimeout(r, 250));
      const after = Number(
        (await probe.info("clients")).match(/connected_clients:(\d+)/)[1]
      );
      assert.ok(after <= before + 1, `connection leaked on throw: ${before} -> ${after}`);
    });
  });
});
