// Phase C / C2 of the Redis derived-data layer
// (docs/redis-derived-data-layer-requirements.md §2 item 4-C2, §5 Phase C,
// §3 key table's `msgs`/`msgver` row, §8 tests 2, 3, 5c, 5g).
//
// `GET /races/:id/messages` is the #1 endpoint in prod (82k requests / 33% over
// 8 days, polled every 5s per viewer), so this is the surface the whole layer
// exists for. What is cached is the RAW message rows only; the per-sender
// presentation (display name, photo, cosmetics) hydrates at read time from
// `v1:user:cosmetics:{id}`, so an equip or a rename never has to touch a single
// message list.
//
// The load-bearing correctness property is the msgver protocol: a post does one
// atomic Lua `SET msgver <durableId>` + `DEL list`, and a cold rebuild installs
// under `WATCH msgver` on a dedicated connection. Tests 5g(a) and 5g(b) below
// are the two ways that can go wrong.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { startTestRedis } = require("./redisTestServer");
const { startRedisFailProxy } = require("./helpers/redisFailProxy");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const raceMessagesCache = require("../../src/modules/social/services/raceMessagesCache");
const { appSettings } = require("../../src/shared/config/appSettings");

const FEAT =
  "tournaments,characters,powerups2,powerups3,powerups4,powerups5,remote_assets";

