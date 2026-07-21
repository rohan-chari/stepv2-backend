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

function setup({ tokens = [{ token: "tok-ios", platform: "ios" }] } = {}) {
  const recorded = [];
  const eventBus = createMockEventBus();
  registerNotificationHandlers({
    eventBus,
    User: { async findById() { return { displayName: "Alice" }; } },
    DeviceToken: {
      async findByUserId() { return tokens; },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() { return { success: true }; },
      async sendSilentNotification() { return { success: true }; },
    },
    fcmService: {
      async sendNotification() { return { success: true }; },
      async sendSilentNotification() { return { success: true }; },
    },
    Notification: {
      async create(row) { recorded.push(row); return row; },
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  return { eventBus, recorded };
}

test("a visible PLACEMENT_CHANGED alert is recorded once with type + raceId", async () => {
  const { eventBus, recorded } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", {
    raceId: "r1", raceName: "Race 1", userId: "u1", previousPlacement: 1, placement: 2,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, "u1");
  assert.equal(recorded[0].type, "PLACEMENT_CHANGED");
  assert.equal(recorded[0].raceId, "r1");
  assert.match(recorded[0].body, /2nd/);
});

test("a SILENT placement refresh is NOT recorded", async () => {
  const { eventBus, recorded } = setup();
  // mid-pack one-spot slip, no payout cutoff -> silent only
  await eventBus.emit("PLACEMENT_CHANGED", {
    raceId: "r1", raceName: "Race 1", userId: "u1", previousPlacement: 5, placement: 6, paidPlaces: 0,
  });
  assert.equal(recorded.length, 0);
});

test("a lifecycle push via sendNotificationToUser is recorded with payload type", async () => {
  const { eventBus, recorded } = setup();
  await eventBus.emit("RACE_STARTED", { raceId: "r9", raceName: "Race 9", participantUserIds: ["u1"] });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "RACE_STARTED");
  assert.equal(recorded[0].userId, "u1");
  assert.equal(recorded[0].raceId, "r9");
});

test("DAILY_MOVER climb: sends a visible push and records it", async () => {
  const { eventBus, recorded } = setup();
  await eventBus.emit("DAILY_MOVER", {
    userId: "u1", raceId: "r1", raceName: "Race 1", movement: 6, placement: 3,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "DAILY_MOVER");
  assert.match(recorded[0].title, /climbing/i);
  assert.match(recorded[0].body, /moved up 6 spots/);
  assert.match(recorded[0].body, /3rd/);
});

test("DAILY_MOVER drop: copy reflects the downward move", async () => {
  const { eventBus, recorded } = setup();
  await eventBus.emit("DAILY_MOVER", {
    userId: "u1", raceId: "r1", raceName: "Race 1", movement: -5, placement: 8,
  });
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].body, /dropped 5 spots/);
  assert.match(recorded[0].body, /8th/);
});

test("DAILY_MOVER with no tokens records nothing and does not throw", async () => {
  const { eventBus, recorded } = setup({ tokens: [] });
  await eventBus.emit("DAILY_MOVER", {
    userId: "u1", raceId: "r1", raceName: "Race 1", movement: 6, placement: 3,
  });
  assert.equal(recorded.length, 0);
});
