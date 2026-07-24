// §3.6.2 scheduler coverage: the cluster-safe zoomies materialization job
// (insert-first against the real @@unique([userId, localDayKey, slot]) key),
// the CAS notifiedAt push claim, and the retention job. Jobs have no HTTP
// surface, so — like step-sample-retention-cron.test.js — we drive the job
// builders directly against the real DB with injected clock/eventBus.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildMaterializeZoomies,
  buildCleanupCharacterEffectWindows,
} = require("../../src/modules/races/jobs/characterEffectScheduler");
const { CharacterEffectWindow } = require("../../src/modules/powerups/models/characterEffectWindow");

let server;
let nextAppleId = 0;

const quietLogger = { log: () => {}, error: () => {} };

async function createUser(displayName) {
  const appleId = `apple-zsch-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function seedCorgiUser(displayName, timezone) {
  const user = await createUser(displayName);
  if (timezone) {
    await prisma.user.update({ where: { id: user.userId }, data: { timezone } });
  }
  const item = await prisma.shopItem.create({
    data: {
      sku: `test_corgi_${nextAppleId}`,
      name: "Corgi",
      description: "corgi (test)",
      slot: "CHARACTER",
      priceCoins: 0,
      assetKey: "corgi_puppy",
      testOnly: false,
      renderMetadata: { offsetX: 0, offsetY: 0 },
    },
  });
  await prisma.userShopItem.create({
    data: { userId: user.userId, shopItemId: item.id },
  });
  await prisma.userEquippedAccessory.create({
    data: { userId: user.userId, slot: "CHARACTER", shopItemId: item.id },
  });
  return user;
}

function windowsFor(userId) {
  return prisma.characterEffectWindow.findMany({
    where: { userId },
    orderBy: { slot: "asc" },
  });
}

describe("character effect scheduler (zoomies materialization + retention)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    // job_runs is not in the shared truncation list; clear our claim so the
    // retention test is hermetic across repeated runs on the same day.
    await prisma.jobRun.deleteMany({
      where: { jobName: "character_effect_window_retention" },
    });
    nextAppleId = 0;
    process.env.CHARACTER_POWERS_ENABLED = "true";
    delete process.env.ZOOMIES_PUSH_DISABLED;
  });

  afterEach(() => {
    delete process.env.CHARACTER_POWERS_ENABLED;
    delete process.env.ZOOMIES_PUSH_DISABLED;
  });

  it("materializes exactly two windows per corgi user and is idempotent across repeated ticks", async () => {
    const corgi = await seedCorgiUser("ZoomCorgi", "America/New_York");
    const walker = await createUser("PlainCapy");

    const run = buildMaterializeZoomies({ logger: quietLogger });
    const first = await run();
    assert.equal(first.corgiUsers, 1);

    const afterFirst = await windowsFor(corgi.userId);
    assert.equal(afterFirst.length, 2, "exactly two windows for the corgi");
    assert.deepEqual(afterFirst.map((w) => w.slot), [0, 1]);
    for (const w of afterFirst) {
      assert.equal(w.endsAt.getTime() - w.startsAt.getTime(), 10 * 60 * 1000);
      assert.equal(Number(w.multiplier), 3);
    }
    assert.ok(
      afterFirst[1].startsAt.getTime() - afterFirst[0].startsAt.getTime() >= 2 * 60 * 60 * 1000,
      "windows are at least 2h apart"
    );

    // Second and third ticks: the real unique key swallows re-inserts.
    await run();
    await run();
    const afterThird = await windowsFor(corgi.userId);
    assert.equal(afterThird.length, 2, "repeat ticks add no duplicate windows");
    assert.deepEqual(
      afterThird.map((w) => w.startsAt.getTime()),
      afterFirst.map((w) => w.startsAt.getTime()),
      "window times are stable across ticks"
    );

    assert.equal((await windowsFor(walker.userId)).length, 0, "non-corgi gets none");
  });

  it("no-ops entirely when CHARACTER_POWERS_ENABLED is off", async () => {
    const corgi = await seedCorgiUser("DarkCorgi", "America/New_York");
    delete process.env.CHARACTER_POWERS_ENABLED;

    const run = buildMaterializeZoomies({ logger: quietLogger });
    assert.equal(await run(), null);
    assert.equal((await windowsFor(corgi.userId)).length, 0);
  });

  it("push fires exactly once per live window via the CAS notifiedAt claim, and respects ZOOMIES_PUSH_DISABLED", async () => {
    const corgi = await seedCorgiUser("PushCorgi", "America/New_York");
    const emitted = [];
    const bus = { emit: (name, payload) => emitted.push({ name, payload }) };
    const run = buildMaterializeZoomies({ logger: quietLogger, eventBus: bus });

    await run();
    // Shift the scheduler's own slot-0 window so it is live right now.
    const now = new Date();
    const [w0] = await windowsFor(corgi.userId);
    await prisma.characterEffectWindow.update({
      where: { id: w0.id },
      data: {
        startsAt: new Date(now.getTime() - 60 * 1000),
        endsAt: new Date(now.getTime() + 9 * 60 * 1000),
      },
    });

    await run();
    await run(); // second tick must not double-send
    const zoomStarts = emitted.filter((e) => e.name === "ZOOMIES_STARTED");
    assert.equal(zoomStarts.length, 1, "CAS claim sends exactly one push");
    assert.equal(zoomStarts[0].payload.userId, corgi.userId);

    const claimed = await prisma.characterEffectWindow.findUnique({ where: { id: w0.id } });
    assert.ok(claimed.notifiedAt, "notifiedAt is stamped by the claim");

    // A second live window with the kill switch on: no emit, no claim.
    process.env.ZOOMIES_PUSH_DISABLED = "true";
    const [, w1] = await windowsFor(corgi.userId);
    await prisma.characterEffectWindow.update({
      where: { id: w1.id },
      data: {
        startsAt: new Date(now.getTime() - 60 * 1000),
        endsAt: new Date(now.getTime() + 9 * 60 * 1000),
      },
    });
    await run();
    assert.equal(
      emitted.filter((e) => e.name === "ZOOMIES_STARTED").length,
      1,
      "kill switch suppresses the push"
    );
    const unclaimed = await prisma.characterEffectWindow.findUnique({ where: { id: w1.id } });
    assert.equal(unclaimed.notifiedAt, null, "kill switch leaves the claim untouched");
  });

  it("retention deletes only windows ended before the 45-day cutoff and runs once per day", async () => {
    const corgi = await seedCorgiUser("OldCorgi", "America/New_York");
    const now = new Date();
    const old = await CharacterEffectWindow.createIfAbsent({
      userId: corgi.userId,
      animal: "corgi",
      multiplier: 3,
      startsAt: new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000),
      endsAt: new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000),
      localDayKey: "2026-06-04",
      slot: 0,
    });
    const fresh = await CharacterEffectWindow.createIfAbsent({
      userId: corgi.userId,
      animal: "corgi",
      multiplier: 3,
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() - 50 * 60 * 1000),
      localDayKey: "2026-07-24",
      slot: 0,
    });

    const cleanup = buildCleanupCharacterEffectWindows({
      logger: quietLogger,
      targetHour: 0, // any wall-clock time qualifies for today's run
    });
    const result = await cleanup();
    assert.ok(result, "first daily run executes");
    assert.equal(result.count, 1, "exactly the 50-day-old window is deleted");

    const remaining = await windowsFor(corgi.userId);
    assert.deepEqual(remaining.map((w) => w.id), [fresh.id]);
    assert.ok(!remaining.some((w) => w.id === old.id));

    // Same day, second tick: JobRun claim dedups to a no-op.
    assert.equal(await cleanup(), null, "second run the same day is a no-op");
  });
});
