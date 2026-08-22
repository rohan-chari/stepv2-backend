// Phase A of the Redis derived-data layer (docs/redis-derived-data-layer-requirements.md
// §5 Phase A, steps 2-3): the cache wrapper + the additive `/health` redis field.
//
// Scope note (deliberate deviation from "always go through the endpoint"):
// Phase A ships NO cache surface, so the wrapper has no public HTTP path yet.
// The wrapper cases below therefore drive `redisCache` directly against a REAL
// local Redis; the `/health` cases go through the real HTTP server. Once a
// surface exists (Phase B+), its tests go through its endpoint.
const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const IORedis = require("ioredis");

const { startTestRedis, closedPort } = require("./redisTestServer");
const { startServer, request } = require("./setup");

const ENV_PREFIX = "t:";
const FOREIGN_PREFIX = "x:";
const CHANNEL = `${ENV_PREFIX}cache:invalidate`;

process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

// Lazy wrapper: requiring it must not connect to anything.
const cache = require("../../src/shared/cache/redisCache");

let live = null; // { url, close }
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

describe("redisCache — REDIS_URL unset is fully inert", () => {
  before(async () => {
    delete process.env.REDIS_URL;
    await cache.close();
  });

  it("reports disabled and never constructs a client", async () => {
    assert.equal(cache.isEnabled(), false);
    assert.equal(cache.diagnostics().clientCreated, false);
    assert.equal(cache.diagnostics().subscriberCreated, false);
  });

  it("reads return null and writes/invalidates are no-ops", async () => {
    assert.equal(await cache.getJSON("v1:catalog:shop"), null);
    assert.equal(await cache.setJSON("v1:catalog:shop", { a: 1 }, 60), false);
    assert.equal(await cache.del("v1:catalog:shop"), false);
    assert.equal(await cache.publishInvalidate("v1:catalog:shop"), false);
  });

  it("withLock never runs the critical section and returns null", async () => {
    let ran = false;
    const result = await cache.withLock("v1:lock:progress:1", 5000, async () => {
      ran = true;
      return "computed";
    });
    assert.equal(result, null);
    assert.equal(ran, false);
  });

  it("subscribe is a no-op returning an unsubscribe function", async () => {
    const unsubscribe = await cache.subscribe(() => {
      throw new Error("handler must never fire while disabled");
    });
    assert.equal(typeof unsubscribe, "function");
    await unsubscribe();
    assert.equal(cache.diagnostics().subscriberCreated, false);
  });

  it("still made no connection attempt", () => {
    assert.equal(cache.diagnostics().clientCreated, false);
  });
});

