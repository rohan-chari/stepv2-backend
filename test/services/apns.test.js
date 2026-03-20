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

function createHostAwareMockHttp2(responsesByHost = {}, seenHosts = []) {
  return function connect(host) {
    seenHosts.push(host);

    const client = new EventEmitter();
    client.close = () => {};

    client.request = () => {
      const req = new EventEmitter();
      req.end = () => {
        const response = responsesByHost[host] || {};
        const statusCode = response.statusCode ?? 200;
        const responseBody = response.responseBody || "";

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
  assert.equal(typeof service.sendSilentNotification, "function");
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

test("retries against production APNs when sandbox returns BadDeviceToken", async () => {
  const seenHosts = [];
  const service = buildTestService({
    production: false,
    connect: createHostAwareMockHttp2(
      {
        "https://api.sandbox.push.apple.com": {
          statusCode: 400,
          responseBody: JSON.stringify({ reason: "BadDeviceToken" }),
        },
        "https://api.push.apple.com": {
          statusCode: 200,
        },
      },
      seenHosts
    ),
  });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.deepEqual(seenHosts, [
    "https://api.sandbox.push.apple.com",
    "https://api.push.apple.com",
  ]);
  assert.deepEqual(result, { success: true });
});

test("does not mark BadDeviceToken as unregistered when both environments reject it", async () => {
  const service = buildTestService({
    production: false,
    connect: createHostAwareMockHttp2({
      "https://api.sandbox.push.apple.com": {
        statusCode: 400,
        responseBody: JSON.stringify({ reason: "BadDeviceToken" }),
      },
      "https://api.push.apple.com": {
        statusCode: 400,
        responseBody: JSON.stringify({ reason: "BadDeviceToken" }),
      },
    }),
  });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "BadDeviceToken");
  assert.equal(result.statusCode, 400);
  assert.equal(result.unregistered, false);
});

test("returns failure result when APNs signing key cannot be loaded", async () => {
  const service = buildApnsService({
    keyPath: "/tmp/definitely-missing-auth-key.p8",
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.test.app",
    production: false,
    connect: createMockHttp2(),
  });

  const result = await service.sendNotification({
    deviceToken: "abc123",
    title: "Test",
    body: "Test body",
  });

  assert.equal(result.success, false);
  assert.match(result.reason, /ENOENT|no such file/i);
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

test("constructs a silent background APNs payload with background headers", async () => {
  let capturedHeaders;
  let capturedPayload;

  const connect = () => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      capturedHeaders = headers;
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

  await service.sendSilentNotification({
    deviceToken: "abc123",
    payload: { type: "STEP_SYNC_REQUEST" },
  });

  assert.equal(capturedHeaders[":path"], "/3/device/abc123");
  assert.equal(capturedHeaders["apns-topic"], "com.test.app");
  assert.equal(capturedHeaders["apns-push-type"], "background");
  assert.equal(capturedHeaders["apns-priority"], "5");
  assert.deepEqual(capturedPayload, {
    aps: {
      "content-available": 1,
    },
    type: "STEP_SYNC_REQUEST",
  });
});
