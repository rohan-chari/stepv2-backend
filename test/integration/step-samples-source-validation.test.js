const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  disconnectDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");

describe("step sample source validation", () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("POST /steps/samples returns 400 for manual samples", async () => {
    const { token } = await createTestUser({ displayName: "Trail Walker" });

    const response = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: {
        samples: [
          {
            periodStart: "2026-04-09T14:28:00.000Z",
            periodEnd: "2026-04-09T14:28:00.000Z",
            steps: 10000,
            recordingMethod: "manual",
            sourceName: "Health",
            sourceId: "com.apple.Health",
          },
        ],
      },
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "manual step samples are not allowed");
    assert.equal(await prisma.stepSample.count(), 0);
  });

  it("POST /steps/samples persists source metadata for accepted samples", async () => {
    const { user, token } = await createTestUser({ displayName: "Trail Walker" });

    const response = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: {
        samples: [
          {
            periodStart: "2026-04-09T12:30:32.671Z",
            periodEnd: "2026-04-09T12:40:05.326Z",
            steps: 985,
            recordingMethod: "automatic",
            sourceName: "Apple Watch",
            sourceId: "com.apple.health.123",
            sourceDeviceId: "watch-device-1",
            deviceModel: "Watch7,5",
            metadata: {
              hkWasUserEntered: false,
            },
          },
        ],
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 1);

    const stored = await prisma.stepSample.findFirst({
      where: { userId: user.id },
    });

    assert.ok(stored);
    assert.equal(stored.recordingMethod, "automatic");
    assert.equal(stored.sourceName, "Apple Watch");
    assert.equal(stored.sourceId, "com.apple.health.123");
    assert.equal(stored.sourceDeviceId, "watch-device-1");
    assert.equal(stored.deviceModel, "Watch7,5");
    assert.deepEqual(stored.metadata, { hkWasUserEntered: false });
  });
});
