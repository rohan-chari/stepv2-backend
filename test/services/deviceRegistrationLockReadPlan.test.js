const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDeviceRegistrationModel,
} = require("../../src/modules/notifications/models/deviceRegistration");

test("locked existing-device registration reads token and installation ownership once", async () => {
  const findManyCalls = [];
  const existing = {
    id: "device-1",
    userId: "user-1",
    token: "token-1",
    platform: "ios",
    installationId: "install-1",
    ownershipGeneration: 1,
    status: "ACTIVE",
  };
  const tx = {
    async $executeRawUnsafe() {},
    deviceToken: {
      async findMany(args) {
        findManyCalls.push(args);
        if (args.where.platform) return [existing];
        return [{ id: existing.id }];
      },
      async update({ data }) { return { ...existing, ...data }; },
      async create() { throw new Error("existing registration must update"); },
      async updateMany() { return { count: 0 }; },
    },
  };
  const prisma = {
    deviceToken: { async findFirst() { return null; } },
    async $transaction(run) { return run(tx); },
  };

  await buildDeviceRegistrationModel(prisma).register({
    userId: existing.userId,
    token: existing.token,
    platform: existing.platform,
    installationId: existing.installationId,
    providerEnvironment: "production",
    lifecycleEnabled: true,
  });

  const ownershipReads = findManyCalls.filter((call) => call.where.platform);
  assert.equal(ownershipReads.length, 2);
  assert.equal(findManyCalls.length, 3, "two ownership reads plus one cap read");
});
