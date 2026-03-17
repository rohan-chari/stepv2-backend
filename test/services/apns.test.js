const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { buildApnsService } = require("../../src/services/apns");

function createMockHttp2(statusCode = 200, responseBody = "") {
  return function connect() {
    const client = new EventEmitter();
    client.close = () => {};

    client.request = () => {
      const req = new EventEmitter();
      req.end = (payload) => {
        req._payload = payload;

        process.nextTick(() => {
          req.emit("response", { ":status": statusCode });
          if (responseBody) {
            req.emit("data", Buffer.from(responseBody));
          }
          req.emit("end");
        });
      };
      return req;
    };

    return client;
  };
}

const testKey = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJxvZaZJry+4tfXLYIaGxCOVyzSwgtkiHVygJzpkesWNoAoGCCqGSM49
AwEHoUQDQgAEumArrJiV1MGJHKH23upJrGqkaNiQb50NkqjtKv5bhQtPdTGAbnLv
1mjowQaVFRNaoKoF8KqI7+CfzAdJw2Hmqg==
-----END EC PRIVATE KEY-----`;

function buildTestService(overrides = {}) {
  return buildApnsService({
    signingKey: testKey,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    production: false,
    connect: createMockHttp2(),
    ...overrides,
  });
}

test("returns object with sendNotification method", () => {
  const service = buildTestService();
  assert.equal(typeof service.sendNotification, "function");
});

test("constructs correct APNs payload", async () => {
  let capturedPayload;

  const connect = () => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = () => {
      const req = new EventEmitter();
      req.end = (payload) => {
        capturedPayload = JSON.parse(payload);
        process.nextTick(() => {
          req.emit("response", { ":status": 200 });
          req.emit("end");
        });
      };
      return req;
    };
    return client;
  };

  const service = buildTestService({ connect });

  await service.sendNotification({
    deviceToken: "abc123",
    title: "New Challenge",
    body: "Walker challenged you!",
    payload: { route: "challenge_detail", params: { instanceId: "inst-1" } },
  });

  assert.deepEqual(capturedPayload, {
    aps: {
      alert: { title: "New Challenge", body: "Walker challenged you!" },
      sound: "default",
    },
    route: "challenge_detail",
    params: { instanceId: "inst-1" },
  });
});

test("returns success on 200", async () => {
  const service = buildTestService({
    connect: createMockHttp2(200),
  });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.deepEqual(result, { success: true });
});

test("returns unregistered on 410", async () => {
  const service = buildTestService({
    connect: createMockHttp2(
      410,
      JSON.stringify({ reason: "Unregistered" })
    ),
  });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.equal(result.success, false);
  assert.equal(result.unregistered, true);
  assert.equal(result.statusCode, 410);
});

test("handles connection errors", async () => {
  const connect = () => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = () => {
      const req = new EventEmitter();
      req.end = () => {};
      return req;
    };

    process.nextTick(() => {
      client.emit("error", new Error("connection failed"));
    });

    return client;
  };

  const service = buildTestService({ connect });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "connection failed");
});