let server;
let live = null;
let skipReason = null;
let probe = null;
let nextAppleId = 0;

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  if (!live) {
    skipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  raceMessagesCache.__setTestHooks({});
  await cache.close();
  derivedCache.reset();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

async function enableRedis(url = live.url) {
  process.env.REDIS_URL = url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
}

async function setFlag(value) {
  await prisma.appSetting.upsert({
    where: { key: "redisCacheMessagesEnabled" },
    update: { value },
    create: { key: "redisCacheMessagesEnabled", value },
  });
  appSettings.bustCache();
}

function authReq(method, p, { body, token } = {}) {
  return request(server.baseUrl, method, p, {
    body,
    token,
    headers: { "X-Client-Features": FEAT },
  });
}

async function createUser(displayName) {
  const appleId = `apple-c2-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
}

/** A started race with two ACCEPTED participants, plus a cosmetic each. */
async function seedRace(host, guest) {
  const race = await prisma.race.create({
    data: {
      creatorId: host.userId,
      name: "C2 Race",
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 60 * 60 * 1000),
      targetSteps: 10000,
      timeBased: true,
      powerupsEnabled: true,
    },
  });
  for (const u of [host, guest]) {
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: u.userId, status: "ACCEPTED" },
    });
  }
  return race;
}

async function seedCosmetic(userId, sku) {
  const item = await prisma.shopItem.upsert({
    where: { sku },
    update: {},
    create: {
      sku,
      name: sku,
      description: "d",
      slot: "HEAD",
      priceCoins: 75,
      assetKey: sku,
      active: true,
      testOnly: false,
    },
  });
  await prisma.userShopItem.upsert({
    where: { userId_shopItemId: { userId, shopItemId: item.id } },
    update: {},
    create: { userId, shopItemId: item.id },
  });
  return item;
}

// NOTE: the failure message must not be built eagerly — `await res.text()`
// consumes the body, so reading it up front breaks the happy path.
async function expectStatus(res, expected) {
  if (res.status !== expected) {
    assert.fail(`expected ${expected}, got ${res.status}: ${await res.text()}`);
  }
}

async function messages(token, raceId, query = "?kind=USER") {
  const res = await authReq("GET", `/races/${raceId}/messages${query}`, {
    token,
  });
  await expectStatus(res, 200);
  return res.json();
}

async function post(token, raceId, body) {
  const res = await authReq("POST", `/races/${raceId}/messages`, {
    token,
    body: { body },
  });
  await expectStatus(res, 201);
  return (await res.json()).message;
}

describe("C2 chat — §8 test 2 parity (cold cache ≡ flag off), both kinds", () => {
  let host;
  let guest;
  let race;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    host = await createUser("HostPerson");
    guest = await createUser("GuestPerson");
    race = await seedRace(host, guest);
  });

  it("USER and SYSTEM feeds are byte-identical cached vs uncached, with cosmetics equipped", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // A participant with equipped cosmetics — the case the spec calls out,
    // since sender presentation is what hydrates at read time.
    const hat = await seedCosmetic(host.userId, "c2-hat");
    await prisma.userEquippedAccessory.create({
      data: { userId: host.userId, slot: "HEAD", shopItemId: hat.id },
    });

    await disableRedis();
    await setFlag(false);
    await post(host.token, race.id, "hello from host");
    await post(guest.token, race.id, "hello from guest");
    // A SYSTEM row so the SYSTEM feed is non-empty.
    await prisma.racePowerupEvent.create({
      data: {
        raceId: race.id,
        actorUserId: guest.userId,
        targetUserId: host.userId,
        eventType: "POWERUP_USED",
        powerupType: "LEG_CRAMP",
        description: "GuestPerson cramped HostPerson",
      },
    });

    const queries = ["?kind=USER", "?kind=SYSTEM", ""];
    const baseline = {};
    for (const q of queries) baseline[q] = await messages(host.token, race.id, q);

    await enableRedis();
    await setFlag(true);
    const cold = {};
    for (const q of queries) cold[q] = await messages(host.token, race.id, q);
    const warm = {};
    for (const q of queries) warm[q] = await messages(host.token, race.id, q);

    for (const q of queries) {
      assert.deepEqual(cold[q], baseline[q], `cold ≢ flag-off for "${q}"`);
      assert.deepEqual(warm[q], baseline[q], `warm ≢ flag-off for "${q}"`);
    }

    // Only the two default shapes may be cached. The merged feed (no `kind`)
    // must bypass entirely (spec §5 Phase C).
    const keys = await probe.keys(`${ENV_PREFIX}v1:race:msgs:*`);
    assert.equal(keys.length, 2, `expected exactly 2 list keys, got ${keys}`);
    assert.ok(keys.some((k) => k.endsWith(":USER")));
    assert.ok(keys.some((k) => k.endsWith(":SYSTEM")));
  });

  it("non-default query shapes bypass the cache entirely", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await setFlag(true);
    await post(host.token, race.id, "one");

    // limit != 50, a cursor, and the merged feed: none may install a key.
    await messages(host.token, race.id, "?kind=USER&limit=10");
    const first = await messages(host.token, race.id, "?kind=USER&limit=1");
    await messages(host.token, race.id, "");
    if (first.nextCursor) {
      await messages(
        host.token,
        race.id,
        `?kind=USER&cursor=${encodeURIComponent(first.nextCursor)}`
      );
    }
    const keys = await probe.keys(`${ENV_PREFIX}v1:race:msgs:*`);
    assert.deepEqual(keys, [], `non-default shapes must not cache, got ${keys}`);
  });

  it("the viewer-specific stealth redaction is applied per request, not cached", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await setFlag(true);

    const guestParticipant = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: guest.userId },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: guestParticipant.id,
        userId: guest.userId,
        type: "STEALTH_MODE",
        status: "USED",
        usedAt: new Date(),
        targetUserId: guest.userId,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: guestParticipant.id,
        targetUserId: guest.userId,
        sourceUserId: host.userId,
        powerupId: powerup.id,
        type: "STEALTH_MODE",
        startsAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        status: "ACTIVE",
      },
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: race.id,
        actorUserId: guest.userId,
        eventType: "POWERUP_USED",
        powerupType: "SHORTCUT",
        description: "GuestPerson took a shortcut",
      },
    });

    // The stealthed user sees their own name; the other viewer sees "???".
    // Both read the SAME cached raw row, so a redaction baked into the cache
    // would leak one viewer's view to the other.
    const asHost = await messages(host.token, race.id, "?kind=SYSTEM");
    const asGuest = await messages(guest.token, race.id, "?kind=SYSTEM");
    assert.ok(
      asHost.messages[0].body.includes("???"),
      `host should see redaction, got: ${asHost.messages[0].body}`
    );
    assert.ok(
      asGuest.messages[0].body.includes("GuestPerson"),
      `stealthed user should see their own name, got: ${asGuest.messages[0].body}`
    );
  });
});

describe("C2 chat — §8 test 3 invalidation", () => {
  let host;
  let guest;
  let race;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    host = await createUser("HostPerson");
    guest = await createUser("GuestPerson");
    race = await seedRace(host, guest);
    await enableRedis();
    await setFlag(true);
  });

  it("post message → the next read includes it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(host.token, race.id, "first");
    const before = await messages(host.token, race.id);
    assert.equal(before.messages.length, 1);

    await post(guest.token, race.id, "second");
    const after = await messages(host.token, race.id);
    assert.equal(after.messages.length, 2);
    assert.equal(after.messages[0].body, "second");
  });

  it("a rename/equip updates the chat sender payload on the next read without touching the message list", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(host.token, race.id, "hi");
    const before = await messages(guest.token, race.id);
    assert.equal(before.messages[0].senderName, "HostPerson");

    const listKeyBefore = await probe.get(
      `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
    );
    assert.ok(listKeyBefore, "the list should be cached at this point");

    // Equipping is the spec's named trigger for the per-user cosmetics cache.
    const hat = await seedCosmetic(host.userId, "c2-equip-hat");
    const equip = await authReq("PUT", "/shop/equipment/HEAD", {
      token: host.token,
      body: { itemId: hat.id },
    });
    assert.equal(equip.status, 200, await equip.text());

    // ...and a rename is the same invalidation seam, observable in the chat
    // payload (chat carries senderName, not cosmetics — see the report note).
    const renamed = await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName: "RenamedHost" },
      token: host.token,
    });
    assert.equal(renamed.status, 200, await renamed.text());

    const after = await messages(guest.token, race.id);
    assert.equal(after.messages[0].senderName, "RenamedHost");

    // The message list itself must NOT have been rewritten — that is the whole
    // point of hydrating presentation at read time (spec §3 key table).
    const listKeyAfter = await probe.get(
      `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
    );
    assert.equal(
      listKeyAfter,
      listKeyBefore,
      "an equip/rename must not invalidate or rewrite the cached message list"
    );
  });

  it("a membership change invalidates the cached lists", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(host.token, race.id, "hi");
    await messages(host.token, race.id);
    assert.ok(await probe.get(`${ENV_PREFIX}v1:race:msgs:${race.id}:USER`));

    // Kick rather than leave: `leaveRace` only applies to PENDING team-race
    // lobbies, while kick is valid on an ACTIVE race. Both run the same
    // membership invalidation seam.
    const kicked = await authReq(
      "DELETE",
      `/races/${race.id}/participants/${guest.userId}`,
      { token: host.token }
    );
    assert.ok(
      [200, 204].includes(kicked.status),
      `kick failed: ${kicked.status} ${await kicked.text()}`
    );

    assert.equal(
      await probe.get(`${ENV_PREFIX}v1:race:msgs:${race.id}:USER`),
      null,
      "a membership change must drop the cached lists (access context changed)"
    );
    assert.equal(
      await probe.get(`${ENV_PREFIX}v1:race:msgs:${race.id}:SYSTEM`),
      null,
      "both kinds must be dropped"
    );
  });

  it("deleting a message invalidates the cached list", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const msg = await post(host.token, race.id, "oops");
    assert.equal((await messages(host.token, race.id)).messages.length, 1);

    const del = await authReq(
      "DELETE",
      `/races/${race.id}/messages/${msg.id}`,
      { token: host.token }
    );
    assert.ok(
      [200, 204].includes(del.status),
      `delete failed: ${del.status} ${await del.text()}`
    );
    assert.equal((await messages(host.token, race.id)).messages.length, 0);
  });
});

describe("C2 chat — §8 test 5c: failed invalidation opens the read bypass", () => {
  it("a failed DEL/EVAL makes reads serve Postgres; the bypass closes only after a retried delete succeeds", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    const host = await createUser("HostPerson");
    const guest = await createUser("GuestPerson");
    const race = await seedRace(host, guest);

    const proxy = await startRedisFailProxy(live.url);
    try {
      await enableRedis(proxy.url);
      await setFlag(true);

      await post(host.token, race.id, "first");
      assert.equal((await messages(host.token, race.id)).messages.length, 1);
      const staleList = await probe.get(
        `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
      );
      assert.ok(staleList, "list must be warm before we break invalidation");

      // Break ONLY the invalidation commands. Reads keep working, so a stale
      // list is still sitting in Redis and would be served if the breaker
      // didn't open. That is what makes this test discriminating.
      proxy.arm(["EVAL", "EVALSHA", "DEL"]);
      await post(host.token, race.id, "second");

      const bypassed = await messages(host.token, race.id);
      assert.equal(
        bypassed.messages.length,
        2,
        "reads must bypass the (now stale) cache and serve Postgres"
      );
      assert.equal(bypassed.messages[0].body, "second");

      // Redis still holds the stale one-message list — proof the read above
      // came from Postgres, not from a cache that happened to be correct.
      const stillStale = await probe.get(
        `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
      );
      assert.equal(
        stillStale,
        staleList,
        "the DEL was supposed to have failed, leaving the stale list in place"
      );

      // Heal Redis: the background retry must land and close the bypass, after
      // which reads are cache-backed again (and correct).
      proxy.disarm();
      let healed = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await probe.get(
          `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
        );
        if (current === null) {
          healed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(healed, "the background retry never managed to delete the list");

      const afterHeal = await messages(host.token, race.id);
      assert.equal(afterHeal.messages.length, 2);
      // With the bypass closed, the read re-installs the list.
      let reinstalled = null;
      const deadline2 = Date.now() + 5000;
      while (Date.now() < deadline2) {
        reinstalled = await probe.get(
          `${ENV_PREFIX}v1:race:msgs:${race.id}:USER`
        );
        if (reinstalled) break;
        await messages(host.token, race.id);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        reinstalled,
        "after the bypass closes, reads must repopulate the cache again"
      );
    } finally {
      await disableRedis();
      await proxy.close();
    }
  });
});

