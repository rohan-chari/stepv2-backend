const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionDeliveryIntents,
} = require("../../src/modules/races/services/raceResolutionDeliveryIntents");

test("claims high-multiplier recipients in input order with allowlisted token-free payloads", async () => {
  const queries = [];
  const service = buildRaceResolutionDeliveryIntents({
    secret: "test-secret",
    prisma: {
      async $transaction(callback) { return callback(this); },
      async $queryRawUnsafe(sql, candidates) {
        queries.push(sql);
        const parsed = JSON.parse(candidates);
        return [{ userId: parsed[1].userId }, { userId: parsed[0].userId }];
      },
    },
    User: { async findById() { return { displayName: "Alice" }; } },
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  const intents = await service.claimHighMultiplier({
    raceId: "r1", raceName: "Race", actorUserId: "actor", actorName: null,
    multiplier: 5, recipientUserIds: ["u2", "u1"], stealthed: false,
  }, { sourceGeneration: 7 });
  assert.deepEqual(intents.map((intent) => intent.recipientUserId), ["u2", "u1"]);
  assert.ok(intents.every((intent) => intent.kind === "STATE_NOTIFICATION"));
  assert.ok(intents.every((intent) => /^[a-f0-9]{64}$/.test(intent.deliveryKeyHash)));
  assert.ok(intents.every((intent) => !JSON.stringify(intent).includes("deviceToken")));
  assert.equal(queries.length, 2);
  assert.match(queries[0], /pg_advisory_xact_lock/);
});

test("atomically reserves step-sync cooldowns and emits only claimed users", async () => {
  const service = buildRaceResolutionDeliveryIntents({
    secret: "test-secret",
    prisma: {
      async $queryRawUnsafe(_sql, candidates) {
        const parsed = JSON.parse(candidates);
        return [{ userId: parsed[1].userId }];
      },
    },
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  const intents = await service.claimStepSync(["u2", "u1"], {
    raceId: "r1", sourceGeneration: 8, kind: "NUDGE",
  });
  assert.deepEqual(intents.map((intent) => intent.recipientUserId), ["u1"]);
  assert.equal(intents[0].payload.type, "STEP_SYNC_REQUEST");
  assert.ok(intents[0].cooldownClaimId);
});

test("delivery resolves current provider routes once without persisting device tokens", async () => {
  const sends = [];
  const service = buildRaceResolutionDeliveryIntents({
    secret: "test-secret",
    DeviceToken: {
      async findByUserId() { return [
        { token: "ios-token", platform: "ios" },
        { token: "android-token", platform: "android" },
      ]; },
      async deleteToken() {},
    },
    apnsService: {
      async sendSilentNotification(value) { sends.push(["apns", value]); return { success: true }; },
    },
    fcmService: {
      async sendSilentNotification(value) { sends.push(["fcm", value]); return { success: true }; },
    },
  });
  const outcome = await service.deliver({
    kind: "NUDGE", recipientUserId: "u1", payload: { type: "STEP_SYNC_REQUEST" },
  });
  assert.equal(outcome.accepted, true);
  assert.deepEqual(sends.map(([provider]) => provider), ["apns", "fcm"]);
});
