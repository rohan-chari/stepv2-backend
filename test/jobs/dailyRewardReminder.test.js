const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDailyRewardReminder,
  claimSuppresses,
  zonesAtSlot,
} = require("../../src/modules/notifications/dailyRewardReminder");
const { getTimeZoneParts } = require("../../src/shared/time/week");

// A `now` at which America/New_York local time is 17:15 (EDT = UTC-4 in July).
const NY_1715 = new Date("2026-07-19T21:15:00Z");
// A `now` at which America/New_York local time is 17:45 (outside the 30m window).
const NY_1745 = new Date("2026-07-19T21:45:00Z");
// A `now` at which Asia/Kolkata (UTC+5:30) local time is 17:15.
const KOLKATA_1715 = new Date("2026-07-19T11:45:00Z");
// A `now` at which America/New_York local time is 21:15 (the 9pm slot).
const NY_2115 = new Date("2026-07-20T01:15:00Z");

// Build injected deps with in-memory stores that emulate the atomic guards.
function makeDeps({
  distinctZones = [],
  usersByZone = {},
  tokensByUser = {},
  now,
  disabled = false,
} = {}) {
  const state = {
    emitted: [],
    deliveryKeys: new Set(),
    jobRuns: new Map(), // jobName -> dayKey
    notifications: [],
  };
  const deps = {
    now: () => now,
    isDisabled: () => disabled,
    getTimeZoneParts,
    User: {
      async distinctTimezones() {
        return distinctZones;
      },
      async findRemindableInZones(zones, { includeNull = false } = {}) {
        const out = [];
        for (const z of zones) {
          for (const u of usersByZone[z] || []) out.push(u);
        }
        if (includeNull) {
          for (const u of usersByZone["__null__"] || []) out.push(u);
        }
        return out;
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        return tokensByUser[userId] || [];
      },
    },
    JobRun: {
      async claimRun(jobName, dayKey) {
        if (state.jobRuns.get(jobName) === dayKey) return false;
        state.jobRuns.set(jobName, dayKey);
        return true;
      },
    },
    Notification: {
      async create({ deliveryKey, ...rest }) {
        if (deliveryKey && state.deliveryKeys.has(deliveryKey)) {
          const err = new Error("unique violation");
          err.code = "P2002";
          throw err;
        }
        if (deliveryKey) state.deliveryKeys.add(deliveryKey);
        const row = { deliveryKey, ...rest };
        state.notifications.push(row);
        return row;
      },
    },
    eventBus: {
      emit(name, payload) {
        if (name === "DAILY_REWARD_REMINDER") state.emitted.push(payload);
      },
    },
    logger: { log() {}, error() {}, warn() {} },
  };
  return { deps, state };
}

const TOKEN = [{ token: "t1", platform: "ios" }];

test("zonesAtSlot selects a zone in [slot:00, slot:30) and rejects one at :45", () => {
  assert.deepEqual(
    zonesAtSlot(NY_1715, 17, ["America/New_York"], getTimeZoneParts),
    ["America/New_York"]
  );
  assert.deepEqual(
    zonesAtSlot(NY_1745, 17, ["America/New_York"], getTimeZoneParts),
    []
  );
});

test("claimSuppresses: same day and both adjacent days suppress; two-days-ago does not", () => {
  assert.equal(claimSuppresses("2026-07-19", "2026-07-19"), true);
  assert.equal(claimSuppresses("2026-07-18", "2026-07-19"), true);
  assert.equal(claimSuppresses("2026-07-20", "2026-07-19"), true);
  assert.equal(claimSuppresses("2026-07-17", "2026-07-19"), false);
  assert.equal(claimSuppresses(null, "2026-07-19"), false);
});

test("sends once at the 5pm slot for an unclaimed, enabled, tokened user", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
  });
  const emitted = await buildDailyRewardReminder(deps)();
  assert.equal(emitted.length, 1);
  assert.equal(state.emitted[0].userId, "u1");
  assert.equal(state.emitted[0].slot, 17);
  assert.ok(state.deliveryKeys.has("daily-reward:u1:2026-07-19:17"));
});

test("sends at the 9pm slot too", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_2115,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0].slot, 21);
  assert.ok(state.deliveryKeys.has("daily-reward:u1:2026-07-19:21"));
});

test("does NOT send when the box was already claimed today", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: "2026-07-19" }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 0);
});

test("does NOT send when the user has no device token", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: {},
    now: NY_1715,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 0);
  assert.equal(state.deliveryKeys.size, 0, "no claim row created for a tokenless user");
});

test("does NOT send outside the 30-minute catch-up window (17:45)", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1745,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 0);
});

test("a second run for the same slot does NOT re-send (durable deliveryKey dedup)", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
  });
  const run = buildDailyRewardReminder(deps);
  await run();
  // A second worker/tick at the same slot: the per-zone JobRun CAS returns false,
  // so no re-scan; even forcing a scan the deliveryKey unique-insert would block.
  const second = await run();
  assert.equal(second.length, 0);
  assert.equal(state.emitted.length, 1, "only one reminder total");
});

test("two concurrent workers cannot duplicate a reminder (deliveryKey race)", async () => {
  // Simulate two workers sharing the same stores but each getting past the JobRun
  // CAS (force claimRun to always allow, so only the deliveryKey guard protects).
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
  });
  deps.JobRun.claimRun = async () => true; // both "workers" win the zone claim
  const run = buildDailyRewardReminder(deps);
  await run();
  await run(); // second worker
  assert.equal(state.emitted.length, 1, "deliveryKey unique-insert prevents the duplicate");
});

test("non-hour-offset zone (Asia/Kolkata) resolves correctly", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["Asia/Kolkata"],
    usersByZone: { "Asia/Kolkata": [{ id: "u1", timezone: "Asia/Kolkata", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: KOLKATA_1715,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 1);
  assert.ok(state.deliveryKeys.has("daily-reward:u1:2026-07-19:17"));
});

test("null-timezone users fall back to America/New_York", async () => {
  const { deps, state } = makeDeps({
    distinctZones: [], // nobody has a real zone yet
    usersByZone: { __null__: [{ id: "u1", timezone: null, lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
  });
  await buildDailyRewardReminder(deps)();
  assert.equal(state.emitted.length, 1, "null-tz user reminded at NY local 5pm");
});

test("the kill switch suppresses everything", async () => {
  const { deps, state } = makeDeps({
    distinctZones: ["America/New_York"],
    usersByZone: { "America/New_York": [{ id: "u1", timezone: "America/New_York", lastDailyClaimDate: null }] },
    tokensByUser: { u1: TOKEN },
    now: NY_1715,
    disabled: true,
  });
  const emitted = await buildDailyRewardReminder(deps)();
  assert.equal(emitted.length, 0);
  assert.equal(state.emitted.length, 0);
});
