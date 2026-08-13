const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  buildStepSyncPushService,
} = require("../../src/shared/push/stepSyncPush");
const { buildApnsService } = require("../../src/shared/push/apns");
const {
  buildRecomputePlacements,
  fiveMinuteBucketKey,
} = require("../../src/modules/races/jobs/placementRecompute");

const APNS_TEST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJxvZaZJry+4tfXLYIaGxCOVyzSwgtkiHVygJzpkesWNoAoGCCqGSM49
AwEHoUQDQgAEumArrJiV1MGJHKH23upJrGqkaNiQb50NkqjtKv5bhQtPdTGAbnLv
1mjowQaVFRNaoKoF8KqI7+CfzAdJw2Hmqg==
-----END EC PRIVATE KEY-----`;

test("bulk step-sync uses one attemptedAt, bulk reads, exact deletes, and one monotonic stamp", async () => {
  const attemptedAt = new Date("2026-08-13T12:00:00.000Z");
  const calls = { users: 0, tokens: 0, deleted: null, stamped: null };
  const service = buildStepSyncPushService({
    now: () => attemptedAt,
    getPerformanceFlags: () => ({
      stepSyncBulkEnabled: true,
      stepSyncPushConcurrency: 2,
    }),
    User: {
      async findStepSyncCandidates(ids) {
        calls.users += 1;
        return ids.map((id) => ({
          id,
          lastStepSyncAt: null,
          lastSilentPushSentAt: null,
        }));
      },
      async updateLastSilentPushAttemptedAt(ids, at) {
        calls.stamped = { ids: [...ids].sort(), at };
      },
    },
    DeviceToken: {
      async findByUserIds() {
        calls.tokens += 1;
        return [
          { userId: "u1", token: "same", platform: "ios" },
          { userId: "u2", token: "same", platform: "android" },
        ];
      },
      async deleteTokensExact(pairs) { calls.deleted = pairs; },
    },
    apnsService: {
      async sendSilentNotification() { return { success: false, unregistered: true }; },
    },
    fcmService: {
      async sendSilentNotification() { return { success: true }; },
    },
    logger: { warn() {}, error() {} },
  });

  await service.requestStepSyncForUsers(["u1", "u2", "u1"]);
  assert.equal(calls.users, 1);
  assert.equal(calls.tokens, 1);
  assert.deepEqual(calls.deleted, [{ userId: "u1", token: "same" }]);
  assert.deepEqual(calls.stamped, { ids: ["u2"], at: attemptedAt });
});

test("bulk step-sync performance log preserves requested count before dedupe", async () => {
  const logs = [];
  const service = buildStepSyncPushService({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({ stepSyncBulkEnabled: true, stepSyncPushConcurrency: 2 }),
    User: {
      async findStepSyncCandidates(ids) {
        return ids.map((id) => ({ id, lastStepSyncAt: null, lastSilentPushSentAt: null }));
      },
      async updateLastSilentPushAttemptedAt() {},
    },
    DeviceToken: {
      async findByUserIds() { return []; },
      async deleteTokensExact() {},
    },
    logger: {
      log(message, fields) { logs.push({ message, fields }); },
      warn() {},
      error() {},
    },
  });

  await service.requestStepSyncForUsers(["u1", "u1", "u2", null]);
  const perf = logs.find((entry) => entry.message === "[PERF] step sync scheduling");
  assert.equal(perf.fields.requestedUsers, 4);
  assert.equal(perf.fields.uniqueUsers, 2);
  assert.equal(perf.fields.throttledUsers, 0);
  assert.equal(perf.fields.noTokenUsers, 2);
  assert.equal(perf.fields.eligibleUsers, 0);
  assert.equal(perf.fields.tokenAttempts, 0);
  assert.equal(typeof perf.fields.durationMs, "number");
});

test("bulk step-sync failure logs are aggregate and contain no user or token material", async () => {
  const logs = [];
  const logger = {
    log(message, fields) { logs.push(["log", message, fields]); },
    warn(message, fields) { logs.push(["warn", message, fields]); },
    error(message, fields) { logs.push(["error", message, fields]); },
  };
  const service = buildStepSyncPushService({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({
      stepSyncBulkEnabled: true,
      stepSyncPushConcurrency: 2,
    }),
    User: {
      async findStepSyncCandidates() {
        return [{ id: "sensitive-user-id", lastStepSyncAt: null, lastSilentPushSentAt: null }];
      },
      async updateLastSilentPushAttemptedAt() {},
    },
    DeviceToken: {
      async findByUserIds() {
        return [{ userId: "sensitive-user-id", token: "sensitive-device-token", platform: "ios" }];
      },
      async deleteTokensExact() {},
    },
    apnsService: {
      async sendSilentNotification() {
        return { success: false, statusCode: 503, reason: "ServiceUnavailable" };
      },
    },
    logger,
  });

  await service.requestStepSyncForUsers(["sensitive-user-id"]);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /sensitive-user-id/);
  assert.doesNotMatch(serialized, /sensitive-device-token/);
  assert.doesNotMatch(serialized, /deviceTokenSuffix|userId/);
  assert.match(serialized, /errorClass/);
});

test("bulk step-sync keeps reads constant and sends bounded at 750 recipients", async () => {
  const ids = Array.from({ length: 750 }, (_, index) => `u-${index}`);
  let userReads = 0;
  let tokenReads = 0;
  let active = 0;
  let maxActive = 0;
  let stamps;
  const service = buildStepSyncPushService({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({
      stepSyncBulkEnabled: true,
      stepSyncPushConcurrency: 7,
    }),
    User: {
      async findStepSyncCandidates(requested) {
        userReads += 1;
        return requested.map((id) => ({
          id,
          lastStepSyncAt: null,
          lastSilentPushSentAt: null,
        }));
      },
      async updateLastSilentPushAttemptedAt(successful) {
        stamps = successful;
      },
    },
    DeviceToken: {
      async findByUserIds(requested) {
        tokenReads += 1;
        return requested.map((userId) => ({
          userId,
          token: `token-${userId}`,
          platform: "ios",
        }));
      },
      async deleteTokensExact() {},
    },
    apnsService: {
      async sendSilentNotification() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { success: true };
      },
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  await service.requestStepSyncForUsers(ids);
  assert.equal(userReads, 1);
  assert.equal(tokenReads, 1);
  assert.equal(stamps.length, 750);
  assert.equal(maxActive, 7);
});

test("distributed placement loser returns before the active-race scan", async () => {
  let raceScans = 0;
  const now = new Date("2026-08-13T12:04:59.999Z");
  const run = buildRecomputePlacements({
    now: () => now,
    getPerformanceFlags: () => ({
      placementDistributedClaimEnabled: true,
      placementLeanBaselineWritesEnabled: false,
    }),
    JobRun: {
      async claimRun(name, key) {
        assert.equal(name, "placement-recompute-v2");
        assert.equal(key, "2026-08-13T12:00:00.000Z");
        return false;
      },
    },
    Race: { async findActiveInProgress() { raceScans += 1; return []; } },
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(await run(), []);
  assert.equal(raceScans, 0);
  assert.equal(fiveMinuteBucketKey(now), "2026-08-13T12:00:00.000Z");
});

test("placement completion emits structured phase timing and outcome counters", async () => {
  const logs = [];
  let tick = 0;
  const run = buildRecomputePlacements({
    monotonicNow: () => ++tick,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({
      placementDistributedClaimEnabled: true,
      placementLeanBaselineWritesEnabled: true,
      placementBaselineWriteConcurrency: 2,
    }),
    JobRun: { async claimRun() { return true; } },
    Race: { async findActiveInProgress() { return []; } },
    logger: {
      log(message, fields) { logs.push({ message, fields }); },
      warn() {},
      error() {},
    },
  });
  await run();
  const perf = logs.find((entry) => entry.message === "[PERF] placement recompute");
  assert.ok(perf);
  assert.equal(perf.fields.claimOutcome, "won");
  assert.equal(perf.fields.activeRaces, 0);
  assert.equal(perf.fields.participants, 0);
  assert.equal(perf.fields.baselineProposals, 0);
  assert.equal(perf.fields.baselineCasWins, 0);
  assert.equal(perf.fields.baselineCasLosses, 0);
  assert.equal(perf.fields.emittedEvents, 0);
  assert.equal(perf.fields.skippedInertEvents, 0);
  assert.equal(perf.fields.handlerDrainTracked, false);
  assert.equal(typeof perf.fields.phaseMs.claim, "number");
  assert.equal(typeof perf.fields.phaseMs.raceScan, "number");
  assert.equal(typeof perf.fields.phaseMs.total, "number");
});

test("reusable APNs mode coalesces connect and serves many streams", async () => {
  let connections = 0;
  let closes = 0;
  const authorizations = [];
  const connect = () => {
    connections += 1;
    const client = new EventEmitter();
    client.connecting = true;
    client.close = () => { closes += 1; };
    client.destroy = () => {};
    client.request = (headers) => {
      authorizations.push(headers.authorization);
      const request = new EventEmitter();
      request.end = () => process.nextTick(() => {
        request.emit("response", { ":status": 200 });
        request.emit("end");
      });
      return request;
    };
    process.nextTick(() => {
      client.connecting = false;
      client.emit("connect");
    });
    return client;
  };
  const service = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connect,
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });
  const results = await Promise.all([
    service.sendSilentNotification({ deviceToken: "one" }),
    service.sendSilentNotification({ deviceToken: "two" }),
  ]);
  assert.deepEqual(results, [{ success: true }, { success: true }]);
  assert.equal(connections, 1);
  assert.equal(authorizations.length, 2);
  assert.equal(authorizations[0], authorizations[1], "the cached JWT is reused");
  await service.close();
  await service.close();
  assert.equal(closes, 1);
});

test("reusable APNs mode evicts GOAWAY sessions and reconnects on the next send", async () => {
  const clients = [];
  const connect = () => {
    const client = new EventEmitter();
    client.connecting = true;
    client.close = () => {};
    client.destroy = () => {};
    client.request = () => {
      const request = new EventEmitter();
      request.end = () => process.nextTick(() => {
        request.emit("response", { ":status": 200 });
        request.emit("end");
      });
      return request;
    };
    clients.push(client);
    process.nextTick(() => {
      client.connecting = false;
      client.emit("connect");
    });
    return client;
  };
  const service = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connect,
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });

  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "first" }),
    { success: true }
  );
  clients[0].emit("goaway");
  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "second" }),
    { success: true }
  );
  assert.equal(clients.length, 2);
  await service.close();
});

test("reusable APNs mode bounds stalled connects and stalled requests", async () => {
  const neverConnects = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connectTimeoutMs: 10,
    connect() {
      const client = new EventEmitter();
      client.connecting = true;
      client.close = () => {};
      client.destroy = () => {};
      return client;
    },
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });
  assert.deepEqual(
    await neverConnects.sendSilentNotification({ deviceToken: "connect-timeout" }),
    { success: false, reason: "APNs connect timeout" }
  );

  let requestDestroyed = false;
  const stalledRequest = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    requestTimeoutMs: 10,
    connect() {
      const client = new EventEmitter();
      client.connecting = true;
      client.close = () => {};
      client.destroy = () => {};
      client.request = () => {
        const request = new EventEmitter();
        request.end = () => {};
        request.close = () => {};
        request.destroy = () => { requestDestroyed = true; };
        return request;
      };
      process.nextTick(() => {
        client.connecting = false;
        client.emit("connect");
      });
      return client;
    },
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });
  assert.deepEqual(
    await stalledRequest.sendSilentNotification({ deviceToken: "request-timeout" }),
    { success: false, reason: "APNs request timeout" }
  );
  assert.equal(requestDestroyed, true);
  await neverConnects.close();
  await stalledRequest.close();
});

test("reusable APNs mode retries BadDeviceToken on the fallback host", async () => {
  const hosts = [];
  const connect = (host) => {
    hosts.push(host);
    const client = new EventEmitter();
    client.connecting = true;
    client.close = () => {};
    client.destroy = () => {};
    client.request = () => {
      const request = new EventEmitter();
      request.end = () => process.nextTick(() => {
        const isPrimary = host.includes("sandbox");
        request.emit("response", { ":status": isPrimary ? 400 : 200 });
        if (isPrimary) request.emit("data", Buffer.from('{"reason":"BadDeviceToken"}'));
        request.emit("end");
      });
      return request;
    };
    process.nextTick(() => {
      client.connecting = false;
      client.emit("connect");
    });
    return client;
  };
  const service = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connect,
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });

  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "fallback" }),
    { success: true }
  );
  assert.equal(hosts.length, 2);
  assert.match(hosts[0], /sandbox/);
  assert.match(hosts[1], /api\.push\.apple\.com/);
  await service.close();
});

test("reusable APNs resolves each request once and evicts close/error sessions", async () => {
  const clients = [];
  const connect = () => {
    const client = new EventEmitter();
    client.connecting = true;
    client.close = () => {};
    client.destroy = () => {};
    client.request = () => {
      const request = new EventEmitter();
      request.end = () => process.nextTick(() => {
        request.emit("response", { ":status": 200 });
        request.emit("end");
        request.emit("error", new Error("late transport error"));
      });
      return request;
    };
    clients.push(client);
    process.nextTick(() => {
      client.connecting = false;
      client.emit("connect");
    });
    return client;
  };
  const service = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connect,
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });

  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "first" }),
    { success: true }
  );
  clients[0].emit("close");
  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "second" }),
    { success: true }
  );
  clients[1].emit("error", new Error("session failed"));
  assert.deepEqual(
    await service.sendSilentNotification({ deviceToken: "third" }),
    { success: true }
  );
  assert.equal(clients.length, 3);
  await service.close();
});

test("reusable APNs close settles pending connects and active streams", async () => {
  let activeRequest;
  const pendingConnectService = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    connectTimeoutMs: 30_000,
    connect() {
      const client = new EventEmitter();
      client.connecting = true;
      client.close = () => {};
      client.destroy = () => {};
      return client;
    },
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });
  const pending = pendingConnectService.sendSilentNotification({ deviceToken: "pending" });
  await new Promise((resolve) => setImmediate(resolve));
  await pendingConnectService.close();
  assert.deepEqual(await pending, {
    success: false,
    reason: "APNs service is closing",
  });

  const activeStreamService = buildApnsService({
    signingKey: APNS_TEST_KEY,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    requestTimeoutMs: 30_000,
    connect() {
      const client = new EventEmitter();
      client.connecting = true;
      client.close = () => {};
      client.destroy = () => {};
      client.request = () => {
        activeRequest = new EventEmitter();
        activeRequest.end = () => {};
        activeRequest.close = () => {};
        activeRequest.destroy = () => {};
        return activeRequest;
      };
      process.nextTick(() => {
        client.connecting = false;
        client.emit("connect");
      });
      return client;
    },
    getPerformanceFlags: () => ({ apnsSessionReuseEnabled: true }),
  });
  const active = activeStreamService.sendSilentNotification({ deviceToken: "active" });
  while (!activeRequest) await new Promise((resolve) => setImmediate(resolve));
  await activeStreamService.close();
  assert.deepEqual(await active, {
    success: false,
    reason: "APNs service is closing",
  });
});