describe("redisCache — unreachable Redis degrades, never throws", () => {
  before(async () => {
    const port = await closedPort();
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/15`;
    await cache.close();
  });

  after(async () => {
    await cache.close();
    delete process.env.REDIS_URL;
  });

  it("returns null/false quickly for every operation", async () => {
    const startedAt = Date.now();
    assert.equal(await cache.getJSON("v1:catalog:shop"), null);
    assert.equal(await cache.setJSON("v1:catalog:shop", { a: 1 }, 60), false);
    assert.equal(await cache.del("v1:catalog:shop"), false);
    assert.equal(await cache.publishInvalidate("v1:catalog:shop"), false);
    let ran = false;
    assert.equal(
      await cache.withLock("v1:lock:progress:1", 5000, async () => {
        ran = true;
        return "computed";
      }),
      null
    );
    assert.equal(ran, false);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5000, `operations took ${elapsed}ms, expected < 5000ms`);
  });

  it("subscribe does not throw when the server is unreachable", async () => {
    const unsubscribe = await cache.subscribe(() => {});
    assert.equal(typeof unsubscribe, "function");
    await unsubscribe();
  });
});

describe("redisCache — live Redis", () => {
  it("getJSON/setJSON/del round-trip under the env key prefix", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      assert.equal(cache.isEnabled(), true);
      assert.equal(await cache.getJSON("v1:catalog:shop"), null);

      const payload = { items: [{ sku: "hat", price: 75 }], version: 1 };
      assert.equal(await cache.setJSON("v1:catalog:shop", payload, 60), true);

      assert.deepEqual(await cache.getJSON("v1:catalog:shop"), payload);
      // Stored under the env-namespaced key, never the bare one.
      assert.ok(await probe.exists(`${ENV_PREFIX}v1:catalog:shop`));
      assert.equal(await probe.exists("v1:catalog:shop"), 0);

      const ttl = await probe.pttl(`${ENV_PREFIX}v1:catalog:shop`);
      assert.ok(ttl > 0 && ttl <= 60000, `unexpected pttl ${ttl}`);

      assert.equal(await cache.del("v1:catalog:shop"), true);
      assert.equal(await cache.getJSON("v1:catalog:shop"), null);
    });
  });

  it("honours the TTL by actually expiring the key", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      await cache.setJSON("v1:settings:app", { flag: true }, 1);
      assert.deepEqual(await cache.getJSON("v1:settings:app"), { flag: true });
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(await cache.getJSON("v1:settings:app"), null);
    });
  });

  it("setJSON without a ttl stores a persistent key", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      await cache.setJSON("v1:balance", { v: 1 });
      assert.equal(await probe.pttl(`${ENV_PREFIX}v1:balance`), -1);
    });
  });

  it("withLock gives exactly one concurrent caller the critical section", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      let running = 0;
      let maxConcurrent = 0;
      let runs = 0;
      const critical = async () => {
        running += 1;
        runs += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 300));
        running -= 1;
        return "snapshot";
      };

      const startedAt = Date.now();
      const [a, b] = await Promise.all([
        cache.withLock("v1:lock:progress:42", 10000, critical),
        cache.withLock("v1:lock:progress:42", 10000, critical),
      ]);

      const winners = [a, b].filter((r) => r === "snapshot");
      const losers = [a, b].filter((r) => r === null);
      assert.equal(winners.length, 1, "exactly one caller must win the lock");
      assert.equal(losers.length, 1, "the loser must receive null");
      assert.equal(runs, 1, "the critical section must run exactly once");
      assert.equal(maxConcurrent, 1);

      // The loser must not have waited on the winner (no PG work, no blocking).
      // Both settle together here, so assert the loser resolved without adding
      // its own recompute: total wall time ~= one critical section.
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 900, `withLock pair took ${elapsed}ms`);
    });
  });

  it("renews a long critical section so a second owner cannot start after TTL", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      const first = cache.withLock("v1:lock:renew", 150, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "first";
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await cache.withLock(
        "v1:lock:renew",
        150,
        async () => "second"
      );

      assert.equal(second, null, "the renewed lease must remain owned");
      assert.equal(await first, "first");
    });
  });

  it("releases the lock after the critical section and only its own token", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const key = "v1:lock:progress:7";
      assert.equal(await cache.withLock(key, 5000, async () => "first"), "first");
      assert.equal(await probe.exists(`${ENV_PREFIX}${key}`), 0);
      assert.equal(await cache.withLock(key, 5000, async () => "second"), "second");
    });
  });

  it("propagates critical-section errors and still releases the lock", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const key = "v1:lock:progress:9";
      await assert.rejects(
        cache.withLock(key, 5000, async () => {
          throw new Error("boom");
        }),
        /boom/
      );
      assert.equal(await probe.exists(`${ENV_PREFIX}${key}`), 0);
    });
  });

  it("pub/sub invalidate round-trips on the env-namespaced channel", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const received = [];
      const unsubscribe = await cache.subscribe((message) => {
        received.push(message);
      });
      assert.equal(cache.diagnostics().subscriberCreated, true);

      assert.equal(await cache.publishInvalidate("v1:catalog:shop"), true);
      assert.equal(await cache.publishInvalidate({ prefix: "v1:user:" }), true);

      await waitFor(() => received.length >= 2, 3000);

      assert.deepEqual(
        received.map((m) => m.key || m.prefix),
        ["v1:catalog:shop", "v1:user:"]
      );
      // Keys are handed to handlers WITHOUT the env prefix.
      assert.ok(!String(received[0].key).startsWith(ENV_PREFIX));

      // Belt and braces: a message for another environment on this channel is
      // rejected outright (Redis pub/sub is not isolated by logical DB).
      await probe.publish(
        CHANNEL,
        JSON.stringify({ key: `${FOREIGN_PREFIX}v1:catalog:shop` })
      );
      await probe.publish(
        CHANNEL,
        JSON.stringify({ key: `${ENV_PREFIX}v1:settings:app` })
      );
      await waitFor(() => received.length >= 3, 3000);
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(received.length, 3, "foreign-prefix message must be dropped");
      assert.equal(received[2].key, "v1:settings:app");

      await unsubscribe();
    });
  });

  it("publishes on the env channel only", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async (probe) => {
      const seen = [];
      const listener = new IORedis(live.url);
      await listener.subscribe(CHANNEL, `${FOREIGN_PREFIX}cache:invalidate`);
      listener.on("message", (channel) => seen.push(channel));

      await cache.publishInvalidate("v1:catalog:shop");
      await waitFor(() => seen.length >= 1, 3000);
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(seen, [CHANNEL]);
      await listener.quit().catch(() => {});
      void probe;
    });
  });

  it("invokes onReconnect when the subscriber connects", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      let reconnects = 0;
      const unsubscribe = await cache.subscribe(() => {}, {
        onReconnect: () => {
          reconnects += 1;
        },
      });
      await waitFor(() => reconnects >= 1, 3000);
      assert.ok(reconnects >= 1, "onReconnect must fire on (re)connect");
      await unsubscribe();
    });
  });
});

describe("GET /health redis field", () => {
  it('reports "disabled" when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    await cache.close();
    const server = await startServer();
    try {
      const res = await request(server.baseUrl, "GET", "/health");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "ok", "existing field is unchanged");
      assert.equal(body.redis, "disabled");
    } finally {
      await server.close();
    }
  });

  it('reports "ok" against a live Redis', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await withEnabledCache(async () => {
      const server = await startServer();
      try {
        const res = await request(server.baseUrl, "GET", "/health");
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, "ok");
        assert.equal(body.redis, "ok");
      } finally {
        await server.close();
      }
    });
  });

  it('reports "down" when Redis is unreachable', async () => {
    const port = await closedPort();
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/15`;
    await cache.close();
    const server = await startServer();
    try {
      const res = await request(server.baseUrl, "GET", "/health");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "ok");
      assert.equal(body.redis, "down");
    } finally {
      await server.close();
      await cache.close();
      delete process.env.REDIS_URL;
    }
  });
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}
