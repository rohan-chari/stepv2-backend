const test = require("node:test");
const assert = require("node:assert/strict");

const { createDeviceRegistrationReadBatch } = require("../../src/modules/notifications/services/deviceRegistrationReadBatch");

test("unchanged device registrations share bounded indexed reads", async () => {
  const calls = [];
  const prisma = { deviceToken: { async findMany(args) {
    calls.push(args);
    return args.where.OR.map((where, index) => ({
      id: `row-${index}`,
      userId: where.userId,
      token: where.token,
      platform: where.platform,
      installationId: where.installationId,
      providerEnvironment: where.providerEnvironment,
      adminMetricsOpenCapable: false,
      adminMetricsOpenEpochId: null,
    }));
  } } };
  const batch = createDeviceRegistrationReadBatch();
  const requests = Array.from({ length: 50 }, (_, index) => {
    const where = {
      userId: `user-${index}`, token: `token-${index}`, platform: "ios",
      installationId: `install-${index}`, providerEnvironment: "sandbox",
      lastRegisteredAt: { gte: new Date(0) }, OR: [{ status: "ACTIVE" }, { status: null }],
    };
    return batch.find({ prisma, where });
  });

  const rows = await Promise.all(requests);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.where.OR.length <= 32));
  assert.ok(rows.every((row, index) => row.userId === `user-${index}`));
});
