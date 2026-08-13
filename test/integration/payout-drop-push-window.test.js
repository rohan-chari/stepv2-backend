const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const { cleanDatabase, prisma, getSharedServer, createTestUser } = require("./setup");

const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");

// Batch 2026-08-10 item 3 — "Out of the payout" push: time gate + durable
// once-per-race cap.
//
// The push used to fire whenever the 5-minute placement cron saw a user cross
// below `paidPlaces` — 7am on a daily challenge with 17h left, off step totals
// that churn as devices sync. Now it fires only inside the final
// PAYOUT_DROP_WINDOW_HOURS (default 3) of a TIMED race, and at most once per
// user per race (durable `payout-drop:<raceId>:<userId>` Notification claim, so
// the cap survives restarts and the pm2 cluster).
//
// Everything below runs the REAL handler chain against the REAL test DB; only
// the APNs/FCM boundary and the device-token lookup are stubbed.

let server;
let seq = 0;

const HOUR_MS = 60 * 60 * 1000;

// An event bus whose emit AWAITS the handlers, so a test can assert straight
// after emitting (the production bus is fire-and-forget).
function awaitingBus() {
  const handlers = new Map();
  // The placement cron emits without awaiting, so every emit is also parked
  // here and drained by settle() — otherwise a handler's Notification write can
  // outlive the test and deadlock the next TRUNCATE.
  const pending = [];
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit(event, data) {
      const run = (async () => {
        for (const fn of handlers.get(event) || []) await fn(data);
      })();
      pending.push(run);
      return run;
    },
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

// One "pm2 worker": its own handler registration (and therefore its own
// in-memory placement-cooldown Map), sharing the one real database.
function worker() {
  const bus = awaitingBus();
  const alerts = [];
  const silent = [];
  const push = {
    async sendNotification(args) {
      alerts.push(args);
      return { success: true };
    },
    async sendSilentNotification(args) {
      silent.push(args);
      return { success: true };
    },
  };
  registerNotificationHandlers({
    eventBus: bus,
    apnsService: push,
    fcmService: push,
    DeviceToken: {
      async findByUserId(userId) {
        return [{ token: `tok-${userId}`, platform: "ios" }];
      },
      async deleteToken() {},
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  return { bus, alerts, silent, settle: () => bus.settle() };
}

async function makeUser() {
  const { user } = await createTestUser({
    appleId: `apple-payout-drop-${++seq}`,
    email: `payout-drop-${seq}@example.com`,
  });
  return user.id;
}

async function makeRace({ endsAt, potCoins = 0, name = "Daily" } = {}) {
  return prisma.race.create({
    data: {
      name,
      targetSteps: 0,
      status: "ACTIVE",
      isPublic: true,
      timeBased: endsAt != null,
      maxParticipants: 100,
      maxDurationDays: 1,
      timezone: "UTC",
      potCoins,
      startedAt: new Date(Date.now() - HOUR_MS),
      endsAt: endsAt ?? null,
    },
  });
}

// The payload the placement cron emits for a user crossing out of the money.
function dropChange(raceId, userId, overrides = {}) {
  return {
    raceId,
    raceName: "Daily",
    userId,
    previousPlacement: 3,
    placement: 4,
    totalParticipants: 8,
    paidPlaces: 3,
    ...overrides,
  };
}

// Only this user's PLACEMENT_CHANGED pushes: the cron also drives
// RACE_ENDING_SOON and the other participants' own placement moves, none of
// which this item touches.
function placementPushesFor(pushes, userId) {
  return pushes.filter(
    (p) =>
      p.deviceToken === `tok-${userId}` &&
      p.payload &&
      p.payload.type === "PLACEMENT_CHANGED"
  );
}

async function claimRows(raceId, userId) {
  return prisma.notification.findMany({
    where: { deliveryKey: `payout-drop:${raceId}:${userId}` },
  });
}

async function allNotifications(userId) {
  return prisma.notification.findMany({ where: { userId } });
}

describe("payout-drop push — time gate + durable once-per-race cap", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    delete process.env.PAYOUT_DROP_WINDOW_HOURS;
  });

  after(() => {
    delete process.env.PAYOUT_DROP_WINDOW_HOURS;
  });

  // ── The cron -> handler path, end to end ─────────────────────────────────

  // Four participants with fixed daily step rows so the live ranking is
  // deterministic; `subject` is baselined at 2nd and really ranks 3rd, i.e. it
  // crosses the TOP_HALF-of-4 = 2 paid places.
  async function seedDroppingRace({ endsAt }) {
    const race = await prisma.race.create({
      data: {
        name: "Daily",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        timezone: "UTC",
        fundedPrize: true,
        // TOP_HALF, like every seeded challenge — the DB default is
        // WINNER_TAKES_ALL, which would make paidPlaces 1.
        payoutPreset: "TOP_HALF",
        startedAt: new Date(Date.now() - 6 * HOUR_MS),
        endsAt,
      },
    });

    const users = [];
    const steps = [5000, 4000, 3000, 2000];
    for (let i = 0; i < steps.length; i++) {
      const userId = await makeUser();
      users.push(userId);
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId,
          status: "ACCEPTED",
          joinedAt: race.startedAt,
          totalSteps: steps[i],
          // Everyone is baselined where they already are except users[2], who
          // is told they were 2nd — the drop under test (TOP_HALF of 4 = 2
          // paid places, so 2nd -> 3rd leaves the money).
          lastNotifiedPlacement: i === 2 ? 2 : i + 1,
        },
      });
    }
    return { race, subject: users[2] };
  }

  // Production shape: enqueue-only (the race-keyed worker owns the writes), so
  // the persisted totals seeded above are what the job ranks on.
  async function runCron({ bus, settle }) {
    const recompute = buildRecomputePlacements({
      eventBus: bus,
      enqueueRaceResolution: async () => {},
      requestStepSyncForUsers: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });
    const result = await recompute();
    await settle();
    return result;
  }

  it("1: a drop with 17h left sends NO visible push (silent sync still goes)", async () => {
    const { race, subject } = await seedDroppingRace({
      endsAt: new Date(Date.now() + 17 * HOUR_MS),
    });
    const w = worker();
    const { alerts, silent } = w;

    await runCron(w);

    assert.equal(
      placementPushesFor(alerts, subject).length,
      0,
      "no payout-drop alert 17h before the end"
    );
    assert.equal(
      placementPushesFor(silent, subject).length,
      1,
      "the silent placement sync still fires"
    );
    assert.deepEqual(await claimRows(race.id, subject), [], "no claim burned");

    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: subject },
    });
    assert.equal(
      participant.lastNotifiedPlacement,
      3,
      "the baseline still advances on a suppressed alert"
    );
  });

  it("2: the same drop with 2h left sends the push and writes the claim row", async () => {
    const { race, subject } = await seedDroppingRace({
      endsAt: new Date(Date.now() + 2 * HOUR_MS),
    });
    const w = worker();
    const { alerts } = w;

    await runCron(w);

    const mine = placementPushesFor(alerts, subject);
    assert.equal(mine.length, 1, "inside the window the alert fires");
    assert.match(mine[0].body, /payout|prize/i);
    const claims = await claimRows(race.id, subject);
    assert.equal(claims.length, 1, "durable claim row written");
    assert.equal(claims[0].type, "PLACEMENT_CHANGED");
    assert.equal(claims[0].raceId, race.id);
  });

  it("5: a muted participant gets nothing at all inside the window", async () => {
    const { race, subject } = await seedDroppingRace({
      endsAt: new Date(Date.now() + 2 * HOUR_MS),
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: subject },
      data: { placementAlertsMuted: true },
    });
    const w = worker();
    const { alerts, silent } = w;

    await runCron(w);

    assert.equal(placementPushesFor(alerts, subject).length, 0);
    assert.equal(
      placementPushesFor(silent, subject).length,
      0,
      "muted means no silent refresh either"
    );
    assert.deepEqual(await claimRows(race.id, subject), []);
  });

  // ── Handler-level variants (real DB rows, injected push boundary) ─────────

  it("3: a second drop in the same race sends no second push (durable key)", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + HOUR_MS) });
    const first = worker();

    await first.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, { endsAt: race.endsAt })
    );
    assert.equal(first.alerts.length, 1);

    // The re-drop is processed by a SECOND registration — a fresh in-memory
    // cooldown Map — so the only thing that can suppress it is the durable
    // deliveryKey. Replaying it on the same worker would prove nothing but the
    // 10-minute Map.
    const second = worker();
    await second.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 4,
        placement: 3,
      })
    );
    await second.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, { endsAt: race.endsAt })
    );

    assert.equal(
      first.alerts.length + second.alerts.length,
      1,
      "at most one payout-drop push per user per race"
    );
    assert.equal((await claimRows(race.id, userId)).length, 1);
    assert.ok(
      second.silent.length >= 1,
      "the suppressed re-drop still syncs silently"
    );
  });

  it("4: the same user in a different race still gets their push", async () => {
    const userId = await makeUser();
    const raceA = await makeRace({ endsAt: new Date(Date.now() + HOUR_MS) });
    const raceB = await makeRace({
      endsAt: new Date(Date.now() + HOUR_MS),
      name: "Weekly",
    });
    const { bus, alerts } = worker();

    await bus.emit("PLACEMENT_CHANGED", dropChange(raceA.id, userId, { endsAt: raceA.endsAt }));
    await bus.emit("PLACEMENT_CHANGED", dropChange(raceB.id, userId, { endsAt: raceB.endsAt }));

    assert.equal(alerts.length, 2, "the cap is per race, not per user");
    assert.equal((await claimRows(raceA.id, userId)).length, 1);
    assert.equal((await claimRows(raceB.id, userId)).length, 1);
  });

  it("6: a payload with no endsAt at all behaves like a step-target race", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: null });
    const { bus, alerts } = worker();

    // No `endsAt` key (a legacy/absent emitter): the time gate is SKIPPED
    // rather than suppressing forever — see item 3's architect note.
    await bus.emit("PLACEMENT_CHANGED", dropChange(race.id, userId));

    assert.equal(alerts.length, 1);
    assert.equal((await claimRows(race.id, userId)).length, 1);
  });

  it("7: tookFirst/lostFirst still fire outside the window, even right after a suppressed drop", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + 17 * HOUR_MS) });
    const { bus, alerts } = worker();

    // Suppressed payout drop: must NOT stamp the shared 10-minute cooldown Map.
    await bus.emit("PLACEMENT_CHANGED", dropChange(race.id, userId, { endsAt: race.endsAt }));
    assert.equal(alerts.length, 0);

    await bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 2,
        placement: 1,
        paidPlaces: 3,
      })
    );
    assert.equal(alerts.length, 1, "taking 1st still alerts 17h out");
    assert.match(alerts[0].body, /1st/);
  });

  it("7b: losing 1st is unchanged by the gate", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + 17 * HOUR_MS) });
    const { bus, alerts } = worker();

    await bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 1,
        placement: 2,
        paidPlaces: 3,
      })
    );
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].body, /2nd/);
    assert.deepEqual(
      await claimRows(race.id, userId),
      [],
      "a lost-lead alert never burns the payout-drop claim"
    );
  });

  it("7c: a drop that loses 1st AND leaves the money still alerts outside the window", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + 17 * HOUR_MS) });
    const { bus, alerts } = worker();

    // 1st -> 4th of a top-3 payout is BOTH lostFirst and droppedOutOfPaid.
    // The payout-drop copy is gated, but the lost-lead alert this user gets
    // today must be unchanged, so it falls back to that copy.
    await bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 1,
        placement: 4,
        paidPlaces: 3,
      })
    );

    assert.equal(alerts.length, 1, "losing 1st still alerts");
    assert.match(alerts[0].body, /slipped/i, "lost-lead copy, not payout copy");
    assert.deepEqual(
      await claimRows(race.id, userId),
      [],
      "no payout-drop claim burned outside the window"
    );
  });

  it("7d: a spent payout-drop claim still lets a lost-lead alert through INSIDE the window", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + HOUR_MS) });

    // Burn the one payout-drop claim for this race.
    const first = worker();
    await first.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, { endsAt: race.endsAt })
    );
    assert.equal(first.alerts.length, 1);

    // Later the user is leading and falls out of the money: BOTH lostFirst and
    // droppedOutOfPaid. The payout copy is spent, but losing 1st is a promise
    // this item does not touch, so the alert downgrades rather than vanishing.
    const second = worker();
    await second.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 1,
        placement: 4,
        paidPlaces: 3,
      })
    );

    assert.equal(second.alerts.length, 1, "the lost-lead alert still fires");
    assert.equal(second.alerts[0].title, "You lost the lead");
    assert.match(second.alerts[0].body, /slipped/i);

    assert.equal(
      (await claimRows(race.id, userId)).length,
      1,
      "still exactly one payout-drop claim row"
    );
    const rows = await allNotifications(userId);
    assert.equal(rows.length, 2, "claim row + the downgraded alert's audit row");
    const audit = rows.filter((row) => row.deliveryKey == null);
    assert.equal(audit.length, 1, "the downgraded alert is audited normally");
    assert.equal(audit[0].title, "You lost the lead");
  });

  it("8: PAYOUT_DROP_WINDOW_HOURS=6 widens the gate", async () => {
    process.env.PAYOUT_DROP_WINDOW_HOURS = "6";
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + 5 * HOUR_MS) });
    const { bus, alerts } = worker();

    await bus.emit("PLACEMENT_CHANGED", dropChange(race.id, userId, { endsAt: race.endsAt }));

    assert.equal(alerts.length, 1, "5h out is inside a 6h window");
  });

  it("9: a step-target race (endsAt null) with a pot still pushes, once", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: null, potCoins: 500 });
    const first = worker();

    await first.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, { endsAt: null })
    );
    assert.equal(first.alerts.length, 1, "no endsAt to gate on — today's behavior kept");

    // Second registration = fresh cooldown Map, so the cap under test is the
    // durable key, not the in-memory one.
    const second = worker();
    await second.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: null,
        previousPlacement: 4,
        placement: 3,
      })
    );
    await second.bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, { endsAt: null })
    );
    assert.equal(
      first.alerts.length + second.alerts.length,
      1,
      "the once-per-race cap still applies"
    );
  });

  it("10: two cluster workers processing the same drop send exactly one push", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + HOUR_MS) });
    // Two independent registrations = two in-memory cooldown Maps, so only the
    // durable deliveryKey can stop the duplicate.
    const w1 = worker();
    const w2 = worker();

    const change = dropChange(race.id, userId, { endsAt: race.endsAt });
    await Promise.all([
      w1.bus.emit("PLACEMENT_CHANGED", change),
      w2.bus.emit("PLACEMENT_CHANGED", change),
    ]);

    assert.equal(
      w1.alerts.length + w2.alerts.length,
      1,
      "deliveryKey unique-insert prevents the duplicate"
    );
    assert.equal((await claimRows(race.id, userId)).length, 1, "one row");
  });

  it("11: a sent payout-drop writes exactly ONE notification row", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + HOUR_MS) });
    const { bus, alerts } = worker();

    await bus.emit("PLACEMENT_CHANGED", dropChange(race.id, userId, { endsAt: race.endsAt }));

    assert.equal(alerts.length, 1);
    const rows = await allNotifications(userId);
    assert.equal(rows.length, 1, "the claim row IS the audit row (no second write)");
    assert.equal(rows[0].deliveryKey, `payout-drop:${race.id}:${userId}`);
    assert.equal(rows[0].title, "Out of the payout");
    assert.ok(rows[0].body, "body persisted for the audit trail");
  });

  it("12: the real handler cooldown keeps a second visible move silent and audits only the alert", async () => {
    const userId = await makeUser();
    const race = await makeRace({ endsAt: new Date(Date.now() + 17 * HOUR_MS) });
    const { bus, alerts, silent } = worker();

    await bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 2,
        placement: 1,
        paidPlaces: 3,
      })
    );
    await bus.emit(
      "PLACEMENT_CHANGED",
      dropChange(race.id, userId, {
        endsAt: race.endsAt,
        previousPlacement: 1,
        placement: 2,
        paidPlaces: 3,
      })
    );

    assert.equal(alerts.length, 1, "first meaningful crossing is visible");
    assert.equal(silent.length, 1, "second meaningful crossing is cooldown-silent");
    const rows = await allNotifications(userId);
    assert.equal(rows.length, 1, "only the visible alert is audited");
    assert.equal(rows[0].title, "You're in the lead!");
  });
});
