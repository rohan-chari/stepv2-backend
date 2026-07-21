const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildAppSettings,
  KNOWN_FLAGS,
} = require("../../src/services/appSettings");

test("onboarding v2 is a remotely writable flag that defaults off when missing", async () => {
  const writes = [];
  const settings = buildAppSettings({
    prisma: {
      appSetting: {
        async findMany() { return []; },
        async upsert(args) { writes.push(args); },
      },
    },
    cacheTtlMs: 0,
  });
  assert.equal(KNOWN_FLAGS.onboardingV2Enabled, false);
  assert.equal(await settings.getFlag("onboardingV2Enabled"), false);
  await settings.setFlag("onboardingV2Enabled", true);
  assert.equal(writes[0].where.key, "onboardingV2Enabled");
  assert.equal(writes[0].update.value, true);
});