describe("C2 chat — §8 test 5g: concurrent post vs cold rebuild (WATCH)", () => {
  let host;
  let guest;
  let race;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    host = await createUser("HostPerson");
    guest = await createUser("GuestPerson");
    race = await seedRace(host, guest);
    await enableRedis();
    await setFlag(true);
    raceMessagesCache.__setTestHooks({});
  });

  it("(a) a post committed mid-rebuild aborts the EXEC, and the next read has the message", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(host.token, race.id, "first");

    // Cold: nothing cached. Arm a hook that fires AFTER the rebuild's WATCH and
    // its Postgres read, but BEFORE the MULTI/EXEC — the exact window in which
    // a concurrent post would otherwise be overwritten by a stale install.
    await probe.flushdb();
    let fired = 0;
    const outcomes = [];
    raceMessagesCache.__setTestHooks({
      onInstallResult: (r) => outcomes.push(r),
      beforeInstall: async () => {
        if (fired > 0) return;
        fired += 1;
        await post(guest.token, race.id, "raced-in");
      },
    });

    const during = await messages(host.token, race.id);
    // The rebuild's own PG snapshot predates the raced-in post, so this response
    // may legitimately show 1 message — what must NOT happen is that snapshot
    // being installed and then served forever.
    assert.ok(during.messages.length >= 1);
    assert.deepEqual(
      outcomes,
      [{ installed: false, aborted: true }],
      `expected exactly one ABORTED install, got ${JSON.stringify(outcomes)}`
    );

    raceMessagesCache.__setTestHooks({});
    const after = await messages(host.token, race.id);
    assert.equal(after.messages.length, 2, "the raced-in post must be visible");
    assert.equal(after.messages[0].body, "raced-in");
  });

  it("(b) msgver evicted mid-rebuild ending back at nil STILL aborts the EXEC (the ABA case)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(host.token, race.id, "first");
    await probe.flushdb();

    const msgverKey = `${ENV_PREFIX}v1:race:msgver:${race.id}:USER`;
    let fired = 0;
    const outcomes = [];
    raceMessagesCache.__setTestHooks({
      onInstallResult: (r) => outcomes.push(r),
      beforeInstall: async () => {
        if (fired > 0) return;
        fired += 1;
        // nil -> set -> deleted. The value the rebuild read (nil) is also the
        // value it would find now, so a value-comparison CAS would WRONGLY
        // succeed here. WATCH must abort anyway.
        await probe.set(msgverKey, JSON.stringify("999:zzz"));
        await probe.del(msgverKey);
        assert.equal(await probe.get(msgverKey), null);
      },
    });

    await messages(host.token, race.id);
    assert.deepEqual(
      outcomes,
      [{ installed: false, aborted: true }],
      "an evicted-back-to-nil msgver must still abort the EXEC (WATCH, not CAS)"
    );
    // Nothing was installed.
    assert.equal(
      await probe.get(`${ENV_PREFIX}v1:race:msgs:${race.id}:USER`),
      null
    );

    raceMessagesCache.__setTestHooks({});
    const after = await messages(host.token, race.id);
    assert.equal(after.messages.length, 1);
  });
});

describe("C2 chat — zero behavior change when disabled", () => {
  let host;
  let guest;
  let race;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    host = await createUser("HostPerson");
    guest = await createUser("GuestPerson");
    race = await seedRace(host, guest);
  });

  it("REDIS_URL unset and flag ON: correct responses, no keys written", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await probe.flushdb();
    await disableRedis();
    await setFlag(true);

    await post(host.token, race.id, "a");
    await post(guest.token, race.id, "b");
    const body = await messages(host.token, race.id);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(await probe.keys(`${ENV_PREFIX}v1:*`), []);
  });

  it("flag OFF with Redis up: nothing is cached", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await setFlag(false);

    await post(host.token, race.id, "a");
    const body = await messages(host.token, race.id);
    assert.equal(body.messages.length, 1);
    assert.deepEqual(await probe.keys(`${ENV_PREFIX}v1:race:msgs:*`), []);
  });
});
