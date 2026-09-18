const assert = require("node:assert/strict");
const test = require("node:test");
const { registerNotificationHandlers } = require("../../src/modules/notifications/notificationHandlers");

function bus() {
  const handlers = new Map();
  return { on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); }, async emit(name, data) { for (const fn of handlers.get(name) || []) await fn(data); } };
}

async function sentBody(raceName) {
  const eventBus = bus(); let sent;
  registerNotificationHandlers({
    eventBus,
    Race: { async findUnique() { return { status: "ACTIVE", endsAt: new Date(Date.now() + 3600000), name: raceName }; } },
    User: { async findById() { return { displayName: "Nathan" }; } },
    DeviceToken: { async findByUserId() { return [{ token: "t", platform: "ios" }]; }, async deleteToken() {} },
    apnsService: { async sendNotification(args) { sent = args; return { success: true }; } },
    logger: { warn() {}, error() {} },
  });
  await eventBus.emit("POWERUP_USED", { raceId: "race-1", userId: "a", powerupType: "LEECH", targetUserId: "v" });
  return sent;
}

test("attack push appends a sanitized race name without changing its routing payload", async () => {
  const sent = await sentBody("  Summer\nSprint\u0007  ");
  assert.match(sent.body, /Race: Summer Sprint\./);
  assert.deepEqual(sent.payload, { type: "POWERUP_USED", route: "race_detail", params: { raceId: "race-1" } });
});

test("attack push preserves the legacy sentence when race name is absent", async () => {
  assert.equal((await sentBody(null)).body, "🩸 Nathan is leeching your steps! Keep moving.");
});
