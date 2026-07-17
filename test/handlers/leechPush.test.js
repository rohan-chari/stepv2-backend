const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerNotificationHandlers,
} = require("../../src/handlers/notificationHandlers");

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

// Item 2: Leech is deliberately NOT stealthy — the victim gets an attack push
// naming the attacker, so their dropping steps never become a "why?" mystery.
test("POWERUP_USED pushes the victim for a LEECH (not stealthy)", async () => {
  const eventBus = createMockEventBus();
  let sent;

  registerNotificationHandlers({
    eventBus,
    Race: { async findUnique() { return { status: "ACTIVE", endsAt: new Date(Date.now() + 3_600_000) }; } },
    User: { async findById(id) { return { id, displayName: "Nathan" }; } },
    DeviceToken: {
      async findByUserId(userId) { assert.equal(userId, "victim-1"); return [{ token: "victim-token", platform: "ios" }]; },
      async deleteToken() {},
    },
    apnsService: { async sendNotification(args) { sent = args; return { success: true }; } },
    logger: { warn() {}, error() {} },
  });

  await eventBus.emit("POWERUP_USED", {
    raceId: "race-1",
    userId: "attacker-1",
    powerupType: "LEECH",
    targetUserId: "victim-1",
  });

  assert.ok(sent, "a leech pushes the victim");
  assert.equal(sent.title, "Powerup Attack!");
  assert.match(sent.body, /leeching your steps/i);
  assert.match(sent.body, /Nathan/);
  assert.deepEqual(sent.payload, { type: "POWERUP_USED", route: "race_detail", params: { raceId: "race-1" } });
});
