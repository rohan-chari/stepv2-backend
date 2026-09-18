const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");

function createMockEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    async emit(event, data) {
      for (const fn of handlers.get(event) || []) await fn(data);
    },
  };
}

function harness(overrides = {}) {
  const state = { sent: null, recorded: [] };
  const eventBus = createMockEventBus();
  registerNotificationHandlers({
    eventBus,
    User: { async findById(id) { return { id, displayName: "Runner" }; } },
    DeviceToken: {
      async findByUserId() { return [{ token: "tok", platform: "ios" }]; },
      async deleteToken() {},
    },
    apnsService: { async sendNotification(args) { state.sent = args; return { success: true }; } },
    Notification: { async create(row) { state.recorded.push(row); return row; } },
    logger: { warn() {}, error() {} },
    ...overrides,
  });
  return { eventBus, state };
}

test("RACE_ENDING_SOON deep-links to the race and carries the §9.2 payload", async () => {
  const { eventBus, state } = harness();
  await eventBus.emit("RACE_ENDING_SOON", {
    raceId: "race-9",
    raceName: "Sunset Sprint",
    endsAt: new Date(Date.now() + 1.9 * 60 * 60 * 1000),
    userId: "u1",
  });
  assert.ok(state.sent, "a push is sent");
  assert.equal(state.sent.title, "Race ending soon");
  assert.match(state.sent.body, /Sunset Sprint/);
  assert.match(state.sent.body, /final push/i);
  assert.deepEqual(state.sent.payload, {
    type: "RACE_ENDING_SOON",
    route: "race_detail",
    params: { raceId: "race-9" },
  });
  // The handler records its own audit row (raceId set) — durable dedup key.
  assert.equal(state.recorded.length, 1);
  assert.equal(state.recorded[0].raceId, "race-9");
  assert.equal(state.recorded[0].type, "RACE_ENDING_SOON");
});

test("a scheduler-claimed race reminder sends without writing a second audit row", async () => {
  const { eventBus, state } = harness();
  await eventBus.emit("RACE_ENDING_SOON", {
    raceId: "race-claimed",
    raceName: "Claimed Race",
    endsAt: new Date(Date.now() + 60 * 60 * 1000),
    userId: "u1",
    notificationClaimed: true,
  });
  assert.ok(state.sent);
  assert.equal(state.recorded.length, 0);
});

test("a new handler suppresses an unclaimed old-cron event when another process won", async () => {
  const { eventBus, state } = harness({
    Notification: {
      async claimDelivery() {
        return false;
      },
      async create() {
        throw new Error("losing handler must not audit or send");
      },
    },
  });
  await eventBus.emit("RACE_ENDING_SOON", {
    raceId: "race-lost-claim",
    raceName: "Claimed Elsewhere",
    endsAt: new Date(Date.now() + 60 * 60 * 1000),
    userId: "u1",
  });
  assert.equal(state.sent, null);
});

test("DAILY_REWARD_REMINDER_17 carries the daily_reward payload and skips its own audit row", async () => {
  const { eventBus, state } = harness();
  await eventBus.emit("DAILY_REWARD_REMINDER", {
    userId: "u1",
    slot: 17,
    title: "Your daily box is waiting",
    body: "Your mystery box has been sitting here all day. Awkward.",
  });
  assert.ok(state.sent);
  assert.equal(state.sent.title, "Your daily box is waiting");
  assert.deepEqual(state.sent.payload, {
    type: "DAILY_REWARD_REMINDER_17",
    route: "daily_reward",
    params: {},
  });
  // skipAudit:true — the scheduler already wrote the deliveryKey audit row.
  assert.equal(state.recorded.length, 0);
});

test("DAILY_REWARD_REMINDER_21 uses the _21 type", async () => {
  const { eventBus, state } = harness();
  await eventBus.emit("DAILY_REWARD_REMINDER", { userId: "u1", slot: 21 });
  assert.equal(state.sent.payload.type, "DAILY_REWARD_REMINDER_21");
  assert.equal(state.sent.payload.route, "daily_reward");
});

test("DAILY_REWARD_REMINDER ignores an unexpected slot", async () => {
  const { eventBus, state } = harness();
  await eventBus.emit("DAILY_REWARD_REMINDER", { userId: "u1", slot: 8 });
  assert.equal(state.sent, null);
});
